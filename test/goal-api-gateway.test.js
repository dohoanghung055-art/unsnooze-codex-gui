import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { createGoalApiGateway } from '../src/goal-api-gateway.js';
import { createGoalClient } from '../src/codex-goals.js';
import { pipeRequest } from '../src/codex-desktop.js';

const id = '11111111-2222-4333-8444-555555555555';
const initial = { threadId: id, objective: 'Fixture goal', status: 'usageLimited',
  createdAt: 1, updatedAt: 2, tokenBudget: 1000, tokensUsed: 100, timeUsedSeconds: 10 };
function connected(url, options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.once('open', () => resolve(socket)); socket.once('error', reject);
  });
}
function rpc(socket) {
  const pending = new Map(); let sequence = 0;
  socket.on('message', data => {
    const message = JSON.parse(data), value = pending.get(message.id);
    if (!value) return;
    clearTimeout(value.timer); pending.delete(message.id);
    message.error ? value.reject(Error(message.error.message)) : value.resolve(message.result);
  });
  return (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('fixture RPC timeout')); }, 3000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
}

test('private API gateway keeps Desktop and guarded Goal activation on one authenticated connection', {
  skip: process.platform !== 'win32',
}, async () => {
  const token = 'a'.repeat(64), unique = randomUUID(); let goal = { ...initial }, connectionCount = 0;
  const requests = [], peers = new Set();
  const backend = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => backend.once('listening', resolve));
  backend.on('connection', (socket, request) => {
    connectionCount++; peers.add(socket); assert.equal(request.headers.authorization, 'Bearer ' + token);
    socket.on('message', data => {
      const message = JSON.parse(data); requests.push(message);
      if (!message.id) return;
      let result;
      if (message.method === 'initialize') result = { userAgent: 'fixture' };
      else if (message.method === 'thread/loaded/list') result = { data: [id] };
      else if (message.method === 'thread/goal/get') result = { goal };
      else if (message.method === 'thread/read') result = { thread: { id, status: { type: 'idle' },
        turns: [{ id: 'stopped-turn', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } }] } };
      else if (message.method === 'thread/goal/set') { goal = { ...goal, ...message.params, updatedAt: goal.updatedAt + 1 }; result = { goal }; }
      else result = { retained: message.params };
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  const goalName = 'unsnooze-codex-goals-' + unique;
  const goalPipe = '\\\\.\\pipe\\' + goalName;
  const gateway = await createGoalApiGateway({ backendUrl: `ws://127.0.0.1:${backend.address().port}/rpc`,
    token, desktopPipe: '\\\\.\\pipe\\unsnooze-desktop-' + unique, goalPipe });
  let desktop;
  try {
    assert.deepEqual(await pipeRequest(goalPipe, 'service/status', {}), { protocol: 1, connected: false, ready: false });
    await assert.rejects(pipeRequest(goalPipe, 'goal/read', { threadId: id }), /not connected/);
    await assert.rejects(connected(gateway.desktopUrl, { origin: 'https://example.invalid' }), /403/);
    desktop = await connected(gateway.desktopUrl); const call = rpc(desktop);
    await call('initialize', { clientInfo: { name: 'fixture', version: '1' } });
    desktop.send(JSON.stringify({ method: 'initialized' }));
    await call('echo', { model: 'keep', effort: 'keep', permissionProfile: 'keep' });
    assert.deepEqual(requests.find(r => r.method === 'echo').params, { model: 'keep', effort: 'keep', permissionProfile: 'keep' });
    await assert.rejects(connected(gateway.desktopUrl), /403/);
    const goals = createGoalClient({ listPipes: () => [goalName] }), rec = { sessionId: id };
    const inspection = await goals.read(rec);
    await goals.resume(rec, { ...inspection, stoppedTurnId: 'stopped-turn' });
    assert.equal(goal.status, 'active');
    assert.deepEqual(requests.filter(r => r.method === 'thread/goal/set').map(r => r.params),
      [{ threadId: id, status: 'active', origin: 'automatic' }]);
    assert.equal(connectionCount, 1);
    await call('thread/goal/set', { threadId: id, status: 'paused' });
    await assert.rejects(goals.resume(rec, await goals.read(rec)), /not eligible/);
    assert.equal(goal.status, 'paused');
    assert.equal(requests.some(r => /thread\/(start|resume)|turn\/start/.test(r.method)), false);
  } finally {
    desktop?.terminate(); await gateway.close();
    for (const peer of peers) peer.terminate();
    await new Promise(resolve => backend.close(resolve));
  }
});
