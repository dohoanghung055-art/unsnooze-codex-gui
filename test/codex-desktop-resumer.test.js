import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'unsnooze-desktop-resumer-'));
process.env.UNSNOOZE_STATE_DIR = dir;
process.env.UNSNOOZE_CODEX_DIR = join(dir, 'empty-codex');
process.env.UNSNOOZE_NOTIFICATIONS = 'off';
const { dispatchOne, verifyOne, planFor } = await import('../src/resumer.js');
const { upsertSession, readState, updateState } = await import('../src/state.js');
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
const options = { skip: process.platform !== 'win32' };
const mux = { newWindow: () => { throw new Error('Desktop must never launch a CLI writer'); }, paneAlive: async () => false };
function seed() {
  const sessionId = randomUUID();
  const state = upsertSession({ sessionId, agent: 'codex', origin: 'codex_work_desktop', cwd: dir,
    mux: 'headless', pane: null, status: 'stopped', limitType: '5h', detectedAt: Date.now() - 10000,
    resetAt: Date.now() - 1000, resetSource: 'absolute', attempts: 0 });
  return Object.values(state.sessions).find(s => s.sessionId === sessionId);
}
const stopped = rec => ({ id: rec.sessionId, status: 'systemError', turn: {
  id: 'stopped-turn', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' }, startedAt: rec.detectedAt - 1000,
} });
const running = rec => ({ id: rec.sessionId, status: 'active', turn: {
  id: 'new-turn', status: 'inProgress', error: null, startedAt: Date.now(),
} });

test('Desktop sends once with a durable claim and verifies the real new turn', options, async () => {
  const rec = seed(); let sent = 0, started = false;
  const desktop = { read: async () => started ? running(rec) : stopped(rec), send: async (_rec, message, claim) => {
    const persisted = readState().sessions[rec.key];
    assert.equal(persisted.status, 'resuming');
    assert.equal(persisted.desktopWake.callId, claim.callId);
    assert.equal(message, 'Continue safely');
    assert.equal(claim.turnId, 'stopped-turn');
    sent++; started = true;
  } };
  assert.equal(await dispatchOne(rec, { mux, desktop, resumeMessage: 'Continue safely' }), 'injected');
  assert.equal(await dispatchOne(rec, { mux, desktop }), 'stale');
  assert.equal(await verifyOne(rec.key, { desktop }), 'resumed');
  assert.equal(readState().sessions[rec.key].status, 'resumed');
  assert.equal(sent, 1);
});

test('a completed task and a user-resumed task are never woken again', options, async () => {
  for (const done of [false, true]) {
    const rec = seed(); let sent = 0;
    const desktop = { read: async () => done ? { ...running(rec), status: 'idle', turn: { id: 'done', status: 'completed', error: null } } : running(rec), send: async () => { sent++; } };
    assert.equal(await dispatchOne(rec, { mux, desktop }), 'already-resumed');
    assert.equal(sent, 0);
    assert.equal(readState().sessions[rec.key].resumedBy, 'native');
  }
});

test('a user resume during the final read suppresses sending', options, async () => {
  const rec = seed(); let reads = 0;
  const desktop = { read: async () => ++reads === 1 ? stopped(rec) : running(rec), send: () => assert.fail('duplicate wake') };
  assert.equal(await dispatchOne(rec, { mux, desktop }), 'already-resumed');
});

test('unavailable Desktop waits without a CLI fallback or exhausted attempts', options, async () => {
  const rec = seed();
  const desktop = { read: async () => { throw new Error('closed'); } };
  for (let i = 0; i < 8; i++) assert.equal(await dispatchOne(rec, { mux, desktop }), 'probe');
  assert.equal(readState().sessions[rec.key].status, 'stopped');
  assert.equal(readState().sessions[rec.key].attempts, 0);
});

test('unknown send outcome survives restart and cannot send twice', options, async () => {
  const rec = seed(); let sends = 0;
  const desktop = { read: async () => stopped(rec), send: async () => { sends++; throw new Error('ack lost'); } };
  assert.equal(await dispatchOne(rec, { mux, desktop }), 'injected');
  const claimed = readState().sessions[rec.key];
  assert.equal(await dispatchOne(claimed, { mux, desktop }), 'stale');
  assert.equal(await verifyOne(rec.key, { desktop }), 'pending');
  updateState(s => { s.sessions[rec.key].desktopWake.sentAt = Date.now() - 121000; });
  assert.equal(await verifyOne(rec.key, { desktop: { read: async () => stopped(rec) } }), 'held');
  assert.equal(readState().sessions[rec.key].status, 'failed');
  assert.equal(sends, 1);
});

test('a newer limit during delivery releases only the old claim', options, async () => {
  const rec = seed();
  const desktop = { read: async () => stopped(rec), send: async () => {} };
  await dispatchOne(rec, { mux, desktop });
  updateState(s => { s.sessions[rec.key].bannerAt = Date.now(); });
  assert.equal(await verifyOne(rec.key, { desktop }), 'stale');
  assert.equal(readState().sessions[rec.key].status, 'stopped');
  assert.equal(readState().sessions[rec.key].desktopWake, null);
});

test('preview reads Desktop but sends no message and changes no state', options, async () => {
  const rec = seed(); const before = JSON.stringify(readState());
  const desktop = { read: async () => stopped(rec), send: () => assert.fail('preview sent') };
  const plan = await planFor(rec, { mux, desktop });
  assert.equal(plan.action, 'desktop');
  assert.equal(plan.argv, undefined);
  assert.equal(JSON.stringify(readState()), before);
});

test('non-limit errors and human cancellation are held without launching', options, async () => {
  const rec = seed();
  const desktop = { read: async () => ({ ...stopped(rec), turn: { id: 'cancelled', status: 'interrupted' } }), send: () => assert.fail('cancelled work restarted') };
  assert.equal(await dispatchOne(rec, { mux, desktop }), 'held');
  assert.equal(readState().sessions[rec.key].status, 'failed');
});

test('new Desktop turn hitting the limit is retryable and never falsely verified', options, async () => {
  const rec = seed(); let sent = false;
  const desktop = { read: async () => sent ? { ...stopped(rec), turn: { ...stopped(rec).turn, id: 'failed-new-turn' } } : stopped(rec), send: async () => { sent = true; } };
  assert.equal(await dispatchOne(rec, { mux, desktop }), 'injected');
  assert.equal(await verifyOne(rec.key, { desktop }), 'retry');
  const stored = readState().sessions[rec.key];
  assert.equal(stored.status, 'stopped');
  assert.equal(stored.desktopWake, null);
  assert.equal(stored.attempts, 1);
  assert.ok(stored.resetAt > Date.now());
});
