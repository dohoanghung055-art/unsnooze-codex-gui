// primeAt.<id> = auto: learn when the user starts work from their own local
// history, and prime LEAD_MS before it so the reset lands a couple of hours
// into the session.
//
// "Starts work" = the first human prompt of a day that follows IDLE_GAP_MS of
// no prompts — a window's worth of quiet. That gap rule is what keeps a late
// night running past midnight from reading as a 00:10 start. Only human
// prompts count: tool results, subagent turns, unsnooze's own resume messages
// and primes are activity unsnooze or the agent produced, and a 4am revival
// must not teach it that the user starts at 4am.
//
// Usage outside these agents' local history (claude.ai, the desktop app) is
// invisible here; a prime that finds the window already running says so.
//
// History is large (hundreds of MB of transcripts), so per-file results are
// cached by size+mtime in ACTIVITY_FILE and only changed files are re-read.

import { createReadStream, readdirSync, statSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { CLAUDE_DIR, CODEX_DIR, STATE_DIR, isPrimeDir, writePrivateFile, ensureStateDir } from './config.js';
import { resolveResumeMessage } from './settings.js';

export const LEARN_DAYS = 21;
export const MIN_DAYS = 5;
const IDLE_GAP_MS = 5 * 3_600_000;
export const LEAD_MS = 3 * 3_600_000;
const BUCKET_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

export const ACTIVITY_FILE = () => join(STATE_DIR, 'prime-activity.json');

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  if (content.some(b => b?.type === 'tool_result')) return null;
  const parts = content.filter(b => b?.type === 'text' || b?.type === 'input_text').map(b => b.text || '');
  return parts.length ? parts.join('\n') : null;
}

// Epoch ms of a human prompt on this line, else null.
export function promptTimestamp(agentId, line, { resumePrefix = '' } = {}) {
  if (agentId === 'claude' ? !line.includes('"type":"user"') : !line.includes('"role":"user"')) return null;
  let j;
  try { j = JSON.parse(line); } catch { return null; }
  let text;
  if (agentId === 'claude') {
    if (j.type !== 'user' || j.isSidechain || j.isMeta || j.isCompactSummary) return null;
    text = textOf(j.message?.content);
  } else {
    const p = j.payload;
    if (j.type !== 'response_item' || p?.type !== 'message' || p.role !== 'user') return null;
    text = textOf(p.content);
    // Codex injects <environment_context>, <user_instructions> and AGENTS.md
    // as user messages at every session start — revivals included.
    if (text != null && /^\s*(<[a-z_]+>|# AGENTS\.md)/i.test(text)) return null;
  }
  if (text == null) return null;
  if (resumePrefix && text.trimStart().startsWith(resumePrefix)) return null;
  const ts = Date.parse(j.timestamp);
  return Number.isFinite(ts) ? ts : null;
}

// Claude: projects/<dashed-cwd>/<session>.jsonl. Codex: sessions/YYYY/MM/DD/.
export function historyFiles(agentId, { since, claudeDir = CLAUDE_DIR, codexDir = CODEX_DIR } = {}) {
  const out = [];
  const ls = dir => { try { return readdirSync(dir); } catch { return []; } };
  const add = path => {
    try {
      const st = statSync(path);
      if (st.isFile() && st.mtimeMs >= since) out.push({ path, size: st.size, mtimeMs: st.mtimeMs });
    } catch { /* vanished */ }
  };
  if (agentId === 'claude') {
    const root = join(claudeDir, 'projects');
    for (const d of ls(root)) for (const f of ls(join(root, d))) if (f.endsWith('.jsonl')) add(join(root, d, f));
  } else {
    const root = join(codexDir, 'sessions');
    for (const y of ls(root)) for (const m of ls(join(root, y))) for (const d of ls(join(root, y, m))) {
      // Day dirs older than the window cannot hold anything newer than it.
      if (Date.parse(`${y}-${m}-${d}T00:00:00Z`) < since - DAY_MS) continue;
      for (const f of ls(join(root, y, m, d))) if (f.endsWith('.jsonl')) add(join(root, y, m, d, f));
    }
  }
  return out;
}

async function scanFile(agentId, path, resumePrefix) {
  const buckets = new Set();
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf-8' }), crlfDelay: Infinity });
  let first = true;
  for await (const line of rl) {
    if (first && agentId === 'codex') {
      first = false;
      // A prime's own rollout is not the user starting work.
      try { if (isPrimeDir(JSON.parse(line)?.payload?.cwd)) { rl.close(); return []; } } catch { /* no meta */ }
    }
    const ts = promptTimestamp(agentId, line, { resumePrefix });
    if (ts != null) buckets.add(Math.floor(ts / BUCKET_MS) * BUCKET_MS);
  }
  return [...buckets].sort((a, b) => a - b);
}

// Prompt timestamps (5-minute buckets) over the learning window.
export async function collectPrompts(agentId, {
  now = Date.now(), cacheFile = ACTIVITY_FILE(), files = null, scan = scanFile, ...dirs
} = {}) {
  const since = now - LEARN_DAYS * DAY_MS;
  const resumePrefix = resolveResumeMessage(agentId).trim().slice(0, 40);
  let cache = {};
  try { cache = JSON.parse(readFileSync(cacheFile, 'utf-8'))?.[agentId] || {}; } catch { /* first run */ }
  // Cached timestamps were filtered with the resume message of their day.
  if (cache.resumePrefix !== resumePrefix) cache = {};
  const cachedFiles = cache.files || {};
  const next = {};
  const all = [];
  for (const f of files || historyFiles(agentId, { since, ...dirs })) {
    const hit = cachedFiles[f.path];
    const ts = hit && hit.size === f.size && hit.mtimeMs === f.mtimeMs
      ? hit.ts
      : await scan(agentId, f.path, resumePrefix).catch(() => []);
    next[f.path] = { size: f.size, mtimeMs: f.mtimeMs, ts };
    for (const t of ts) if (t >= since) all.push(t);
  }
  try {
    let whole = {};
    try { whole = JSON.parse(readFileSync(cacheFile, 'utf-8')) || {}; } catch { /* fresh */ }
    whole[agentId] = { resumePrefix, files: next };
    ensureStateDir(dirname(cacheFile));
    writePrivateFile(cacheFile, `${cacheFile}.tmp.${process.pid}`, JSON.stringify(whole));
  } catch { /* cache is an optimisation */ }
  return all.sort((a, b) => a - b);
}

const minuteOfDay = ms => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };

// The usual start time (minutes after local midnight): for each day, the
// prompt after the longest quiet of at least IDLE_GAP_MS — the one after
// sleep, not a stray 00:30 prompt after an evening break — then the median.
// The earliest prompt on record is never a start: what came before it is
// unknown. null until MIN_DAYS days qualify.
export function learnStart(timestamps, { days = 'daily' } = {}) {
  const perDay = new Map();
  for (let i = 1; i < timestamps.length; i++) {
    const t = timestamps[i];
    const gap = t - timestamps[i - 1];
    if (gap < IDLE_GAP_MS) continue;
    const d = new Date(t);
    if (days === 'weekdays' && (d.getDay() === 0 || d.getDay() === 6)) continue;
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!perDay.has(key) || gap > perDay.get(key).gap) perDay.set(key, { gap, minutes: minuteOfDay(t) });
  }
  const mins = [...perDay.values()].map(v => v.minutes).sort((a, b) => a - b);
  if (mins.length < MIN_DAYS) return { minutes: null, days: mins.length };
  const mid = mins.length >> 1;
  const minutes = mins.length % 2 ? mins[mid] : Math.round((mins[mid - 1] + mins[mid]) / 2);
  return { minutes, days: mins.length };
}

export const hhmm = minutes => {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

// Learn and turn into a prime slot: { start, slot, wrap, days } or
// { slot: null, days }. wrap: the slot falls the evening before (start < 03:00).
export async function learnSlot(agentId, { days = 'daily', ...opts } = {}) {
  const learned = learnStart(await collectPrompts(agentId, opts), { days });
  if (learned.minutes == null) return { slot: null, start: null, days: learned.days };
  const slotMinutes = learned.minutes - LEAD_MS / 60_000;
  return { start: hhmm(learned.minutes), slot: hhmm(slotMinutes), wrap: slotMinutes < 0, days: learned.days };
}
