import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, linkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { GOAL_RUNTIME_FILES, inspectGoalRuntime, probeGoalRuntime } from '../src/goal-runtime.js';
import { windowsBundledCodex } from '../src/agents/codex.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'unsnooze-runtime-'));
  for (const name of GOAL_RUNTIME_FILES) writeFileSync(join(root, name), 'fixture');
  return { root, executable: join(root, 'codex.exe'), close: () => rmSync(root, { recursive: true, force: true }) };
}
function frame(value) {
  const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4);
  header.writeUInt32LE(body.length); return Buffer.concat([header, body]);
}
const ready = { type: 'connection/ready', selectedVersion: 1, capabilities: [] };

test('readiness rejects missing helpers before starting any subprocess', () => {
  const f = fixture();
  try {
    rmSync(join(f.root, 'codex-code-mode-host.exe'));
    assert.throws(() => probeGoalRuntime(f.executable, { run: () => assert.fail('incomplete runtime was launched') }), /codex-code-mode-host.exe/);
    assert.throws(() => inspectGoalRuntime('codex.exe'), /absolute path/);
  } finally { f.close(); }
});

test('empty, malformed, truncated and mismatched protocol replies cannot pass readiness', () => {
  const f = fixture();
  try {
    for (const stdout of [Buffer.alloc(0), Buffer.from('codex-cli 1.0'), frame(ready).subarray(0, 10),
      frame({ ...ready, selectedVersion: 2 }), frame({ ...ready, capabilities: ['unknown'] }),
      Buffer.concat([frame(ready), Buffer.from('unexpected')])]) {
      assert.throws(() => probeGoalRuntime(f.executable, { run: () => ({ status: 0, stdout }) }));
    }
    for (const result of [{ status: null, error: Error('timeout') }, { status: 1, stdout: frame(ready) }]) {
      assert.throws(() => probeGoalRuntime(f.executable, { run: () => result }), /failed or timed out/);
    }
    assert.equal(probeGoalRuntime(f.executable, { run: () => ({ status: 0, stdout: frame(ready) }) }).desktopCompatible, 'unverified');
  } finally { f.close(); }
});

const bundled = process.platform === 'win32' ? windowsBundledCodex() : null;
test('real CLI --version passes in a broken layout that the runtime preflight rejects', {
  skip: !bundled,
}, t => {
  const root = mkdtempSync(join(tmpdir(), 'unsnooze-incomplete-runtime-'));
  try {
    const executable = join(root, 'codex.exe');
    // A hard link reuses the installed bytes without copying the large binary
    // or changing anything in the real installation.
    try { linkSync(bundled, executable); }
    catch (error) { if (error.code === 'EXDEV') { t.skip('Different volumes do not support hard links'); return; } throw error; }
    const version = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 5_000, windowsHide: true });
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /codex-cli/);
    assert.equal(existsSync(join(root, 'codex-code-mode-host.exe')), false);
    assert.throws(() => probeGoalRuntime(executable), /Incomplete Goal runtime.*codex-code-mode-host.exe/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installed code-mode host completes a real local handshake without tools or a model turn', {
  skip: !bundled,
}, () => {
  const result = probeGoalRuntime(bundled);
  assert.equal(result.codeHostReady, true);
  assert.equal(result.protocol, 1);
  assert.equal(result.desktopCompatible, 'unverified');
});
