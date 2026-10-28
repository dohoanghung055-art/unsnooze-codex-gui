// OpenAI Codex CLI adapter.
//
// Codex has no hook that fires on usage limits (its `notify` config only emits
// agent-turn-complete), so detection is scrape-only. The TUI does NOT exit on
// a hard limit — it renders one red transcript line and sits at the composer:
//   ■ You've hit your usage limit. …{ or try again at 3:51 PM.}
// Reset-time tails vary by plan: "try again at 3:51 PM." (same day),
// "try again at Feb 23rd, 2026 9:01 PM." (cross-day), "Try again in 4 days
// 20 hours 9 minutes." (older builds), or "Try again later." (no timestamp).
// Transient errors render "stream error: … retrying 4/5 in 1.4s" and must take
// the overload path, never the ledger.

import { openSync, readSync, closeSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, win32, posix } from 'node:path';
import { CODEX_DIR } from '../config.js';
import { findOnPath } from '../which.js';
import { stripVTControlCharacters } from 'node:util';

// Since the 2026 unified ChatGPT desktop app absorbed the Codex app, the codex
// binary ships INSIDE the app bundle and many machines have no standalone
// `codex` on PATH at all — yet ~/.codex/sessions rollouts (and the resume
// command) work identically through the bundled binary (verified live against
// codex-cli 0.144 from ChatGPT.app).
export const CHATGPT_CODEX_BIN = '/Applications/ChatGPT.app/Contents/Resources/codex';

// Windows keeps the Desktop/Store install's CLI under a versioned runtime
// directory — %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe — whose name
// changes on every update. The interactive shell finds it through a PATH the
// app rewrote; a daemon started at logon keeps the PATH it was born with,
// which after an update names a directory that no longer exists (#25). So
// look the directory up at launch time and take the newest runtime, the way
// CHATGPT_CODEX_BIN covers the macOS bundle. Layout as reported by the
// issue's Microsoft Store install; a machine without it just gets null.
export function windowsBundledCodex({ env = process.env, readdir = readdirSync, stat = statSync } = {}) {
  if (!env.LOCALAPPDATA) return null;
  const base = join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  let entries;
  try { entries = readdir(base, { withFileTypes: true }); } catch { return null; }
  let best = null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const exe = join(base, e.name, 'codex.exe');
    let mtime;
    try { mtime = stat(exe).mtimeMs; } catch { continue; }
    if (!best || mtime > best.mtime) best = { exe, mtime };
  }
  return best ? best.exe : null;
}

// What to spawn for codex. Order, on Windows: an explicit UNSNOOZE_CODEX_BIN,
// a codex.exe on PATH (spawn resolves the bare name itself), the newest
// Desktop/Store runtime, then a .cmd/.bat shim on PATH by full path — Node
// refuses to spawn those without a shell, and a full path makes the launcher's
// error say which file it was. Elsewhere: PATH, then the macOS app bundle.
export function resolveCodexBin({
  env = process.env,
  platform = process.platform,
  exists = existsSync,
  onPath = null,
  bundled = () => windowsBundledCodex({ env }),
} = {}) {
  if (env.UNSNOOZE_CODEX_BIN) return env.UNSNOOZE_CODEX_BIN;
  if (platform === 'win32') {
    if (findOnPath(['codex.exe'], { env, exists, platform })) return 'codex';
    const runtime = bundled();
    if (runtime) return runtime;
    const shim = findOnPath(['codex.cmd', 'codex.bat'], { env, exists, platform });
    if (shim) return shim.path;
    return 'codex';
  }
  const found = onPath ? onPath() : !!findOnPath(['codex'], { env, exists, platform });
  if (found) return 'codex';
  if (exists(CHATGPT_CODEX_BIN)) return CHATGPT_CODEX_BIN;
  return 'codex';   // neither — the launcher degrades gracefully on spawn error
}

const LIMIT_ANCHORS = [
  /You['’]ve hit your usage limit/i,   // the desktop app also emits a curly apostrophe
  /Your workspace is out of credits/i,
  /hit your spend cap/i,
  // Plus plan: an out-of-credits picker sits under the banner and can push it
  // past the 12-line scan (#36). This line stays inside it and carries the time.
  /Your rate limit resets on/i,
];

export const patterns = {
  limitPatterns: LIMIT_ANCHORS,
  // The whole banner is ONE line, so the anchors double as reset lines — the
  // proximity engine then hands that line to time-parser (which falls back to
  // the 5h default for "Try again later."). A narrow pane soft-wraps that
  // line, which can strand the clock on a later row; bannerWraps tells the
  // engine to rejoin the rows before parsing.
  bannerWraps: true,
  resetPatterns: [
    /try again at/i,
    /try again in \d+/i,
    /try again later/i,
    ...LIMIT_ANCHORS,
  ],
  weeklyPatterns: [/weekly limit/i],
  fiveHourPatterns: [/5h limit/i],
  busyPatterns: [
    /esc to interrupt/i,           // "• Working (12s • esc to interrupt)"
    /retrying\s+\d+\/\d+/i,        // internal stream-error retry — don't inject
  ],
  idleRegex: /›/,                  // composer: "› Ask Codex to do anything"
  overloadPatterns: [/stream error/i, /exceeded retry limit/i],
  transientPatterns: [/stream error/i, /exceeded retry limit/i],
};

// A submitted user turn uses the same › glyph as the composer. Only accept
// the LAST prompt, followed directly by a blank line and Codex's status footer.
// ponytail: truncated/collapsed pastes cannot be proved; leave those for the user.
export function pendingCodexPrompt(text, message) {
  if (!message) return false;
  const lines = stripVTControlCharacters(text).split('\n');
  const start = lines.findLastIndex(line => /^\s*›/.test(line));
  if (start < 0) return false;
  const tail = lines.slice(start + 1);
  const footer = tail.findIndex((line, i) => i > 0 && !tail[i - 1].trim()
    && (/\s·\s/.test(line) || /(?:\d+% context left|\? for shortcuts)/.test(line)));
  if (footer < 0) return false;
  if (tail.slice(footer + 1).some(line => line.trim()
    && !/(?:\d+% context left|\? for shortcuts)/.test(line))) return false;
  // Ignore wrapping and the extra newline swallowed by paste-burst handling.
  const compact = value => value.replace(/\s/g, '');
  const draft = [lines[start].replace(/^\s*›\s?/, ''), ...tail.slice(0, footer)].join('\n');
  return compact(draft) === compact(message);
}

// Sessions live in ~/.codex/sessions/YYYY/MM/DD/rollout-{ts}-{THREAD}.jsonl;
// the first JSONL line carries the session cwd. Conservative: no cwd match →
// null (the resumer then uses `codex resume --last`, which codex itself scopes
// to the launch cwd).
//
// A reverted thread (the desktop app's edit/regenerate, `/undo`) continues in
// rollout-{ts}-{THREAD}_{ROLLOUT}.jsonl — codex-rs/rollout/src/rollout_file_name.rs:
// "filenames for reverted threads append an underscore and a distinct rollout
// ID after the stable thread ID". Group 1 is always the thread id, which is
// the id `codex resume` takes; the rollout id after the underscore is not.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const ROLLOUT_RE = new RegExp(`^rollout-.*-(${UUID})(?:_${UUID})?\\.jsonl$`, 'i');

// The thread uuid a rollout path names, or null for anything else. Cheaper than
// rolloutMeta() (no read) and the same id in every rollout seen so far. A
// reverted thread's `…_<rollout id>` file names the same thread, so usage
// readings compare across the two files of one conversation.
export function rolloutId(path) {
  if (typeof path !== 'string') return null;
  const m = basename(path).match(ROLLOUT_RE);
  return m ? m[1].toLowerCase() : null;
}

function fileHead(path, bytes = 4096) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf-8', 0, n);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function latestSessionId(cwd, aroundTs = null, sessionsRoot = join(CODEX_DIR, 'sessions')) {
  const files = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 3) { walk(p, depth + 1); continue; }
      const m = e.isFile() && e.name.match(ROLLOUT_RE);
      if (!m) continue;
      let mtime;
      try { mtime = statSync(p).mtimeMs; } catch { continue; }
      if (aroundTs != null && Math.abs(mtime - aroundTs) > 30 * 60_000) continue;
      files.push({ path: p, id: m[1], mtime });
    }
  };
  walk(sessionsRoot, 0);
  files.sort((a, b) => b.mtime - a.mtime);
  // JSON-escape the cwd the way it appears inside the meta line.
  const needle = cwd ? JSON.stringify(cwd).slice(1, -1) : null;
  for (const f of files.slice(0, 20)) {
    if (!needle || fileHead(f.path).includes(needle)) return f.id;
  }
  return null;
}

// The rollout file a thread is writing to now: the newest of its files. A
// reverted thread continues in a second `…_<rollout id>` file, which is where
// a resumed turn lands.
export function rolloutPathFor(sessionId, sessionsRoot = join(CODEX_DIR, 'sessions')) {
  if (!sessionId) return null;
  const want = String(sessionId).toLowerCase();
  let best = null;
  const walk = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 3) { walk(p, depth + 1); continue; }
      const m = e.isFile() && e.name.match(ROLLOUT_RE);
      if (!m || m[1].toLowerCase() !== want) continue;
      let mtime;
      try { mtime = statSync(p).mtimeMs; } catch { continue; }
      if (!best || mtime > best.mtime) best = { path: p, mtime };
    }
  };
  walk(sessionsRoot, 0);
  return best ? best.path : null;
}

// `session_meta` identifies the rollout but does not carry the settings used
// for a turn. Codex writes those in `turn_context`; exec resume starts with
// the current CLI defaults unless we pass them again. Read a bounded tail so
// large conversations do not need to be loaded into memory just to find the
// last context.
function latestTurnContext(path, maxBytes = 8 * 1024 * 1024) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = statSync(path).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    const n = readSync(fd, buf, 0, buf.length, start);
    if (n !== buf.length) return null;
    let lines = buf.toString('utf-8', 0, n).split('\n');
    if (start > 0) lines.shift(); // the first line may be truncated
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const row = JSON.parse(lines[i]);
        if (row?.type === 'turn_context' && row.payload && typeof row.payload === 'object') {
          return row.payload;
        }
      } catch { /* partial or non-JSON line */ }
    }
  } catch { /* missing, unreadable, or concurrently changing rollout */ }
  finally { if (fd !== undefined) closeSync(fd); }
  return null;
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);

function tomlString(value) { return JSON.stringify(value); }

// A legacy sandbox snapshot cannot describe arbitrary permission profiles.
// Accept only the standard profile that the snapshot describes; custom path
// restrictions must remain in Desktop instead of being silently broadened.
function standardPermissionProfile(context) {
  const profile = context.permission_profile;
  if (profile == null) return true; // older Codex rollouts only have sandbox_policy
  const sandbox = context.sandbox_policy;
  if (sandbox.type === 'danger-full-access') return profile.type === 'disabled' && Object.keys(profile).length === 1;
  if (profile.type !== 'managed' || profile.file_system?.type !== 'restricted') return false;
  if (Object.keys(profile).some(key => !['type', 'file_system', 'network'].includes(key))
    || Object.keys(profile.file_system).some(key => !['type', 'entries'].includes(key))) return false;
  const network = sandbox.type === 'workspace-write' && sandbox.network_access ? 'enabled' : 'restricted';
  if (profile.network !== network || !Array.isArray(profile.file_system.entries)) return false;
  const paths = /^[a-z]:[\\/]/i.test(context.cwd || '') ? win32 : posix;
  const norm = value => {
    if (typeof value !== 'string' || !paths.isAbsolute(value)) return null;
    const result = paths.normalize(value).replace(/[\\/]$/, '');
    return paths === win32 ? result.toLowerCase() : result;
  };
  const roots = sandbox.type === 'workspace-write'
    ? [context.cwd, ...sandbox.writable_roots].map(norm) : [];
  if (roots.some(root => !root)) return false;
  const expected = new Set(['read:special:root']);
  for (const root of roots) {
    expected.add(`write:path:${root}`);
    for (const name of ['.git', '.agents', '.codex', '.aws']) {
      expected.add(`read:path:${norm(paths.join(root, name))}`);
    }
  }
  if (sandbox.type === 'workspace-write') {
    if (!sandbox.exclude_slash_tmp) expected.add('write:special:slash_tmp');
    if (!sandbox.exclude_tmpdir_env_var) expected.add('write:special:tmpdir');
  }
  const actual = new Set();
  for (const entry of profile.file_system.entries) {
    if (Object.keys(entry || {}).some(key => !['path', 'access', 'missing_path_behavior'].includes(key))) return false;
    const p = entry?.path;
    if (!['read', 'write'].includes(entry?.access)) return false;
    if (p?.type === 'path') {
      const value = norm(p.path);
      if (!value) return false;
      actual.add(`${entry.access}:path:${value}`);
    } else if (p?.type === 'special' && typeof p.value?.kind === 'string') {
      actual.add(`${entry.access}:special:${p.value.kind}`);
    } else return false;
  }
  return actual.size === expected.size && [...actual].every(entry => expected.has(entry));
}

function codexResumeSettings(sessionId, sessionsRoot, canType) {
  const path = rolloutPathFor(sessionId, sessionsRoot);
  const context = path ? latestTurnContext(path) : null;
  const blocked = reason => ({ blockedReason: `Cannot preserve Codex session settings: ${reason}. Continue in Codex Desktop.` });
  if (!context) return blocked('no readable turn_context for this session');
  if (typeof context.model !== 'string' || !MODEL_RE.test(context.model)) return blocked('missing or invalid model');
  const absolute = value => typeof value === 'string' && (win32.isAbsolute(value) || posix.isAbsolute(value));
  if (!absolute(context.cwd)) return blocked('missing absolute session cwd');
  const effort = context.effort ?? context.collaboration_mode?.settings?.reasoning_effort;
  if (!REASONING_EFFORTS.has(effort)) return blocked('missing or unsupported reasoning effort');
  const sandbox = context.sandbox_policy;
  if (!SANDBOX_MODES.has(sandbox?.type)) return blocked('unsupported sandbox policy');
  const approval = context.approval_policy;
  if (!['never', 'on-request'].includes(approval)) return blocked('unsupported approval policy');
  const reviewer = context.approvals_reviewer ?? 'user';
  if (!['user', 'auto_review'].includes(reviewer)) return blocked('unsupported approval reviewer');
  // codex exec hard-codes Never (and AutoReview can rebuild it as OnRequest).
  // A -c approval_policy override cannot preserve interactive approvals there.
  if (!canType && (approval !== 'never' || reviewer !== 'user')) {
    return blocked('exec resume cannot preserve interactive approvals');
  }
  const args = ['-m', context.model, '--sandbox', sandbox.type,
    '-C', context.cwd,
    '-c', `model_reasoning_effort=${tomlString(effort)}`,
    '-c', `approval_policy=${tomlString(approval)}`,
    '-c', `approvals_reviewer=${tomlString(reviewer)}`];
  if (sandbox.type === 'workspace-write') {
    const fields = ['network_access', 'exclude_tmpdir_env_var', 'exclude_slash_tmp'];
    if (Object.keys(sandbox).some(key => !['type', 'writable_roots', ...fields].includes(key))) {
      return blocked('workspace-write policy contains additional restrictions');
    }
    if (!Array.isArray(sandbox.writable_roots) || sandbox.writable_roots.some(root => !absolute(root))
      || fields.some(key => typeof sandbox[key] !== 'boolean')) return blocked('incomplete workspace-write policy');
    // Override the entire table, including empty roots and false values, so
    // broader writable roots/network settings in config.toml cannot leak in.
    const table = [`writable_roots=${JSON.stringify(sandbox.writable_roots)}`,
      ...fields.map(key => `${key}=${sandbox[key]}`)].join(',');
    args.push('-c', `sandbox_workspace_write={${table}}`);
  } else if (Object.keys(sandbox).some(key => key !== 'type')) {
    return blocked('sandbox policy contains additional restrictions');
  }
  if (!standardPermissionProfile(context)) return blocked('custom permission profile is not representable by CLI sandbox flags');
  return { args };
}

export default {
  id: 'codex',
  name: 'OpenAI Codex CLI',
  bin: resolveCodexBin(),
  experimental: false,
  patterns,
  menu: null,                      // no interactive limit menu
  // What to do about a workspace wall (credits depleted, a spend cap): no
  // window reset clears it, so the resumer's ceiling notification names this.
  // Not `unsnooze resume-now`: the hold leaves the record failed, and
  // resume-now only wakes stopped ones — it would answer "no matching stopped
  // sessions" to the one command the notification told the user to run.
  modelRemedy: 'add credits or raise the spend cap in the ChatGPT workspace (or ask its owner to), then continue the session in Codex',
  // Resume takes the prompt in argv — `codex resume <id> "msg"` starts the turn
  // immediately, nothing to type into the TUI.
  //
  // canType: false (headless — no pane): the TUI cannot run there at all. It
  // refuses a non-TTY stdin before it looks at the session ("Error: stdin is
  // not a terminal", exit 1 — reproduced against codex-cli 0.150 with the
  // headless backend's exact stdio), so `codex exec resume <id> "msg"` carries
  // the same conversation forward non-interactively instead (#25). With
  // --last, codex reads a lone positional as the prompt, not a session id.
  //
  // `exec` also refuses any directory that is not a git repository unless
  // told --skip-git-repo-check ("Not inside a trusted directory…", exit 1),
  // a guard the TUI never had: without the flag, a session that ran in a
  // plain folder could never be revived headless. It is the user's own
  // session, resumed where it already ran, so the flag goes on.
  //
  // extraArgsAt: resumeExtraArgs go right after `exec`, not at the end. The
  // `resume` subcommand rejects -s/--sandbox, -p/--profile and --add-dir
  // ("unexpected argument", exit 2) — exactly what a user sets to match
  // their normal launch — while `exec` takes them. (TUI-only flags such as
  // -a or --search have no exec equivalent and still fail, visibly.)
  resumeArgs(sessionId, message, { canType = true, sessionsRoot, extraArgs = [] } = {}) {
    const tail = sessionId ? [sessionId, message] : ['--last', message];
    const settings = codexResumeSettings(sessionId, sessionsRoot, canType);
    if (extraArgs.length) settings.blockedReason = 'Cannot preserve Codex session settings while launchExtraArgs.codex or resumeExtraArgs.codex are configured. Clear those shared flags first.';
    if (settings.blockedReason) return { args: [], messageViaPane: false, blockedReason: settings.blockedReason };
    if (canType) return {
      args: ['resume', ...settings.args, ...tail],
      messageViaPane: false,
      extraArgsAt: 1,
    };
    return {
      args: ['exec', ...settings.args, '--skip-git-repo-check', 'resume', ...tail],
      messageViaPane: false,
      extraArgsAt: 1,
    };
  },
  // v1: every agent launches the bare TUI and gets the prompt typed once idle.
  launchArgs(message) { return { args: [], messageViaPane: true }; },
  latestSessionId,
  isForegroundCommand(cmd) {
    return cmd === 'codex' || cmd === 'node' || cmd === 'unsnooze';
  },
};
