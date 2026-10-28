# Missing capability for safe unattended Goal resume

Status: **proposal only; these tools do not exist in the inspected Desktop build.** No upstream issue or external request has been submitted.

## Verified integration boundary

On 2026-10-28, Windows Desktop `26.1023.6123.0` exposed 55 app-tools catalog entries. It provided thread reading and messaging, but no Goal-management or arbitrary app-server request tool. Its inspected inter-window IPC method registry included ownership, turn control, settings, approvals and queued messages, but no Goal-control method. The native local backend remained a stdio app-server.

The app's own Goal Resume action can call `thread/goal/set` inside the owning Desktop connection. Unsnooze cannot access that connection through the inspected external interfaces. A standalone app-server having the same method does not give it ownership of Desktop's running thread.

This blocks **automatic Goal activation through the existing APIs**, rather than ordinary chat wakeups. The withdrawn launcher proxy changes that boundary and has not established safe compatibility across Desktop runtime updates. It remains disabled.

## Proposed native app-tools additions

These need implementation by the Desktop/app-tools owner, on the existing authenticated local connection. Adding an unrelated MCP server alone cannot supply that ownership.

1. `read_thread_goal`: return the stable thread identity, Goal status, an opaque Goal revision, remaining budget/accounting metadata and latest turn identity. Goal absence is an explicit result. Do not infer Goal state from conversation text.
2. `resume_thread_goal`: accept `threadId`, `expectedGoalRevision`, `expectedStoppedTurnId` and an `idempotencyKey`. Under the owner's Goal/turn lifecycle lock, compare the revision and latest turn, verify `usageLimited`, remaining budget and idleness, then activate with automatic provenance. Preserve objective, identity, budgets and counters. Do not acquire ownership by starting or resuming another writer.

Return a structured receipt: `applied`, `already_active` or `held`, with the reason and current metadata. Manual pause, blocked/complete/budget-limited state, a changed Goal, an unrelated stop, an active turn or unverified ownership must produce no mutation. A duplicate idempotency key must return its previous receipt without reactivating a Goal that was subsequently paused.

Goal activation should schedule continuation once through the native lifecycle. Unsnooze must not also send its normal wake prompt. A receipt alone is insufficient: Unsnooze must read back both Goal state and execution evidence, and treat a lost acknowledgement as verification-only.

## Acceptance before enabling Unsnooze

- Both tools appear in the actual Desktop capability catalog and operate on the already-loaded owner.
- A real usage-limited Goal resumes through that owner after quota reset; budgets and accounting remain intact.
- Pause arriving before activation prevents it; Pause arriving afterwards wins and remains paused on duplicate delivery.
- Disconnect/restart cannot cause a duplicate continuation.
- Native launcher, permission profiles and runtime-update behavior are retained without `CODEX_CLI_PATH` changes or SQLite writes.

Until that capability is available and verified, use the native Goal Resume control. Repeating a continuation prompt is not an equivalent implementation: it cannot prove native Goal continuation or its accounting is active.
