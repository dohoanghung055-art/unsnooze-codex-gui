import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { installSessionHook } from '../scripts/install-session-hook.mjs';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unsnooze-hook-install-'));
  const packageRoot = path.join(dir, 'npm prefix', 'unsnooze');
  fs.mkdirSync(path.join(packageRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(packageRoot, 'src', 'spawn.js'), 'export const onDemandWanted=()=>true; export const runningDaemonPid=()=>12345;');
  return { dir, packageRoot, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('installer preserves other hooks and is idempotent with paths containing spaces', () => {
  const f = fixture();
  try {
    const original = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'existing-guard' }] }],
      SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'other-hook' }] }] } };
    fs.writeFileSync(path.join(f.dir, 'hooks.json'), JSON.stringify(original));
    const first = installSessionHook({ codexHome: f.dir, packageRoot: f.packageRoot });
    assert.equal(first.changed, true);
    assert.ok(first.backup);
    const actual = JSON.parse(fs.readFileSync(first.configPath));
    assert.deepEqual(actual.hooks.PreToolUse, original.hooks.PreToolUse);
    assert.deepEqual(actual.hooks.SessionStart[0], original.hooks.SessionStart[0]);
    assert.ok(actual.hooks.SessionStart[1].hooks[0].command.includes(`"${f.packageRoot}"`));
    const second = installSessionHook({ codexHome: f.dir, packageRoot: f.packageRoot });
    assert.equal(second.changed, false);
    assert.equal(second.backup, null);
    assert.equal(JSON.parse(fs.readFileSync(second.configPath)).hooks.SessionStart.length, 2);
  } finally { f.cleanup(); }
});

test('malformed configuration is left intact', () => {
  const f = fixture();
  try {
    const file = path.join(f.dir, 'hooks.json');
    fs.writeFileSync(file, '{"hooks":{"SessionStart":false}}');
    assert.throws(() => installSessionHook({ codexHome: f.dir, packageRoot: f.packageRoot }), /array/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{"hooks":{"SessionStart":false}}');
    assert.equal(fs.existsSync(path.join(f.dir, 'hooks')), false);
  } finally { f.cleanup(); }
});

test('hook uses the explicitly installed package and emits no developer context', { skip: process.platform !== 'win32' }, () => {
  const f = fixture();
  try {
    const script = fileURLToPath(new URL('../hooks/unsnooze-session-start.cjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, f.packageRoot], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }),
      env: { ...process.env, UNSNOOZE_STATE_DIR: f.dir }, encoding: 'utf8', windowsHide: true, timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    const log = JSON.parse(fs.readFileSync(path.join(f.dir, 'session-start-hook.log'), 'utf8').trim());
    assert.equal(log.action, 'already-running');
    assert.equal(log.pid, 12345);
  } finally { f.cleanup(); }
});
