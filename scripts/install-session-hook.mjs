import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const sourceHook = fileURLToPath(new URL('../hooks/unsnooze-session-start.cjs', import.meta.url));
const quote = value => {
  if (/["\r\n]/.test(value)) throw new Error('Hook paths cannot contain quotes or newlines');
  return `"${value}"`;
};

export function installSessionHook({
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  nodeExecutable = process.execPath, packageRoot,
} = {}) {
  if (!packageRoot || !fs.existsSync(path.join(packageRoot, 'src', 'spawn.js'))) {
    throw new Error('Install this Unsnooze fork before installing its session hook');
  }
  const home = path.resolve(codexHome);
  const configPath = path.join(home, 'hooks.json');
  const original = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null;
  const config = original === null ? {} : JSON.parse(original);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('hooks.json must be an object');
  if (config.hooks !== undefined && (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks))) {
    throw new Error('hooks must be an object');
  }
  config.hooks ||= {};
  if (config.hooks.SessionStart !== undefined && !Array.isArray(config.hooks.SessionStart)) throw new Error('SessionStart must be an array');
  const hookPath = path.join(home, 'hooks', 'unsnooze-session-start.cjs');
  const command = [nodeExecutable, hookPath, path.resolve(packageRoot)].map(quote).join(' ');
  const group = { matcher: '^(startup|resume|clear|fork)$', hooks: [{ type: 'command', command,
    timeout: 10, statusMessage: 'Ensuring Unsnooze daemon is running' }] };
  const entries = config.hooks.SessionStart ||= [];
  const ours = entries.findIndex(entry => entry.hooks?.some(hook => hook.command?.includes(quote(hookPath))));
  if (ours >= 0) {
    if (entries[ours].hooks.length !== 1) throw new Error('Existing Unsnooze group contains other handlers; inspect it before updating');
    entries[ours] = group;
  } else entries.push(group);
  const content = JSON.stringify(config, null, 2) + '\n';
  const hookContent = fs.readFileSync(sourceHook, 'utf8');
  const hookChanged = !fs.existsSync(hookPath) || fs.readFileSync(hookPath, 'utf8') !== hookContent;
  const changed = content !== original || hookChanged;
  let backup = null;
  if (changed) {
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    if (original !== null || fs.existsSync(hookPath)) {
      backup = fs.mkdtempSync(path.join(path.dirname(hookPath), 'unsnooze-backup-'));
      if (original !== null) fs.writeFileSync(path.join(backup, 'hooks.json'), original, { mode: 0o600 });
      if (fs.existsSync(hookPath)) fs.copyFileSync(hookPath, path.join(backup, 'unsnooze-session-start.cjs'));
    }
    fs.writeFileSync(hookPath, hookContent, { mode: 0o600 });
    const tmp = path.join(home, `.hooks.unsnooze.${process.pid}.tmp`);
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, configPath);
  }
  return { changed, configPath, hookPath, backup, requiresTrustReview: true };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.platform !== 'win32') throw new Error('This session hook targets Windows Codex/Work local');
    const npmRoot = execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd root --global'],
      { encoding: 'utf8', windowsHide: true }).trim();
    const result = installSessionHook({ packageRoot: path.join(npmRoot, 'unsnooze') });
    console.log(JSON.stringify(result, null, 2));
    console.log('Review and Trust "Ensuring Unsnooze daemon is running" in Codex /hooks. This installer does not grant trust.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
