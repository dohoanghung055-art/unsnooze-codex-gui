#!/usr/bin/env node
// Starts the installed Unsnooze daemon for local Codex/Work sessions.
// No model calls, session-setting changes, or instructions on stdout.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

const stateDir = process.env.UNSNOOZE_STATE_DIR || path.join(os.homedir(), '.unsnooze');
function record(action, details = {}) {
  try {
    if (fs.existsSync(stateDir)) fs.appendFileSync(path.join(stateDir, 'session-start-hook.log'),
      JSON.stringify({ at: new Date().toISOString(), action, ...details }) + '\n', { mode: 0o600 });
  } catch { /* Logging must not prevent a session from starting. */ }
}

async function start(event) {
  if (process.platform !== 'win32' || event.hook_event_name !== 'SessionStart') return;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const root = process.argv[2] || path.join(appData, 'npm', 'node_modules', 'unsnooze');
  if (!fs.existsSync(path.join(root, 'package.json'))) return;
  const api = await import(pathToFileURL(path.join(root, 'src', 'spawn.js')).href);
  if (!api.onDemandWanted()) { record('disabled'); return; }
  const existing = api.runningDaemonPid();
  if (existing) { record('already-running', { pid: existing }); return; }
  const pid = api.ensureDaemon({
    spawner(args) {
      const fd = fs.openSync(path.join(stateDir, 'daemon.log'), 'a', 0o600);
      try {
        const child = spawn(process.execPath, [api.UNSNOOZE_BIN, ...args], {
          ...api.detachedSpawnOptions({ standalone: true, logFd: fd }),
          windowsHide: true,
        });
        child.once('error', error => record('spawn-error', { code: error.code || 'unknown' }));
        child.unref();
        return child.pid;
      } finally { fs.closeSync(fd); }
    },
  });
  record(pid ? 'started' : 'not-started', { ...(pid ? { pid } : {}) });
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { if (input.length < 65536) input += chunk; });
process.stdin.on('end', async () => {
  try { await start(JSON.parse(input || '{}')); }
  catch (error) {
    record('error', { message: error.message });
    process.stderr.write('[Unsnooze SessionStart] Could not ensure daemon; inspect ~/.unsnooze/session-start-hook.log.\n');
  }
  // A failed helper must never block the user's session.
});
