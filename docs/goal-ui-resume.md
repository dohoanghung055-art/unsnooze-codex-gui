# Temporary native Goal resume on Windows

This opt-in fallback uses Windows UI Automation to invoke the native **Resume goal** button. It keeps Desktop's bundled launcher, existing writer, model, permissions, objective, budget and accounting. It does not use the withdrawn launcher bridge. The API gateway experiment remains deferred and is not started by this feature.

Available on `main`; the immutable `20261028` release does not contain it. Install this source revision, restart the Unsnooze daemon, and enable:

```powershell
unsnooze.cmd config set goalUiResume true
```

Disable with `unsnooze.cmd config set goalUiResume false`. Configuration is read dynamically; changes do not cancel an action already in flight. The first deployment of this code requires restarting the old daemon. No Desktop restart or `CODEX_CLI_PATH` override is needed.

## What happens

1. The ordinary daemon timer must find a due, confirmed usage-limit stop in the latest native turn. Completed work, user cancellation and unrelated errors do not qualify.
2. Read `thread_goals` from the local Codex Goal database using a read-only connection. Only `usage_limited`, valid accounting, a unique objective and remaining budget qualify. Manual paused, blocked, completed and budget-limited states remain untouched.
3. Wait until Windows is unlocked and physical keyboard/mouse input has been idle for at least 60 seconds. Wake the display once if needed; no persistent power settings are changed and Windows is never unlocked automatically. A sleeping computer must first wake normally.
4. Navigate through Desktop's existing app-tools endpoint to the exact chat. Bind the UI window to that pipe's server process. Require the exact chat title, a unique enabled Resume goal button and its matching usage-limited objective in the same row. Duplicate objectives across chats wait for manual handling.
5. Persist the ordinary Unsnooze delivery claim. Immediately before invoking, re-read the native turn and Goal fingerprint, recheck budget/reset time and verify no physical input changed. Invoke through the accessibility pattern, without coordinates, typing or clipboard use. Do not also send the ordinary wake prompt.
6. Verify the Goal state and a new turn from Desktop's existing writer. Activation alone is insufficient. A definite refusal before invocation can wait and retry; an uncertain outcome is verification-only and never blindly clicked again.

The fallback temporarily brings Codex to the foreground and changes its selected chat. If you are interacting with the computer, it waits. English accessibility labels and the observed Desktop Goal layout are currently required; UI changes or ambiguous state cause a wait instead of guessing. This is a temporary integration, not a guarantee against all Desktop regressions.

A stale usage-limited Goal left behind by an earlier ordinary prompt may coexist with a completed latest turn. The automatic path deliberately does not restart that completed turn; recover that Goal once using its native Resume control after checking the task. Future confirmed quota stops use the new path.

## Verification

Validated on native Windows with Node 24 and Desktop 26.1023.6123.0. Focused tests cover read-only database access, duplicate objectives, pause/budget/identity changes, native turn progress, idle gating, durable claims, definite non-invocation and uncertain outcomes. A separate local WPF fixture verified a real UI Automation InvokePattern call reached its test button exactly once. An explicitly requested one-time recovery then invoked the real Desktop Goal control: the Goal changed from usage-limited to active and Desktop started a new turn; its budget and accumulated accounting were preserved. That stale Goal had survived an earlier ordinary wake prompt, so the one-time recovery was separate from the daemon's stricter latest-turn quota guard. These tests do not simulate an actual future OpenAI quota reset.

```powershell
node --test test/goal-ui.test.js test/codex-desktop.test.js test/codex-desktop-resumer.test.js test/codex-goals.test.js test/settings.test.js
```
