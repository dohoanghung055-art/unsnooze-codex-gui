import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { readUiGoal, createGoalUiClient, checkUiGoal, uiGoalStamp } from '../src/goal-ui.js';

const rec = { sessionId: 'fixture-thread', resetAt: 1 };
const goal = { threadId: rec.sessionId, goalId: 'fixture-goal', objective: 'Finish fixture',
  status: 'usageLimited', createdAt: 1, updatedAt: 2, tokensUsed: 9, timeUsedSeconds: 10, tokenBudget: 100 };
const inspection = { available: true, uniqueObjective: true, goal };
const stopped = { title: 'Fixture chat', status: 'idle', turn: { id: 'quota-turn', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } } };
const input = { threadId: rec.sessionId, title: stopped.title, stoppedTurnId: stopped.turn.id, resetAt: 1, goalStamp: uiGoalStamp(goal) };

test('UI Goal reader never changes the database and distinguishes duplicate objectives', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unsnooze-goal-ui-'));
  const database = join(dir, 'goals.sqlite');
  try {
    const db = new DatabaseSync(database);
    db.exec('CREATE TABLE thread_goals(thread_id TEXT, goal_id TEXT, objective TEXT, status TEXT, token_budget INTEGER, tokens_used INTEGER, time_used_seconds INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER)');
    const insert = db.prepare('INSERT INTO thread_goals VALUES(?,?,?,?,?,?,?,?,?)');
    insert.run(rec.sessionId, goal.goalId, goal.objective, 'usage_limited', 100, 9, 10, 1, 2);
    const before = readFileSync(database);
    const result = await readUiGoal(rec, { database });
    assert.deepEqual(result, { ...inspection, transport: 'ui' });
    assert.deepEqual(readFileSync(database), before);
    insert.run('other', 'other-goal', goal.objective, 'paused', null, 0, 0, 0, 0);
    assert.equal((await readUiGoal(rec, { database })).uniqueObjective, false);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fresh check holds pause, budget, identity, native progress and future reset changes', async () => {
  const check = (g = inspection, s = stopped, request = input) => checkUiGoal(request,
    { readGoal: async () => g, desktop: { read: async () => s } });
  assert.equal(await check(), true);
  for (const status of ['paused', 'blocked', 'complete', 'budgetLimited', 'active']) {
    await assert.rejects(check({ ...inspection, goal: { ...goal, status } }));
  }
  await assert.rejects(check({ ...inspection, goal: { ...goal, tokenBudget: 9 } }));
  await assert.rejects(check({ ...inspection, goal: { ...goal, goalId: 'replacement' } }));
  await assert.rejects(check({ ...inspection, uniqueObjective: false }));
  await assert.rejects(check(inspection, { ...stopped, turn: { id: 'done', status: 'completed' } }));
  await assert.rejects(check(inspection, stopped, { ...input, resetAt: Date.now() + 60000 }));
});

function fixture(run) {
  return createGoalUiClient({ readGoal: async () => inspection, run,
    desktop: { read: async () => stopped, navigate: async () => {}, endpoint: async () => 'fixture-pipe' } });
}
test('preparation never invokes; a definite refusal can defer but a lost receipt stays uncertain', async () => {
  for (const outcome of ['success', 'refused', 'lost']) {
    const actions = [];
    const client = fixture(async request => {
      actions.push(request.action);
      if (request.action === 'invoke' && outcome === 'lost') throw new Error('lost receipt');
      if (request.action === 'invoke' && outcome === 'refused') return { ok: false, attempted: false, reason: 'user input' };
      return { ok: true, inputTick: 123, attempted: request.action === 'invoke' };
    });
    await client.prepare(rec, inspection);
    assert.deepEqual(actions, ['environment', 'inspect']);
    const execute = () => client.resume(rec, { ...inspection, stoppedTurnId: 'quota-turn' });
    if (outcome === 'success') await execute();
    else await assert.rejects(execute(), error => outcome === 'refused' ? error.notAttempted === true : error.notAttempted !== true);
    await assert.rejects(execute(), error => error.notAttempted === true);
    assert.equal(actions.filter(a => a === 'invoke').length, 1);
  }
});
test('locked or active-user environment prevents navigation and invocation', async () => {
  let navigated = false;
  const client = createGoalUiClient({ readGoal: async () => inspection,
    desktop: { read: async () => stopped, navigate: () => { navigated = true; } }, run: async () => ({ ok: false, reason: 'locked' }) });
  await assert.rejects(client.prepare(rec, inspection), /locked/);
  assert.equal(navigated, false);
});
