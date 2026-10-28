# Automatic Goal resume (experimental, opt-in)

**Activation withdrawn on 2026-10-28.** A Desktop session failed to spawn `codex-code-mode-host.exe` after the custom launcher rollout. The ordinary launcher subsequently restored working command execution. The full cause has not been reproduced in isolation, but the bridge's runtime discovery checked only `codex.exe`, and the installer's `--version` smoke test could not detect missing runtime companions. Automatic `-Enable` now fails before compilation, file creation or environment changes. Do not set `CODEX_CLI_PATH` manually to bypass this restriction. Use the native Goal Resume control.

The validation defect has since been reproduced and fixed: diagnostic builds check all companion helpers and a real local code-mode host handshake. This still does not validate Desktop lifecycle compatibility, so activation remains blocked. See [reproduction evidence and remaining limits](goal-runtime-investigation.md).

Available in source on `main`. The earlier `20261028` release assets do **not** include this feature. This is a separate owner bridge, not an upgrade to the ordinary wake prompt.

## Behavior

After Unsnooze's existing reset timer finds a confirmed usage-limit stop, it inspects the Goal through the same backend that Desktop owns. An existing `usageLimited` Goal with remaining budget can be activated with `origin: automatic`. The request changes only status; it omits objective and budget. Unsnooze claims the episode before delivery and verifies both Goal state and a new turn. It does not also send its normal continuation prompt.

Manual `paused`, `blocked`, `complete`, `budgetLimited`, exhausted budgets, changed Goals and busy threads are held. A lost acknowledgement becomes verification-only. A changed Goal or manual pause during verification is held. Activation without a new turn is not reported as successful.

## Why a bridge is needed

The app-tools endpoint currently used for Desktop wakeups has no Goal-control tool. This opt-in launcher forwards Desktop's stdio to one real bundled Codex app-server, and exposes a narrow local Windows named pipe for `goal/read` and guarded `goal/resume`. It creates no competing writer, opens no TCP listener and changes no SQLite rows. Requests require loaded-thread ownership, an unchanged Goal snapshot, an idle thread and the same latest usage-limited turn.

Desktop Goal edits are serialized with automatic activation. A Pause observed before activation cancels it; a Pause arriving after the activation write is forwarded afterwards, so the user's final state wins. Unsupported external writers editing the same Goal outside this connection are not protected by a server-side compare-and-set: the upstream API does not expose one. Do not run a second writer on that thread.

## Ordinary Unsnooze installation on Windows

Use Node.js 22+ and Windows PowerShell 5.1 (`powershell.exe`). Keep this checkout at a stable path:

```powershell
git clone https://github.com/dohoanghung055-art/unsnooze-codex-gui.git
Set-Location .\unsnooze-codex-gui
npm.cmd ci
npm.cmd install --global .
```

This installs ordinary Unsnooze without changing Desktop's launcher. The experimental installer refuses `-Enable`. Without that flag it can still build a local diagnostic executable after the runtime preflight, but this is not an activation path. Use `node .\scripts\codex-goal-bridge.mjs --check-runtime` to inspect local host readiness; a successful result still reports Desktop compatibility as unverified.

Restart the Unsnooze daemon after updating its source. The existing SessionStart hook can ensure it starts, after its ordinary trust review. Do not change or restart Desktop solely to activate the withdrawn Goal bridge.

**Compatibility:** tested against bundled Codex `0.164.0-alpha.11.1`. This uses Desktop's custom CLI override, an experimental integration boundary that can change. Desktop may handle its bundled sandbox service differently for a custom executable; verify your existing permission profile in the reopened app before unattended use. The adapter itself forwards launch arguments and thread settings and does not lower permissions or approvals. No automatic installer run or restart is performed merely by updating Unsnooze.

For a local installation already pinned to a separate checkout, review deployment to that checkout explicitly; `git pull` here alone does not update that running installation.

## Disable / recover

Close Desktop first. Remove only the override installed by this feature:

```powershell
$goalHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$goalLauncher = Join-Path $goalHome 'unsnooze-goal-bridge\codex-goal-bridge.exe'
if ([Environment]::GetEnvironmentVariable('CODEX_CLI_PATH', 'User') -eq $goalLauncher) {
  [Environment]::SetEnvironmentVariable('CODEX_CLI_PATH', $null, 'User')
}
```

Reopen Desktop with a refreshed environment to use its normal bundled launcher. No chat or Goal data needs deletion. Without a bridge, ordinary Desktop wakeups continue as before; Goal activation is unavailable. If a bridge exists but ownership cannot be verified, Unsnooze waits instead of guessing.

## Verification and limits

Run `node --test`. Regression coverage includes automatic provenance and accounting preservation, paused/blocked/complete/budget states, Goal/turn changes, concurrent Pause, ambiguous ownership, delivery loss, duplicate suppression and verifying Goal plus execution together.

A separate Windows smoke test compiled the launcher, forwarded initialization to the real bundled app-server in an isolated Codex home, read a Goal for a loaded scratch thread and rejected an unowned thread. It started no model turn and mutated no Goal. No actual quota reset or live Desktop Goal activation has been reproduced yet. Passing these checks does not establish compatibility with future Desktop versions or prove that every short resumed session was caused by Goal status.
