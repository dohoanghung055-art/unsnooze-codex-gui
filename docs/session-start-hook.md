# Optional local SessionStart hook

The hook ensures that the installed Unsnooze on-demand daemon is running when a local Codex/Work session starts or resumes. It does not open a dashboard, submit a prompt, grant permissions, or trust itself.

From a clone of this repository, after installing Unsnooze:

```powershell
node .\scripts\install-session-hook.mjs
```

The installer finds the global npm package, copies the hook to the user's Codex hooks directory, and merges a `SessionStart` group into `hooks.json`. It preserves other groups, backs up changed files, supports custom global npm prefixes, and does not add duplicate registrations on repeated runs. Existing mixed handler groups are held for inspection instead of being replaced.

Review the command and Trust **Ensuring Unsnooze daemon is running** through Codex CLI `/hooks`. The runtime skips an untrusted hook. See [OpenAI's hook trust documentation](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).

The matcher is `^(startup|resume|clear|fork)$`. The helper uses the installed package's PID heartbeat, on-demand marker, environment handling and daemon singleton mechanism. Its child process uses `windowsHide: true`. If Unsnooze is absent or has been uninstalled, it does not reinstall it.

The log is `~/.unsnooze/session-start-hook.log`; stdout stays empty to avoid injecting developer instructions. A helper failure does not block the session.

## Verification

- The installed local helper passed direct cold-start and repeated-start tests with isolated state and disabled watchers. The isolated daemon was stopped afterward; the primary daemon was unchanged.
- The portable installer has 3 focused tests: preserving unrelated hooks and idempotent installation; preserving malformed configuration without partial writes; and resolving an explicit package path without stdout context.
- Direct representative event invocation is not a real session lifecycle test. The developer's configured hook was still reported as `untrusted` at validation time, so automatic lifecycle execution awaits user review.

## Remove

Remove only the `SessionStart` group whose handler points to `unsnooze-session-start.cjs` from the user's `hooks.json`. Preserve other hook groups. Backups are stored beside the installed hook. This does not uninstall Unsnooze or alter existing chats.
