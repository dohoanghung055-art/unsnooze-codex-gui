# Native UI Automation only. No coordinates, typing, clipboard, registry or DB writes.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$attempted = $false
try {
  $request = [Console]::In.ReadLine() | ConvertFrom-Json
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.IO.Pipes;
using System.Diagnostics;
public static class GoalUiNative {
 [StructLayout(LayoutKind.Sequential)] public struct LastInput { public uint size; public uint time; }
 [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LastInput info);
 [DllImport("kernel32.dll")] public static extern uint GetTickCount();
 [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);
 [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
 [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder value,int length,out int needed);
 [DllImport("wtsapi32.dll")] public static extern bool WTSQuerySessionInformation(IntPtr server,int session,int kind,out IntPtr buffer,out int length);
 [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr buffer);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetNamedPipeServerProcessId(IntPtr pipe,out uint process);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window,int command);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 public static uint InputTick() { var info=new LastInput();info.size=(uint)Marshal.SizeOf(info);if(!GetLastInputInfo(ref info))throw new Exception("Cannot read input state");return info.time; }
 public static uint IdleMs() { return unchecked(GetTickCount()-InputTick()); }
 public static bool Unlocked() {
   IntPtr buffer; int length;
   if(!WTSQuerySessionInformation(IntPtr.Zero,Process.GetCurrentProcess().SessionId,25,out buffer,out length))return false;
   try { if(length<20 || Marshal.ReadInt32(buffer,0)!=1 || Marshal.ReadInt32(buffer,12)!=0 || Marshal.ReadInt32(buffer,16)!=1)return false; }
   finally { WTSFreeMemory(buffer); }
   var desktop=OpenInputDesktop(0,false,1);if(desktop==IntPtr.Zero)return false;
   try { var name=new StringBuilder(256);int needed;return GetUserObjectInformation(desktop,2,name,512,out needed) && name.ToString()=="Default"; }
   finally { CloseDesktop(desktop); }
 }
 public static uint PipeOwner(string name) {
   const string prefix=@"\\.\pipe\";
   if(!name.StartsWith(prefix) || !name.Substring(prefix.Length).StartsWith("codex-app-tools-"))throw new Exception("Unexpected Desktop endpoint");
   using(var pipe=new NamedPipeClientStream(".",name.Substring(prefix.Length),PipeDirection.InOut)) {
     pipe.Connect(2000);uint process;if(!GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out process))throw new Exception("Cannot identify Desktop owner");return process;
   }
 }
}
'@
  function Assert-Idle {
    if (-not [GoalUiNative]::Unlocked()) { throw 'Windows is locked or session state is unavailable' }
    if ([GoalUiNative]::IdleMs() -lt 60000) { throw 'Waiting for 60 seconds without user input' }
    if ($null -ne $request.inputTick -and [uint32]$request.inputTick -ne [GoalUiNative]::InputTick()) { throw 'User input changed during preparation' }
  }
  Assert-Idle
  # One-shot display wake, never ES_CONTINUOUS: no persistent power changes.
  $null = [GoalUiNative]::SetThreadExecutionState(3)
  if ($request.action -eq 'environment') {
    @{ok=$true;attempted=$false;inputTick=[GoalUiNative]::InputTick()} | ConvertTo-Json -Compress
    exit 0
  }
  if ($request.action -notin @('inspect','invoke')) { throw 'Unknown UI action' }
  $ownerId = [GoalUiNative]::PipeOwner($request.pipe)
  $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty,[int]$ownerId)
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$condition)
  if ($windows.Count -ne 1) { throw ('A unique native Desktop window is unavailable (found ' + $windows.Count + ', owner ' + $ownerId + ')') }
  $window = $windows[0]
  $handle = [IntPtr]$window.Current.NativeWindowHandle
  Assert-Idle
  $null = [GoalUiNative]::ShowWindow($handle,9)
  $null = [GoalUiNative]::SetForegroundWindow($handle)
  Start-Sleep -Milliseconds 250
  function Find-Resume {
    Assert-Idle
    if ([GoalUiNative]::GetForegroundWindow() -ne $handle) { throw 'Desktop is not the foreground window' }
    $docs = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,'RootWebArea')))
    if ($docs.Count -ne 1 -or $docs[0].Current.Name -cne $request.title) { throw 'The exact target chat is not visible' }
    $buttons = $docs[0].FindAll([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button)))
    $resume = @($buttons | Where-Object { $_.Current.Name -ceq 'Resume goal' })
    if ($resume.Count -ne 1 -or -not $resume[0].Current.IsEnabled) { throw 'A unique enabled Resume goal button is unavailable' }
    $row = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($resume[0])
    $children = $row.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
    $prefix = 'Goal usage limited ' + $request.objective + ' '
    $summary = @($children | Where-Object {
      $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
      $_.Current.Name.StartsWith($prefix,[System.StringComparison]::Ordinal) -and
      $_.Current.Name.Substring($prefix.Length) -match '^(?:\d+[dhms](?:\s+|$))+$'
    })
    if ($summary.Count -ne 1) { throw 'The matching usage-limited Goal row is unavailable' }
    return $resume[0]
  }
  $button = Find-Resume
  if ($request.action -eq 'invoke') {
    # Fresh native thread + read-only Goal check immediately before UI action.
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $request.node
    $start.Arguments = '"' + $request.checker + '"'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $check = [System.Diagnostics.Process]::Start($start)
    $check.StandardInput.WriteLine(($request | ConvertTo-Json -Compress -Depth 8))
    $check.StandardInput.Close()
    if (-not $check.WaitForExit(12000)) { $check.Kill(); throw 'Fresh Goal check timed out' }
    if ($check.ExitCode -ne 0 -or ($check.StandardOutput.ReadToEnd() | ConvertFrom-Json).ok -ne $true) { throw 'Goal or Desktop turn changed before invocation' }
    $button = Find-Resume
    $pattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    Assert-Idle
    # Receipt becomes uncertain BEFORE invoking. Never retry lost acknowledgements.
    $attempted = $true
    $pattern.Invoke()
  }
  @{ok=$true;attempted=$attempted;inputTick=[GoalUiNative]::InputTick();ownerPid=$ownerId} | ConvertTo-Json -Compress
} catch {
  @{ok=$false;attempted=$attempted;reason=$_.Exception.Message} | ConvertTo-Json -Compress
}
