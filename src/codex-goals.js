import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { pipeRequest } from './codex-desktop.js';

export const GOAL_PIPE_PREFIX = 'unsnooze-codex-goals-';
export const goalFingerprint = goal => createHash('sha256').update(JSON.stringify([
  goal?.threadId, goal?.createdAt, goal?.updatedAt, goal?.objective, goal?.status,
  goal?.tokenBudget, goal?.tokensUsed, goal?.timeUsedSeconds,
])).digest('hex');
export const goalIdentity = goal => createHash('sha256').update(JSON.stringify([
  goal?.threadId, goal?.createdAt, goal?.objective, goal?.tokenBudget,
])).digest('hex');

export function resumableGoal(goal, threadId) {
  return goal?.threadId === threadId && goal.status === 'usageLimited'
    && typeof goal.objective === 'string' && goal.objective.length > 0
    && ['createdAt', 'updatedAt', 'tokensUsed', 'timeUsedSeconds'].every(
      key => Number.isSafeInteger(goal[key]) && goal[key] >= 0)
    && (goal.tokenBudget === null || (Number.isSafeInteger(goal.tokenBudget)
      && goal.tokenBudget > goal.tokensUsed));
}

// A bridge must prove this thread is loaded in its own backend. No thread/start
// or thread/resume is used to acquire ownership, and discovery never mutates.
export function createGoalClient({
  listPipes = () => readdirSync('\\\\.\\pipe\\'), request = pipeRequest,
} = {}) {
  const owners = new Map();
  return {
    async read(rec) {
      const names = listPipes().filter(name => new RegExp(`^${GOAL_PIPE_PREFIX}[0-9a-f-]+$`, 'i').test(name));
      if (!names.length) return { available: false, goal: null };
      if (names.length > 16) throw new Error('Too many Goal owner endpoints');
      const replies = await Promise.all(names.map(async name => {
        const pipe = '\\\\.\\pipe\\' + name;
        try {
          const result = await request(pipe, 'goal/read', { threadId: rec.sessionId });
          if (result?.protocol !== 1 || result.threadId !== rec.sessionId) throw new Error('Invalid Goal owner response');
          return { pipe, result };
        } catch { return null; }
      }));
      const found = replies.filter(Boolean);
      if (found.length !== 1) throw new Error('A unique loaded Goal owner is unavailable');
      owners.set(rec.sessionId, found[0].pipe);
      return { available: true, ...found[0].result };
    },
    async resume(rec, inspection) {
      const pipe = owners.get(rec.sessionId);
      if (!pipe || !resumableGoal(inspection.goal, rec.sessionId)) throw new Error('Goal is not eligible for automatic resume');
      // Never retry this mutation, including on disconnect or an unknown ack.
      return request(pipe, 'goal/resume', {
        threadId: rec.sessionId, revision: inspection.revision,
        fingerprint: goalFingerprint(inspection.goal), stoppedTurnId: inspection.stoppedTurnId,
      }, { timeoutMs: 30_000 });
    },
  };
}
