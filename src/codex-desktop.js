// Resume through Desktop's existing owner, never through a second CLI writer.
// This local integration uses the same framed pipe API as codex-app-tools.
import { readdirSync } from 'node:fs';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const PIPE_ROOT = '\\\\.\\pipe\\';
const MAX_FRAME = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function isCodexDesktop(rec, platform = process.platform) {
  return platform === 'win32' && rec?.agent === 'codex' && UUID.test(rec.sessionId || '')
    && /^(?:codex[ _]?(?:work[ _]?)?desktop)$/i.test(rec.origin || '');
}

export function pipeRequest(pipe, method, params, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0), settled = false;
    const socket = net.createConnection(pipe);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Desktop pipe request timed out')), timeoutMs);
    socket.once('error', error => finish(error));
    socket.once('close', () => finish(new Error('Desktop pipe closed before acknowledging the request')));
    socket.once('connect', () => {
      const body = Buffer.from(JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }));
      if (body.length > MAX_FRAME) return finish(new Error('Desktop request too large'));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
    });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (length === 0 || length > MAX_FRAME) return finish(new Error('Invalid Desktop response frame'));
      if (buffer.length < length + 4) return;
      try {
        const response = JSON.parse(buffer.subarray(4, length + 4).toString('utf8'));
        if (response.id !== 1 || response.jsonrpc !== '2.0') throw new Error('Invalid Desktop response');
        if (response.error) throw new Error(response.error.message || 'Desktop request failed');
        if (!Object.hasOwn(response, 'result')) throw new Error('Missing Desktop response result');
        finish(null, response.result);
      } catch (error) { finish(error); }
    });
  });
}

function toolResult(result) {
  if (result?.success !== true) throw new Error('Desktop did not confirm the tool action');
  const text = result.contentItems?.find(item => item.type === 'inputText')?.text;
  try { return JSON.parse(text); }
  catch { throw new Error('Invalid Desktop tool result'); }
}

export function createDesktopClient({
  listPipes = () => readdirSync(PIPE_ROOT), request = pipeRequest,
} = {}) {
  let cachedPipe = null;
  async function discover() {
    if (cachedPipe) return cachedPipe;
    // Current Desktop separates app tools from browser tools. Retain the old
    // prefix for older Desktop versions and validate capabilities for both.
    const candidates = listPipes().filter(name => /^codex-(?:app-tools|browser-use)-[0-9a-f-]+$/i.test(name))
      .sort((a, b) => Number(b.startsWith('codex-app-tools-')) - Number(a.startsWith('codex-app-tools-')))
      .slice(0, 64);
    const matches = await Promise.all(candidates.map(async name => {
      const pipe = PIPE_ROOT + name;
      try {
        const catalog = await request(pipe, 'tools/list', { threadStartKind: 'all' }, { timeoutMs: 2_000 });
        const has = name => catalog?.tools?.some(tool => tool.name === name && tool.namespace === 'codex_app');
        return has('read_thread') && has('send_message_to_thread') ? pipe : null;
      } catch { return null; }
    }));
    const found = matches.filter(Boolean);
    if (found.length !== 1) throw new Error('A unique Codex Desktop app-tools endpoint is unavailable');
    cachedPipe = found[0];
    return cachedPipe;
  }
  async function call(rec, tool, args, { callId = randomUUID(), turnId = randomUUID() } = {}) {
    if (!UUID.test(rec?.sessionId || '')) throw new Error('Missing stable Codex thread ID');
    const pipe = await discover();
    let result;
    try {
      result = await request(pipe, 'tools/call', {
        arguments: args, callerSource: 'codex', callId, hostId: 'local',
        namespace: 'codex_app', threadId: rec.sessionId, tool, turnId,
      });
    } catch (error) {
      cachedPipe = null;
      // Never retry a possibly delivered send on another connection.
      throw error;
    }
    return toolResult(result);
  }
  return {
    endpoint: discover,
    async navigate(rec) {
      const result = await call(rec, 'navigate_to_codex_page', { threadId: rec.sessionId });
      if (result?.navigated !== true) throw new Error('Desktop did not confirm navigation');
    },
    async read(rec) {
      const result = await call(rec, 'read_thread', {
        threadId: rec.sessionId, hostId: 'local', turnLimit: 1,
        includeOutputs: false, maxOutputCharsPerItem: 1,
      });
      if (result?.thread?.id !== rec.sessionId || result.thread.kind !== 'codex'
        || result.thread.hostId !== 'local') throw new Error('Desktop returned a different thread or host');
      const turn = result.turns?.[0];
      // Conversation text is untrusted and is not used as an instruction.
      return {
        id: result.thread.id, title: result.thread.title, status: result.thread.status?.type,
        turn: turn ? {
          id: turn.id, status: turn.status, error: turn.error ?? null,
          startedAt: turn.startedAt == null ? null : turn.startedAt * 1000,
          completedAt: turn.completedAt == null ? null : turn.completedAt * 1000,
        } : null,
      };
    },
    async send(rec, message, { callId, turnId }) {
      const result = await call(rec, 'send_message_to_thread', {
        threadId: rec.sessionId, hostId: 'local', prompt: message,
        // Omit all overrides: Desktop retains its own current session settings,
        // including custom permission profiles that exec cannot represent.
      }, { callId, turnId });
      if (result?.threadId !== rec.sessionId) throw new Error('Desktop did not acknowledge the expected thread');
      return result;
    },
  };
}

export function desktopDecision(snapshot, cutoff) {
  const turn = snapshot?.turn;
  if (!turn?.id) return 'held';
  if (snapshot.status === 'active' || turn.status === 'inProgress') {
    return turn.startedAt > cutoff ? 'already-resumed' : 'busy';
  }
  // A completed task must not be restarted because an old rate-limit snapshot
  // is still in Unsnooze's ledger (observed with the LSĐ session).
  if (turn.status === 'completed' && !turn.error) return 'already-resumed';
  const error = JSON.stringify(turn.error || '');
  if (/usage[_ ]?limit[_ ]?(?:exceeded|reached)|hit your usage limit/i.test(error)
    && ['failed', 'completed'].includes(turn.status)) return 'wake';
  return 'held';
}

export const desktopClient = createDesktopClient();
