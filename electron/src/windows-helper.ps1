# Long-running helper for DeskPet on Windows: every 2 seconds prints one JSON line with
# the process list (pid, parent, CPU seconds, name), command lines of possible agent CLIs,
# and the foreground app.
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Namespace DeskPet -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int max);
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
  $fgWindow = [DeskPet.Win]::GetForegroundWindow()
  [void][DeskPet.Win]::GetWindowThreadProcessId($fgWindow, [ref]$fgPid)
  $titleBuffer = New-Object System.Text.StringBuilder 512
  [void][DeskPet.Win]::GetWindowText($fgWindow, $titleBuffer, 512)
  $fg = (Get-Process -Id $fgPid).ProcessName
  # Microphone/camera in use by any app (for quiet mode): Windows records LastUsedTimeStop = 0 while in use.
  $inUse = @{}
  foreach ($cap in 'microphone', 'webcam') {
    $inUse[$cap] = $false
    $root = "HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\$cap"
    foreach ($key in Get-ChildItem $root -Recurse) {
      $stop = (Get-ItemProperty -Path $key.PSPath -Name LastUsedTimeStop).LastUsedTimeStop
      if ($stop -ne $null -and $stop -eq 0) { $inUse[$cap] = $true; break }
    }
  }
  [Console]::Out.WriteLine((@{ p = $list; c = $cmd; fg = $fg; fgPid = $fgPid; fgTitle = $titleBuffer.ToString(); mic = $inUse.microphone; cam = $inUse.webcam } | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 2000
}
