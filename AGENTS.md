# Working on this fork

- Primary scope: Windows Codex Desktop / Work local resumption. Preserve the existing Desktop writer, thread settings, permissions and duplicate-delivery protections.
- Keep private config, credentials, state files, logs, real chat identities and local machine paths out of commits. Keep upstream attribution and MIT licensing.
- After a substantive change, update the relevant documentation and run the focused checks. Commit completed changes. When Henry asks to publish/update GitHub, push the commit and verify the remote SHA before reporting completion; do not infer authorization for future publications from an older task.
- Keep published release assets immutable. Distinguish changes on `main` from the contents of an earlier release; create a new release/version when publishing a new installable build.
- The production installation may use a separate pinned checkout. Do not silently replace it with this repository.
- Do not self-trust hooks, bypass required reviews, override manually paused/blocked/completed Goals, reset budgets, or mutate Codex's SQLite state as a resume shortcut.
