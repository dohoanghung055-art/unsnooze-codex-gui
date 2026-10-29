// Temporary Windows transport. Reads are SQLite read-only; all mutations go
// through the native Desktop Resume goal button and its existing writer.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { CODEX_DIR } from './config.js';
import { desktopClient, desktopDecision } from './codex-desktop.js';
import { goalFingerprint, resumableGoal } from './codex-goals.js';

const helper = fileURLToPath(new URL('../scripts/goal-ui.ps1', import.meta.url));
export const uiGoalStamp = goal => createHash('sha256').update(
  JSON.stringify([goal?.goalId, goalFingerprint(goal)])).digest('hex');

export async function readUiGoal(rec, { database = join(CODEX_DIR, 'goals_1.sqlite') } = {}) {
  if (!existsSync(database)) return { available: true, goal: null };
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const row = db.prepare('SELECT * FROM thread_goals WHERE thread_id = ?').get(rec.sessionId);
    if (!row) return { available: true, goal: null };
    const goal = { threadId: row.thread_id, goalId: row.goal_id, objective: row.objective,
      status: ({ usage_limited: 'usageLimited', budget_limited: 'budgetLimited' })[row.status] || row.status,
      tokenBudget: row.token_budget, tokensUsed: row.tokens_used, timeUsedSeconds: row.time_used_seconds,
      createdAt: row.created_at_ms, updatedAt: row.updated_at_ms };
    // Identical objectives in different chats cannot be distinguished by UIA.
    const { count } = db.prepare('SELECT COUNT(*) AS count FROM thread_goals WHERE objective = ?').get(goal.objective);
    return { available: true, goal, uniqueObjective: count === 1, transport: 'ui' };
  } finally { db.close(); }
}

export function runGoalUi(input) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', helper],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => child.kill(), 25_000);
    child.stdout.on('data', b => { output += b; if (output.length > 64_000) child.kill(); });
    child.stderr.resume();
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw new Error('Windows Goal helper did not return a receipt');
        resolve(JSON.parse(output));
      } catch (error) { reject(error); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input) + '\n');
  });
}

export async function checkUiGoal(input, { readGoal = readUiGoal, desktop = desktopClient } = {}) {
  const inspection = await readGoal({ sessionId: input.threadId });
  if (!inspection.uniqueObjective || !resumableGoal(inspection.goal, input.threadId)
    || uiGoalStamp(inspection.goal) !== input.goalStamp) throw new Error('Goal changed or is ineligible');
  const snapshot = await desktop.read({ sessionId: input.threadId });
  if (snapshot.title !== input.title || snapshot.turn?.id !== input.stoppedTurnId
    || desktopDecision(snapshot, 0) !== 'wake') throw new Error('Desktop turn changed or is no longer quota-stopped');
  if (!Number.isFinite(input.resetAt) || input.resetAt > Date.now()) throw new Error('Reset is not due');
  return true;
}

export function createGoalUiClient({ desktop = desktopClient, readGoal = readUiGoal, run = runGoalUi } = {}) {
  const prepared = new Map();
  return {
    read: readGoal,
    async prepare(rec, inspection) {
      prepared.delete(rec.sessionId);
      if (!inspection.uniqueObjective || !resumableGoal(inspection.goal, rec.sessionId)) {
        throw new Error('A unique quota-limited Goal is required');
      }
      const before = await desktop.read(rec);
      if (!before.title || desktopDecision(before, 0) !== 'wake') throw new Error('No quota-stopped Desktop turn');
      // Read-only metadata can be slow; check physical input AFTER that read,
      // immediately before navigation can change the selected Desktop chat.
      const env = await run({ action: 'environment' });
      if (!env.ok) throw new Error(env.reason);
      await desktop.navigate(rec);
      const input = { action: 'inspect', pipe: await desktop.endpoint(), title: before.title,
        objective: inspection.goal.objective, threadId: rec.sessionId, stoppedTurnId: before.turn.id,
        goalStamp: uiGoalStamp(inspection.goal), resetAt: rec.resetAt,
        node: process.execPath, checker: fileURLToPath(new URL('../scripts/goal-ui-check.mjs', import.meta.url)),
        inputTick: env.inputTick };
      const receipt = await run(input);
      if (!receipt.ok) throw new Error(receipt.reason);
      await checkUiGoal(input, { desktop, readGoal });
      prepared.set(rec.sessionId, { ...input, inputTick: receipt.inputTick, preparedAt: Date.now() });
    },
    async resume(rec, inspection) {
      const input = prepared.get(rec.sessionId);
      prepared.delete(rec.sessionId);
      if (!input || Date.now() - input.preparedAt > 15_000 || inspection.stoppedTurnId !== input.stoppedTurnId
        || uiGoalStamp(inspection.goal) !== input.goalStamp) {
        throw Object.assign(new Error('Goal UI preparation expired'), { notAttempted: true });
      }
      const receipt = await run({ ...input, action: 'invoke' });
      if (!receipt.ok || receipt.attempted !== true) throw Object.assign(new Error(receipt.reason || 'Goal UI outcome unknown'),
        { notAttempted: receipt.attempted === false });
      return receipt;
    },
  };
}
