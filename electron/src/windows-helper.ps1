# Long-running helper for DeskPet on Windows: every 2 seconds prints one JSON line with
# the process list (pid, parent, CPU seconds, name), command lines of possible agent CLIs,
# and the foreground app.
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Namespace DeskPet -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
'@
$agents = '^(claude|codex|kiro-cli|kiro-cli-chat|qchat|q|gemini|cursor-agent|goose|opencode|aider|amp|node)\.exe$'
while ($true) {
  $list = New-Object System.Collections.Generic.List[object]
  $cmd = @{}
  foreach ($p in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,KernelModeTime,UserModeTime,CommandLine) {
    $cpu = ([double]$p.KernelModeTime + [double]$p.UserModeTime) / 1e7
    $list.Add(@($p.ProcessId, $p.ParentProcessId, $cpu, $p.Name))
    if ($p.Name -match $agents) { $cmd["$($p.ProcessId)"] = $p.CommandLine }
  }
  $fgPid = [uint32]0
  [void][DeskPet.Win]::GetWindowThreadProcessId([DeskPet.Win]::GetForegroundWindow(), [ref]$fgPid)
  $fg = (Get-Process -Id $fgPid).ProcessName
  [Console]::Out.WriteLine((@{ p = $list; c = $cmd; fg = $fg } | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 2000
}
