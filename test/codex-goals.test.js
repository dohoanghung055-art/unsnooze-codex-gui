import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOwnerProxy } from '../src/goal-owner-proxy.js';
import { createGoalClient, goalFingerprint, resumableGoal } from '../src/codex-goals.js';

const threadId = '11111111-2222-4333-8444-555555555555';
const initial = { threadId, objective: 'Finish the fixture task', status: 'usageLimited',
  createdAt: 10, updatedAt: 20, tokenBudget: 1000, tokensUsed: 100, timeUsedSeconds: 30 };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ hook, timeoutMs } = {}) {
  let goal = { ...initial }, owns = true, status = 'idle';
  const requests = [], forwarded = [];
  const proxy = createOwnerProxy({ timeoutMs, writeDesktop: line => forwarded.push(JSON.parse(line)),
    writeBackend: line => {
      const message = JSON.parse(line); requests.push(message);
      if (!message.id) return;
      queueMicrotask(() => {
        if (hook?.(message, api) === false) return;
        let result;
        if (message.method === 'thread/loaded/list') result = { data: owns ? [threadId] : [] };
        else if (message.method === 'thread/goal/get') result = goal ? { goal: { ...goal } } : {};
        else if (message.method === 'thread/read') result = { thread: { id: threadId, status: { type: status },
          turns: [{ id: 'stopped-turn', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } }] } };
        else if (message.method === 'thread/goal/set') {
          goal = { ...goal, ...message.params, updatedAt: goal.updatedAt + 1 };
          result = { goal: { ...goal } };
        } else if (message.method === 'thread/goal/clear') { goal = null; result = {}; }
        else result = { ok: true };
        proxy.fromBackend(JSON.stringify({ id: message.id, result }));
      });
    } });
  const api = { proxy, requests, forwarded, setGoal: value => { goal = value; },
    setOwner: value => { owns = value; }, setStatus: value => { status = value; },
    get goal() { return goal; } };
  proxy.fromDesktop(JSON.stringify({ method: 'initialized' }));
  return api;
}
async function inspect(f) { return f.proxy.handle('goal/read', { threadId }); }
async function resume(f, inspection) {
  return f.proxy.handle('goal/resume', { threadId, revision: inspection.revision,
    fingerprint: goalFingerprint(inspection.goal), stoppedTurnId: 'stopped-turn' });
}

test('same owner activates only usageLimited, preserving accounting and automatic provenance', async () => {
  const f = fixture();
  const inspection = await inspect(f);
  assert.equal((await resume(f, inspection)).goal.status, 'active');
  assert.deepEqual(f.requests.filter(r => r.method === 'thread/goal/set').map(r => r.params),
    [{ threadId, status: 'active', origin: 'automatic' }]);
  for (const key of ['objective', 'createdAt', 'tokenBudget', 'tokensUsed', 'timeUsedSeconds']) assert.equal(f.goal[key], initial[key]);
  assert.equal(f.forwarded.length, 0);
  assert.equal(f.requests.some(r => /thread\/(start|resume)|turn\/start/.test(r.method)), false);
  f.proxy.close();
});

test('manual pause, blocked, complete, budget exhaustion and malformed accounting never activate', async () => {
  for (const goal of [
    ...['active', 'paused', 'blocked', 'budgetLimited', 'complete'].map(status => ({ ...initial, status })),
    { ...initial, tokenBudget: 100 }, { ...initial, tokensUsed: -1 }, { ...initial, tokensUsed: NaN },
  ]) {
    assert.equal(resumableGoal(goal, threadId), false);
    const f = fixture(); f.setGoal(goal);
    const inspection = await inspect(f);
    await assert.rejects(resume(f, inspection));
    assert.equal(f.requests.some(r => r.method === 'thread/goal/set'), false);
    f.proxy.close();
  }
});

test('no Goal and an unloaded thread remain untouched', async () => {
  const f = fixture(); f.setGoal(null);
  assert.equal((await inspect(f)).goal, null);
  f.setOwner(false);
  await assert.rejects(inspect(f), /not loaded/);
  assert.equal(f.requests.some(r => r.method === 'thread/goal/set'), false);
  f.proxy.close();
});

test('changed Goal or a newly busy thread cancels automatic activation', async () => {
  for (const kind of ['goal', 'busy']) {
    const f = fixture(); const inspection = await inspect(f);
    if (kind === 'goal') f.setGoal({ ...initial, updatedAt: 21 });
    else f.setStatus('active');
    await assert.rejects(resume(f, inspection), /changed|idle/);
    assert.equal(f.requests.some(r => r.method === 'thread/goal/set'), false);
    f.proxy.close();
  }
});

test('a completed replacement turn cannot reactivate an old usage-limited Goal', async () => {
  const f = fixture({ hook(message, api) {
    if (message.method === 'thread/read') {
      api.proxy.fromBackend(JSON.stringify({ id: message.id, result: { thread: {
        id: threadId, status: { type: 'idle' }, turns: [{ id: 'new-completed-turn', status: 'completed' }],
      } } }));
      return false;
    }
  } });
  await assert.rejects(resume(f, await inspect(f)), /confirmed usage-limit stop/);
  assert.equal(f.requests.some(r => r.method === 'thread/goal/set'), false);
  f.proxy.close();
});

test('a user turn arriving during inspection invalidates activation', async () => {
  let inspecting = false;
  const f = fixture({ hook(message, api) {
    if (inspecting && message.method === 'thread/read') {
      api.proxy.fromDesktop(JSON.stringify({ id: 50, method: 'turn/start', params: { threadId, input: [] } }));
    }
  } });
  const inspection = await inspect(f); inspecting = true;
  await assert.rejects(resume(f, inspection), /changed/);
  assert.equal(f.requests.some(r => r.method === 'thread/goal/set'), false);
  f.proxy.close();
});

test('manual pause arriving during the final read wins without automatic activation', async () => {
  let reads = 0, inject = false;
  const f = fixture({ hook(message, api) {
    if (message.method === 'thread/goal/get' && inject && ++reads === 2) {
      api.proxy.fromDesktop(JSON.stringify({ id: 42, method: 'thread/goal/set', params: { threadId, status: 'paused' } }));
    }
  } });
  const inspection = await inspect(f); inject = true;
  await assert.rejects(resume(f, inspection), /changed/);
  await tick();
  assert.equal(f.goal.status, 'paused');
  assert.equal(f.requests.filter(r => r.method === 'thread/goal/set').length, 1);
  assert.equal(f.forwarded[0].id, 42);
  f.proxy.close();
});

test('manual pause arriving after activation write is applied afterwards', async () => {
  const f = fixture({ hook(message, api) {
    if (message.method === 'thread/goal/set' && message.params.origin === 'automatic') {
      api.proxy.fromDesktop(JSON.stringify({ id: 43, method: 'thread/goal/set', params: { threadId, status: 'paused' } }));
    }
  } });
  await resume(f, await inspect(f)); await tick();
  assert.equal(f.goal.status, 'paused');
  assert.deepEqual(f.requests.filter(r => r.method === 'thread/goal/set').map(r => r.params.status), ['active', 'paused']);
  assert.equal(f.forwarded[0].id, 43);
  f.proxy.close();
});

test('ordinary Desktop traffic, backend requests and notifications pass through', async () => {
  const f = fixture();
  f.proxy.fromDesktop(JSON.stringify({ id: 9, method: 'some/new/desktop/api', params: { retained: true } }));
  f.proxy.fromBackend(JSON.stringify({ method: 'turn/started', params: { threadId } }));
  f.proxy.fromBackend(JSON.stringify({ id: 'backend-id', method: 'item/commandExecution/requestApproval', params: {} }));
  await tick();
  assert.deepEqual(f.requests.find(r => r.id === 9).params, { retained: true });
  assert.ok(f.forwarded.some(r => r.id === 9 && r.result.ok));
  assert.ok(f.forwarded.some(r => r.method === 'turn/started'));
  assert.ok(f.forwarded.some(r => r.method === 'item/commandExecution/requestApproval'));
  await assert.rejects(f.proxy.handle('thread/goal/set', { threadId }), /Unsupported/);
  f.proxy.close();
});

test('lost mutation ack disables further adapter writes; no automatic retry', async () => {
  const f = fixture({ timeoutMs: 20, hook: message => message.method !== 'thread/goal/set' });
  const inspection = await inspect(f);
  await assert.rejects(resume(f, inspection), /unknown/);
  await assert.rejects(resume(f, inspection), /not ready/);
  assert.equal(f.requests.filter(r => r.method === 'thread/goal/set').length, 1);
  f.proxy.close();
});

test('client distinguishes absent adapter from ambiguous or unavailable ownership and never retries', async () => {
  const rec = { sessionId: threadId };
  assert.equal((await createGoalClient({ listPipes: () => [] }).read(rec)).available, false);
  const names = ['unsnooze-codex-goals-abc', 'unsnooze-codex-goals-def'];
  const reply = { protocol: 1, threadId, revision: 0, goal: initial };
  await assert.rejects(createGoalClient({ listPipes: () => names, request: async () => reply }).read(rec), /unique/);
  await assert.rejects(createGoalClient({ listPipes: () => names, request: async () => { throw Error('closed'); } }).read(rec), /unique/);
  let mutations = 0;
  const client = createGoalClient({ listPipes: () => names.slice(0, 1), request: async (_pipe, method) => {
    if (method === 'goal/read') return reply;
    mutations++; throw Error('ack lost');
  } });
  await assert.rejects(client.resume(rec, await client.read(rec)), /ack lost/);
  assert.equal(mutations, 1);
});
