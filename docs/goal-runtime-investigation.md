# Goal bridge runtime incident: reproduction and remaining limits

Investigated on 2026-10-28. Automatic Desktop bridge activation remains **disabled**.

## What is established

- The incident reported failure to spawn `codex-code-mode-host.exe` from the selected runtime directory. After restoring the native launcher, Desktop command execution worked again with a different installed runtime directory containing the helper.
- The bridge selected a CLI by file modification time. Its installer tested only `--version`; neither check established that the accompanying runtime was complete or that Desktop integration worked.
- A regression now reproduces the validation defect with the real installed CLI. In an isolated directory, a hard link to `codex.exe` prints its version successfully even though all companion helpers are absent. The new preflight rejects that layout before launching a backend.
- The preflight requires the CLI, code-mode host, command runner and sandbox setup executable in the same runtime directory. It then performs a real, framed code-mode host readiness handshake with no tools or model turn. Timeouts, process failures, malformed replies and unsupported protocol responses fail closed.
- A separate isolated Windows probe exercised the compiled launcher, proxy, real app-server, a read-only command and the real code-mode host handshake. It also modeled the custom-launch environment by omitting the registered-core and sandbox-package variables. It created no thread, changed no Goal, copied no credentials and changed no Desktop configuration.
- The current native app-tools catalog was rechecked: it exposes thread reading and messaging, but no Goal-management tool.

## What this does not establish

The original incomplete runtime directory was no longer available for comparison. The exact event that removed or failed to provision its helper has not been reproduced. We cannot attribute it conclusively to an app update, cleanup, runtime selection or another cause.

The inspected Desktop startup implementation treats custom executables differently, including registered-core and sandbox context. A local host handshake and one isolated command are not proof of compatibility with that lifecycle, runtime replacement during updates, or real Goal continuation after a quota reset. The preflight is a point-in-time diagnostic; it cannot prevent a helper from disappearing later.

## Resulting change

`install-goal-bridge.ps1 -Enable` stays blocked before any installation or environment mutation. Diagnostic builds and experimental app-server launches now use the runtime preflight. The CLI's `--check-runtime` result explicitly says `desktopCompatible: unverified`; a passed readiness check is never treated as permission to activate Desktop integration.

Ordinary Unsnooze Desktop wakeups keep the native writer and settings. Use the native Goal Resume control until there is a verified owner-backed Goal path. Do not restore the withdrawn `CODEX_CLI_PATH` override or copy binaries into a live runtime as a workaround.

## Reproduce the checks

```powershell
node --test
node .\scripts\codex-goal-bridge.mjs --check-runtime
```

The real-binary regression tests run on Windows when a bundled Codex runtime is installed. Their synthetic incomplete directory is removed after the check; the actual installation is not modified. The isolated command probe was performed separately and is supporting evidence, not an automated claim about Desktop UI compatibility.
