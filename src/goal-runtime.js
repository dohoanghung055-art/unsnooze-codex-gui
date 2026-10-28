// Diagnostic checks only. These do not establish Desktop ownership or grant
// permission to replace its launcher; automatic bridge activation stays disabled.
import { statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const GOAL_RUNTIME_FILES = [
  'codex.exe', 'codex-code-mode-host.exe', 'codex-command-runner.exe',
  'codex-windows-sandbox-setup.exe',
];

export function inspectGoalRuntime(executable) {
  if (!isAbsolute(executable || '') || basename(executable).toLowerCase() !== 'codex.exe') {
    throw new Error('Goal runtime requires an absolute path to codex.exe');
  }
  const root = dirname(executable);
  const missing = GOAL_RUNTIME_FILES.filter(name => {
    try { const stat = statSync(join(root, name)); return !stat.isFile() || stat.size === 0; }
    catch { return true; }
  });
  if (missing.length) {
    throw new Error(`Incomplete Goal runtime: ${missing.join(', ')}. Restore the native Desktop runtime; do not substitute an older CLI.`);
  }
  return { executable, codeHost: join(root, 'codex-code-mode-host.exe') };
}

export function probeGoalRuntime(executable, { run = spawnSync, timeoutMs = 5_000 } = {}) {
  const runtime = inspectGoalRuntime(executable);
  const hello = Buffer.from(JSON.stringify({ type: 'connection/hello', supportedVersions: [1],
    requiredCapabilities: [], optionalCapabilities: [] }));
  const header = Buffer.alloc(4); header.writeUInt32LE(hello.length);
  // Empty capabilities and EOF perform only the local readiness handshake:
  // no model calls, delegated tools, threads, Goals, or permission changes.
  const result = run(runtime.codeHost, ['--listen', 'stdio'], {
    input: Buffer.concat([header, hello]), timeout: timeoutMs,
    maxBuffer: 64 * 1024, windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('Code-mode host readiness failed or timed out');
  const output = result.stdout;
  if (!Buffer.isBuffer(output) || output.length < 4) throw new Error('Missing code-mode host readiness frame');
  const length = output.readUInt32LE(0);
  if (!length || length > 60 * 1024 || output.length !== 4 + length) throw new Error('Invalid code-mode host readiness frame');
  let ready;
  try { ready = JSON.parse(output.subarray(4).toString('utf8')); }
  catch { throw new Error('Invalid code-mode host readiness JSON'); }
  if (ready?.type !== 'connection/ready' || ready.selectedVersion !== 1
    || !Array.isArray(ready.capabilities) || ready.capabilities.length !== 0) {
    throw new Error('Unsupported code-mode host readiness response');
  }
  return { ...runtime, codeHostReady: true, protocol: 1, desktopCompatible: 'unverified' };
}
