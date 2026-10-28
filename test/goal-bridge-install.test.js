import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('disabled Goal installer cannot alter Desktop launcher or create an installation', {
  skip: process.platform !== 'win32',
}, () => {
  const home = mkdtempSync(join(tmpdir(), 'unsnooze-goal-disable-'));
  const installer = fileURLToPath(new URL('../scripts/install-goal-bridge.ps1', import.meta.url));
  const literal = value => "'" + value.replaceAll("'", "''") + "'";
  const command = `
    $before = [Environment]::GetEnvironmentVariable('CODEX_CLI_PATH','User')
    try { & ${literal(installer)} -Enable; exit 10 }
    catch {
      if ($_.Exception.Message -notlike '*activation is disabled*') { exit 11 }
      $after = [Environment]::GetEnvironmentVariable('CODEX_CLI_PATH','User')
      if ($before -cne $after) { exit 12 }
      Write-Output 'blocked-without-launcher-mutation'
    }
  `;
  try {
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', timeout: 20_000, windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /blocked-without-launcher-mutation/);
    assert.equal(existsSync(join(home, 'unsnooze-goal-bridge')), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
