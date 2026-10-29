// Transparent stdio multiplexer: the Desktop and the Goal adapter share ONE
// backend. Only our response IDs are consumed; all Desktop traffic is forwarded.
import { randomUUID } from 'node:crypto';
import { goalFingerprint, resumableGoal } from './codex-goals.js';
import { desktopDecision } from './codex-desktop.js';

export function createOwnerProxy({ writeBackend, writeDesktop, timeoutMs = 15_000 }) {
  const prefix = `unsnooze-${randomUUID()}-`;
  const pending = new Map(), manual = new Map(), revisions = new Map(), queues = new Map();
  let sequence = 0, initialized = false, healthy = true, initializeId = null;
  const revision = id => revisions.get(id) || 0;
  const enqueue = (id, task) => {
    const next = (queues.get(id) || Promise.resolve()).catch(() => {}).then(task);
    queues.set(id, next);
    next.finally(() => { if (queues.get(id) === next) queues.delete(id); }).catch(() => {});
    return next;
  };
  function waitFor(map, id, consume) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        healthy = false; map.delete(id); reject(new Error('Goal owner outcome unknown; restart required'));
      }, timeoutMs);
      map.set(id, { consume, finish(error, result) {
        clearTimeout(timer); map.delete(id); error ? reject(error) : resolve(result);
      } });
    });
  }
  async function rpc(method, params) {
    if (!healthy || !initialized) throw new Error('Goal owner is not ready');
    const id = prefix + (++sequence);
    const promise = waitFor(pending, id, true);
    try { writeBackend(JSON.stringify({ id, method, params }) + '\n'); }
    catch (error) { pending.get(id)?.finish(error); }
    return promise;
  }
  async function loaded(threadId) {
    let cursor;
    for (let i = 0; i < 100; i++) {
      const result = await rpc('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      if (result?.data?.includes(threadId)) return;
      if (!result?.nextCursor) break;
      cursor = result.nextCursor;
    }
    throw new Error('Thread is not loaded in this Desktop owner');
  }
  return {
    get ready() { return initialized && healthy; },
    fromDesktop(line) {
      let message;
      try { message = JSON.parse(line); } catch { writeBackend(line + '\n'); return; }
      if (message.method === 'initialized') initialized = true;
      if (message.method === 'initialize' && Object.hasOwn(message, 'id')) initializeId = message.id;
      if (['turn/start', 'turn/steer', 'turn/interrupt', 'thread/resume', 'thread/archive'].includes(message.method)
        && message.params?.threadId) {
        const threadId = message.params.threadId;
        revisions.set(threadId, revision(threadId) + 1);
      }
      if (['thread/goal/set', 'thread/goal/clear'].includes(message.method) && message.params?.threadId) {
        const threadId = message.params.threadId;
        // Observe human changes immediately, even while an inspection is in flight.
        // If activation was already written, queue the human change AFTER its ack.
        revisions.set(threadId, revision(threadId) + 1);
        enqueue(threadId, async () => {
          const promise = waitFor(manual, message.id, false);
          writeBackend(line + '\n');
          await promise;
        }).catch(() => {});
      } else writeBackend(line + '\n');
    },
    fromBackend(line) {
      let message;
      try { message = JSON.parse(line); } catch { writeDesktop(line + '\n'); return; }
      // Requests from the backend may reuse an ID; only consume responses.
      if (!message.method && Object.hasOwn(message, 'id')) {
        if (initializeId !== null && message.id === initializeId) {
          initialized = !message.error && Object.hasOwn(message, 'result');
          initializeId = null;
        }
        const waiter = pending.get(message.id) || manual.get(message.id);
        if (waiter) {
          waiter.finish(message.error ? new Error(message.error.message || 'Goal request failed') : null, message.result);
          if (waiter.consume) return;
        } else if (String(message.id).startsWith(prefix)) return; // late own response
      }
      writeDesktop(line + '\n');
    },
    async handle(method, params) {
      const threadId = params?.threadId;
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId || '')) throw new Error('Invalid thread identity');
      if (!['goal/read', 'goal/resume'].includes(method)) throw new Error('Unsupported Goal bridge method');
      const observed = revision(threadId);
      return enqueue(threadId, async () => {
        await loaded(threadId);
        const { goal = null } = await rpc('thread/goal/get', { threadId });
        if (goal !== null && goal?.threadId !== threadId) throw new Error('Wrong Goal identity');
        if (method === 'goal/read') return { protocol: 1, threadId, goal, revision: observed };
        if (params.revision !== observed || revision(threadId) !== observed
          || goalFingerprint(goal) !== params.fingerprint || !resumableGoal(goal, threadId)) {
          throw new Error('Goal changed, is paused, or has no remaining budget');
        }
        const state = await rpc('thread/read', { threadId, includeTurns: true });
        if (state?.thread?.id !== threadId || !['idle', 'systemError'].includes(state.thread.status?.type)) {
          throw new Error('Desktop thread is no longer idle');
        }
        const latestTurn = state.thread.turns?.at(-1);
        if (!params.stoppedTurnId || latestTurn?.id !== params.stoppedTurnId
          || desktopDecision({ turn: latestTurn }, 0) !== 'wake') {
          throw new Error('Latest Desktop turn is no longer the confirmed usage-limit stop');
        }
        // Final re-read after the asynchronous ownership/idleness probes.
        const latest = await rpc('thread/goal/get', { threadId });
        if (revision(threadId) !== observed || goalFingerprint(latest.goal) !== params.fingerprint) {
          throw new Error('Goal changed before activation');
        }
        const result = await rpc('thread/goal/set', { threadId, status: 'active', origin: 'automatic' });
        if (result?.goal?.threadId !== threadId || result.goal.status !== 'active') throw new Error('Goal activation not acknowledged');
        return { protocol: 1, threadId, goal: result.goal };
      });
    },
    close() {
      healthy = false;
      for (const map of [pending, manual]) for (const waiter of [...map.values()]) waiter.finish(new Error('Goal owner closed'));
    },
  };
}
