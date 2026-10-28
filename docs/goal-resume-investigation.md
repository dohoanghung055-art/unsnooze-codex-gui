# Goal continuation after a quota reset

Investigated on 2026-10-28. This document records the original investigation. A subsequent owner bridge was implemented, but activation was withdrawn after a missing Desktop runtime companion failure; see [current status, rollback and verification limits](goal-resume.md). Waking a chat and restoring Goal continuation are different operations.

## What users can do now

Use the Goal progress row's **Resume** control in the desktop app, or `/goal resume` in Codex CLI. OpenAI documents these lifecycle controls in [Long-running work](https://learn.chatgpt.com/docs/long-running-work) and [Using Goals in Codex](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex).

A normal continuation prompt can produce another answer. Goal continuation additionally depends on the persistent Goal status, budgets, thread idleness and other dispatcher conditions. A new answer alone is therefore not proof that the Goal loop is active again.

## Evidence

1. The installed Codex build inspected was `0.164.0-alpha.11.1`. Its generated app-server schema provides `thread/goal/get` and `thread/goal/set`. Statuses include `active`, `paused`, `blocked`, `usageLimited`, `budgetLimited` and `complete`. Mutation provenance distinguishes `user` from `automatic`; an automatic integration must not pretend to be a user action.
2. The native app-tools endpoint used by this Unsnooze fork advertises no Goal-management tools. The current client uses `read_thread` and `send_message_to_thread`; it does not issue Goal status mutations or verify Goal state.
3. Read-only inspection of the local Goal store found the relevant existing Goal active at investigation time. No paused-by-quota case was reproduced in this session. No Goal objective, status, budget or accounting value was changed during this investigation.
4. OpenAI's public source was inspected at commit `26ad281fd1ca712e4f0c7920a6273cf18c961b8a`, separately from the installed binary. In [Goal runtime restoration](https://github.com/openai/codex/blob/26ad281fd1ca712e4f0c7920a6273cf18c961b8a/codex-rs/ext/goal/src/runtime.rs#L412), restoration activates runtime accounting for an already-active persisted Goal; other statuses clear active accounting. [External Goal updates](https://github.com/openai/codex/blob/26ad281fd1ca712e4f0c7920a6273cf18c961b8a/codex-rs/ext/goal/src/runtime.rs#L225) can trigger continuation when the resulting state is active. The [app-server Goal processor](https://github.com/openai/codex/blob/26ad281fd1ca712e4f0c7920a6273cf18c961b8a/codex-rs/app-server/src/request_processors/thread_goal_processor.rs#L133) coordinates state changes with the loaded thread and listener. This source is supporting evidence, not proof that every installed build behaves identically.

These findings are consistent with a chat waking while its Goal continuation remains off. They do not establish that this explains every short resumed turn; a genuine task blocker or another stopping condition can also end work.

## Proposed integration boundary

A future implementation needs a supported Goal-control path to the **same Desktop owner** that holds the thread. The currently used app-tools catalog does not expose that capability. Do not work around it by opening a competing CLI writer, changing SQLite rows, or merely sending `/goal resume` as ordinary prompt text and assuming a command was executed.

Once that owner-backed capability is available, a narrow implementation should:

- Re-read the same thread and existing Goal after a confirmed quota stop/reset.
- Resume only `usageLimited` Goals. Leave manual `paused`, `blocked`, `complete` and `budgetLimited` states unchanged.
- Preserve objective, identity, token budget and usage accounting; hold if identity or state changed during inspection.
- Use honest automatic provenance, persist a delivery claim, and verify both active Goal state and resumed execution.
- Avoid sending the normal wake prompt as a second action if activating the Goal already starts an idle turn.
- Treat uncertain outcomes as verification-only, rather than retrying blindly.

No automatic Goal-resume feature was enabled or claimed verified by the original investigation. The subsequent implementation is opt-in and has not been verified against a real quota reset; use the app's Resume control until the bridge has been installed and activated.
