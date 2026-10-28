// Opt-in CLI launcher. Forward non-app-server invocations without interception.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { windowsBundledCodex } from '../src/agents/codex.js';
import { createOwnerProxy } from '../src/goal-owner-proxy.js';
import { GOAL_PIPE_PREFIX } from '../src/codex-goals.js';
import { probeGoalRuntime } from '../src/goal-runtime.js';

const executable = windowsBundledCodex();
if (!executable || process.platform !== 'win32') {
  process.stderr.write('Unsnooze Goal bridge requires the Windows Codex Desktop runtime.\n');
  process.exit(1);
}
const args = process.argv.slice(2);
const intercept = args.includes('app-server') && !args.some(arg => ['generate-json-schema', 'generate-ts', '--help'].includes(arg));
if (args.includes('--check-runtime') || intercept) {
  try {
    const health = probeGoalRuntime(executable);
    if (args.includes('--check-runtime')) {
      process.stdout.write(JSON.stringify(health) + '\n');
      process.exit(0);
    }
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exit(1);
  }
}
const env = { ...process.env };
delete env.CODEX_CLI_PATH;
const child = spawn(executable, args, { env, windowsHide: true,
  stdio: intercept ? ['pipe', 'pipe', 'inherit'] : 'inherit' });
child.on('error', () => { process.stderr.write('Codex backend could not start.\n'); process.exitCode = 1; });
if (!intercept) child.on('exit', code => { process.exitCode = code ?? 1; });
else {
  const proxy = createOwnerProxy({
    writeBackend: text => { if (!child.stdin.write(text)) desktop.pause(); },
    writeDesktop: text => { if (!process.stdout.write(text)) backend.pause(); },
  });
  const desktop = createInterface({ input: process.stdin });
  const backend = createInterface({ input: child.stdout });
  desktop.on('line', line => proxy.fromDesktop(line));
  backend.on('line', line => proxy.fromBackend(line));
  desktop.on('close', () => { proxy.close(); child.stdin.end(); });
  child.stdin.on('drain', () => desktop.resume());
  process.stdout.on('drain', () => backend.resume());
  process.stdout.on('error', () => { proxy.close(); child.stdin.end(); });
  child.stdin.on('error', () => proxy.close());
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0), handled = false;
    socket.setTimeout(45_000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', async chunk => {
      if (handled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const size = buffer.readUInt32LE(0);
      if (!size || size > 8192) { handled = true; socket.destroy(); return; }
      if (buffer.length < 4 + size) return;
      handled = true;
      let id = null, response;
      try {
        const request = JSON.parse(buffer.subarray(4, 4 + size).toString('utf8'));
        id = request.id;
        if (request.jsonrpc !== '2.0') throw new Error('Invalid request');
        response = { id, jsonrpc: '2.0', result: await proxy.handle(request.method, request.params) };
      } catch (error) { response = { id, jsonrpc: '2.0', error: { code: -32000, message: error.message } }; }
      const body = Buffer.from(JSON.stringify(response)), header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      if (!socket.destroyed) socket.end(Buffer.concat([header, body]));
    });
  });
  // Failure to expose the optional adapter must not break ordinary Desktop work.
  server.on('error', () => process.stderr.write('Unsnooze Goal endpoint unavailable; Desktop passthrough remains active.\n'));
  server.listen('\\\\.\\pipe\\' + GOAL_PIPE_PREFIX + randomUUID());
  child.on('exit', code => {
    proxy.close(); server.close(); desktop.close(); backend.close();
    process.exit(code ?? 1);
  });
  process.on('SIGTERM', () => { proxy.close(); child.kill(); });
}
