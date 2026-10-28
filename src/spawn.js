// Detached-process helpers shared by launcher, hook, and monitor.

import { spawn } from 'node:child_process';
import {
  existsSync, readFileSync, unlinkSync, writeFileSync, statSync, utimesSync, openSync, closeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { RESUMER_LOCK, DAEMON_ON_DEMAND, DAEMON_PIDFILE, STATE_DIR, ensureStateDir } from './config.js';
import { makeLogger } from './logger.js';

const log = makeLogger('spawn');

export const UNSNOOZE_BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'unsnooze.js');

// Variables that describe one agent session rather than the user. Claude Code
// sets the first group for every command and hook it runs, and CLAUDECODE is
// its nested-session guard: a claude started with it set refuses to run
// ("cannot be launched inside another Claude Code session"). The launcher sets
// the second group for the agent it wraps. A process that outlives the session
// that started it must carry neither, because every revival it launches
// inherits its environment. User configuration — CLAUDE_CONFIG_DIR,
// CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_GIT_BASH_PATH, TMUX — is kept.
const SESSION_ENV = new Set([
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_PROJECT_DIR', 'CLAUDE_ENV_FILE',
  'UNSNOOZE_ACTIVE', 'UNSNOOZE_MUX', 'UNSNOOZE_PANE', 'UNSNOOZE_PANE_OWNER', 'UNSNOOZE_LEASE_ID',
  'UNSNOOZE_CWD',
]);

// Windows environment names are case-insensitive, and a copied process.env
// keeps whatever case the variable was set with.
export function standaloneEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!SESSION_ENV.has(key.toUpperCase())) out[key] = value;
  }
  return out;
}

// spawnDetached's options, apart so they can be tested without a child.
// `standalone` is for processes that outlive the session that started them —
// the daemon and a transient resumer: no session markers, and the home
// directory rather than the project the session happened to be in (on Windows
// a live process's working directory cannot be deleted or renamed, so a
// daemon started from a project would pin that folder until sign-out).
export function detachedSpawnOptions({ env = {}, standalone = false, logFd = null } = {}) {
  return {
    detached: true,
    stdio: logFd == null ? 'ignore' : ['ignore', logFd, logFd],
    env: { ...(standalone ? standaloneEnv() : process.env), ...env },
    ...(standalone ? { cwd: homedir() } : {}),
  };
}

// `logFile` appends the child's stdout/stderr to a file instead of discarding
// them: a daemon with no supervisor to capture its output would otherwise leave
// no trace of a crash.
export function spawnDetached(args, env = {}, { standalone = false, logFile = null, execPath = process.execPath } = {}) {
  let logFd = null;
  if (logFile) {
    try { logFd = openSync(logFile, 'a', 0o600); } catch { /* no log, not no child */ }
  }
  let child;
  try {
    child = spawn(execPath, [UNSNOOZE_BIN, ...args], detachedSpawnOptions({ env, standalone, logFd }));
  } finally {
    // The child has its own copy of the descriptor.
    if (logFd != null) { try { closeSync(logFd); } catch { /* already closed */ } }
  }
  // spawn() reports ENOENT, EACCES, EAGAIN and EMFILE as an 'error' event after
  // it has returned. Unheard, that is an uncaught exception in the caller —
  // the launcher, with the user's agent already running.
  child.on('error', err => log(`could not start ${args[0]}: ${err.message}`));
  child.unref();
  return child.pid;
}

// The one definition of how a per-pane monitor is launched. The launcher uses
// it to start one; a version-skewed monitor uses it to hand off to its own
// replacement. Keeping a single builder is what stops the two from drifting —
// a mismatched respawn would silently watch the wrong pane or, with a null
// hole in the argv, throw inside child_process and take the watcher with it.
export function monitorSpawnArgs({ muxName, paneOwner, pane, agentId, leaseId }) {
  return ['_monitor', muxName, paneOwner || '', pane, agentId, leaseId || ''];
}

// Signal 0 probes for existence without delivering anything. Shared: the
// resumer's lock hygiene, the dashboard's liveness column, and the version-skew
// hand-off all need the same answer.
export function pidAlive(pid) {
  // Reject 0 before probing: kill(0, 0) targets our OWN process group and
  // succeeds, so a garbage lock file holding "0" would read as a live holder
  // forever. Number.isFinite alone does not catch it.
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Spawn the resumer daemon unless one is already running (pidfile check).
// The resumer itself re-checks under its own lock; this is just to avoid
// pointless spawns.
export function spawnResumerIfNeeded() {
  try {
    if (existsSync(RESUMER_LOCK)) {
      const pid = parseInt(readFileSync(RESUMER_LOCK, 'utf-8'), 10);
      if (Number.isFinite(pid) && pidAlive(pid)) return null;
    }
  } catch { /* unreadable lock — let the daemon sort it out */ }
  // Standalone: it is spawned from inside a session (the hook, a pane's
  // monitor) and outlives it, and a headless revival inherits its environment.
  const pid = spawnDetached(['_resumer'], {}, { standalone: true });
  log(`spawned resumer pid ${pid}`);
  return pid;
}

// Stop a running resumer (if any): SIGTERM the lock pid, unlink the lock.
// Tolerates a dead/stale pid and a missing lock — uninstall must not fail.
export function stopResumer() {
  let pid = null;
  try {
    if (!existsSync(RESUMER_LOCK)) return { stopped: false, pid: null, reason: 'no-lock' };
    pid = parseInt(readFileSync(RESUMER_LOCK, 'utf-8'), 10);
    // A stale lock can name a recycled pid — this very process included.
    if (Number.isFinite(pid) && pid !== process.pid && pidAlive(pid)) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* raced with exit */ }
      log(`stopped resumer pid ${pid}`);
      try { unlinkSync(RESUMER_LOCK); } catch { /* gone */ }
      return { stopped: true, pid };
    }
    // Stale lock: clean up.
    try { unlinkSync(RESUMER_LOCK); } catch { /* gone */ }
    return { stopped: false, pid: Number.isFinite(pid) ? pid : null, reason: 'stale' };
  } catch (err) {
    try { unlinkSync(RESUMER_LOCK); } catch { /* best-effort */ }
    return { stopped: false, pid, reason: err.message };
  }
}

// --- the on-demand daemon (native Windows) ----------------------------------
// launchd and systemd keep the daemon alive on macOS and Linux. Windows gets no
// equivalent, on purpose — see DAEMON_ON_DEMAND in config.js — so there the
// daemon is an ordinary background process that the wrappers and the
// StopFailure hook start whenever it is not running.

// How often a running daemon refreshes its pidfile, and how old the refresh may
// be before the file stops counting as proof of life. Five missed beats, so a
// busy moment is never mistaken for death. A machine waking from a long sleep
// can briefly look daemon-less; the worst that does is start a second daemon,
// which the first yields to on its next beat (claimDaemon).
export const DAEMON_HEARTBEAT_MS = 60_000;
export const DAEMON_STALE_MS = 5 * DAEMON_HEARTBEAT_MS;

function readPidfile(path) {
  try { return parseInt(readFileSync(path, 'utf-8'), 10); } catch { return NaN; }
}

// The pid of the daemon that is demonstrably running, else null. A live pid
// alone proves nothing on Windows: pids are recycled quickly, and a sign-out or
// a crash leaves the file behind to name whichever process gets that pid next.
// The daemon touches the file every minute, so a stale one is ignored whoever
// its pid belongs to now.
export function runningDaemonPid({ path = DAEMON_PIDFILE, now = Date.now(), alive = pidAlive } = {}) {
  const pid = readPidfile(path);
  if (!alive(pid)) return null;
  try {
    return now - statSync(path).mtimeMs <= DAEMON_STALE_MS ? pid : null;
  } catch {
    return null;   // vanished between the read and the stat
  }
}

// `wx` creates the file a moment before the claimant's pid is written into it.
// A file that young with no pid yet is somebody mid-claim, not a leftover.
const CLAIM_GRACE_MS = 2_000;

function midClaim(path, now = Date.now()) {
  try {
    return readFileSync(path, 'utf-8').trim() === '' && now - statSync(path).mtimeMs < CLAIM_GRACE_MS;
  } catch {
    return false;
  }
}

// The daemon's half of the pidfile. Starters race — a wrapper and the hook can
// both find no daemon and both start one — so each new daemon claims the file,
// and a daemon that finds a live one already there stands down before doing
// anything. `wx` like the resumer lock; a stale file is replaced. Returns a
// release() for shutdown, or null when this daemon must not run.
//
// While held, the heartbeat keeps the claim fresh, and calls onLost() — the
// daemon should exit — once the file names another pid (this daemon looked
// dead through a long sleep and a newer one took over, or two claims raced:
// one daemon, whichever claimed last), once the file has been missing on two
// beats in a row (one unreadable moment, say an antivirus scan, is not proof),
// or once wanted() says the daemon is no longer asked for.
export function claimDaemon({
  path = DAEMON_PIDFILE, pid = process.pid, running = runningDaemonPid,
  heartbeatMs = DAEMON_HEARTBEAT_MS, onLost = () => {}, wanted = () => true,
  lock = RESUMER_LOCK,
} = {}) {
  ensureStateDir(dirname(path));
  let claimed = false;
  for (let attempt = 0; attempt < 2 && !claimed; attempt++) {
    try {
      writeFileSync(path, String(pid), { flag: 'wx', mode: 0o600 });
      claimed = true;
    } catch {
      const previous = readPidfile(path);
      const holder = running({ path });
      if (holder === pid) claimed = true;
      else if (holder) {
        log(`daemon pid ${holder} is already running — pid ${pid} not starting another`);
        return null;
      } else if (midClaim(path)) {
        log(`another daemon is claiming ${path} — pid ${pid} not starting another`);
        return null;
      } else {
        // The previous daemon is gone: dead, or its pid now someone else's.
        // TerminateProcess and sign-out skip its cleanup, so the resumer lock
        // it held still names that pid — and on Windows, where the holder
        // cannot be checked with ps, a recycled pid there would be honored
        // forever and no resume would ever run again.
        if (Number.isFinite(previous) && readPidfile(path) === previous && readPidfile(lock) === previous) {
          try { unlinkSync(lock); } catch { /* released meanwhile */ }
          log(`cleared the resumer lock left by daemon pid ${previous}`);
        }
        try { unlinkSync(path); } catch { /* raced with another claimant */ }
      }
    }
  }
  if (!claimed) {
    log(`could not claim ${path} — pid ${pid} not starting`);
    return null;
  }
  let misses = 0;
  const beat = setInterval(() => {
    const named = readPidfile(path);
    let why = null;
    if (!wanted()) why = 'it is no longer wanted';
    else if (Number.isFinite(named) && named !== pid) why = `${path} now names pid ${named}`;
    else if (!Number.isFinite(named) && ++misses >= 2) why = `${path} is gone`;
    if (why) {
      clearInterval(beat);
      log(`daemon pid ${pid} standing down: ${why}`);
      onLost();
      return;
    }
    if (Number.isFinite(named)) {
      misses = 0;
      try { const t = new Date(); utimesSync(path, t, t); } catch { /* the next beat retries */ }
    }
  }, heartbeatMs);
  beat.unref();
  return () => {
    clearInterval(beat);
    if (readPidfile(path) === pid) {
      try { unlinkSync(path); } catch { /* already gone */ }
    }
  };
}

// Is the on-demand daemon still asked for? `install --daemon` writes the
// marker and `uninstall` removes it.
export function onDemandWanted(marker = DAEMON_ON_DEMAND) {
  return existsSync(marker);
}

// Where the on-demand daemon's own stdout/stderr go — the file launchd writes
// them to elsewhere, which bin/unsnooze.js rotates when the daemon starts.
const DAEMON_LOG = join(STATE_DIR, 'daemon.log');

function spawnOnDemandDaemon(args) {
  return spawnDetached(args, {}, { standalone: true, logFile: DAEMON_LOG });
}

// Start the daemon unless it is already running — native Windows only, and
// only once `unsnooze install --daemon` has asked for it (the marker). The
// wrappers and the StopFailure hook call this, and between them they run
// whenever an agent does, so the daemon is back soon after a sign-in without
// anything registered to start at logon. Never throws: it sits on the launch
// path, where a failure must cost the daemon and nothing else.
//
// --on-demand ties the daemon to the marker: it exits when the marker goes
// (uninstall), where a daemon somebody runs by hand keeps running.
export function ensureDaemon({
  platform = process.platform, marker = DAEMON_ON_DEMAND,
  running = runningDaemonPid, spawner = spawnOnDemandDaemon,
} = {}) {
  try {
    if (platform !== 'win32' || !existsSync(marker) || running()) return null;
    const pid = spawner(['daemon', '--on-demand']);
    log(`daemon not running — started it on demand (pid ${pid})`);
    return pid;
  } catch (err) {
    log(`could not start the daemon on demand: ${err.message}`);
    return null;
  }
}

// Stop the on-demand daemon (uninstall, and the restart `install --daemon`
// does). Only a daemon proven live by its heartbeat is signalled — a stale
// file's pid may be anybody's by now — and never this process, which a pid
// recycled inside the heartbeat window could be. The file goes either way, so
// a live daemon too stale to prove itself stands down at its next beats.
// Returns the pid that was signalled, or null.
export function stopDaemon({
  path = DAEMON_PIDFILE, running = runningDaemonPid, lock = RESUMER_LOCK,
  kill = (pid, signal) => process.kill(pid, signal),
} = {}) {
  const found = running({ path });
  const pid = found === process.pid ? null : found;
  if (pid) {
    try { kill(pid, 'SIGTERM'); } catch { /* raced with its exit */ }
    log(`stopped daemon pid ${pid}`);
    // On Windows that was TerminateProcess: nothing of the daemon's own ran,
    // so a resumer lock it held still names it (see claimDaemon).
    if (readPidfile(lock) === pid) {
      try { unlinkSync(lock); } catch { /* already gone */ }
    }
  }
  try { unlinkSync(path); } catch { /* none to remove */ }
  return pid;
}

// What `install --daemon` does on Windows, as launchctl unload+load does on
// macOS: a daemon already running keeps the code and PATH it started with, so
// re-running setup is how a user hands it new ones.
export function restartDaemon() {
  stopDaemon();
  return ensureDaemon();
}
