param([switch]$Enable)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'Windows is required.' }
# Compile with Windows PowerShell's Framework compiler (no SDK/download needed).
if ($PSVersionTable.PSEdition -eq 'Core') { throw 'Run this installer with powershell.exe (Windows PowerShell).' }
$bridgeScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'codex-goal-bridge.mjs')).Path
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$codexHomePath = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$installFolder = Join-Path $codexHomePath 'unsnooze-goal-bridge'
$existingOverride = [Environment]::GetEnvironmentVariable('CODEX_CLI_PATH', 'User')
$launcherPath = Join-Path $installFolder 'codex-goal-bridge.exe'
if ($existingOverride -and $existingOverride -ne $launcherPath) { throw 'An existing CODEX_CLI_PATH override must be reviewed before installing this bridge.' }
if ($env:CODEX_CLI_PATH -and $env:CODEX_CLI_PATH -ne $launcherPath) { throw 'The current process already has a different CODEX_CLI_PATH override.' }
New-Item -ItemType Directory -Path $installFolder -Force | Out-Null
# Never replace a running or pre-existing launcher. Builds are reproducible.
if (Test-Path -LiteralPath $launcherPath) { throw 'Bridge already exists. Keep the existing installation; do not overwrite a running launcher.' }
$nodeLiteral = $nodePath.Replace('"', '""')
$scriptLiteral = $bridgeScript.Replace('"', '""')
$source = @"
using System;
using System.Diagnostics;
using System.Text;
public static class UnsnoozeLauncher {
  static string Quote(string value) {
    var s = new StringBuilder("\""); int slashes = 0;
    foreach (char ch in value) {
      if (ch == '\\') { slashes++; continue; }
      if (ch == '"') { s.Append('\\', slashes * 2 + 1); s.Append(ch); slashes = 0; continue; }
      s.Append('\\', slashes); slashes = 0; s.Append(ch);
    }
    s.Append('\\', slashes * 2); s.Append('"'); return s.ToString();
  }
  public static int Main(string[] args) {
    var arguments = new StringBuilder(Quote(@"$scriptLiteral"));
    foreach (string arg in args) arguments.Append(" ").Append(Quote(arg));
    var info = new ProcessStartInfo(@"$nodeLiteral", arguments.ToString());
    info.UseShellExecute = false;
    using (var child = Process.Start(info)) { child.WaitForExit(); return child.ExitCode; }
  }
}
"@
Add-Type -TypeDefinition $source -OutputAssembly $launcherPath -OutputType ConsoleApplication
& $launcherPath --version
if ($LASTEXITCODE -ne 0) { throw 'Launcher verification failed; CODEX_CLI_PATH was not changed.' }
if ($Enable) {
  @{ previousUserOverride = $existingOverride; installedLauncher = $launcherPath } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $installFolder 'installation.json') -Encoding UTF8
  [Environment]::SetEnvironmentVariable('CODEX_CLI_PATH', $launcherPath, 'User')
  Write-Output 'Enabled for newly started apps. Finish active work, then fully close and reopen Codex Desktop. If Windows keeps the old environment, sign out/in.'
} else {
  Write-Output 'Launcher verified. To enable for one Desktop launch, set CODEX_CLI_PATH to the launcher path in that launching process.'
}
Write-Output $launcherPath
