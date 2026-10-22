# Claude Code hook for DeskPet on Windows: records the session's latest event in
# %USERPROFILE%\.deskpet\sessions\<agent>-<session>.json. Must stay silent and always exit 0
# (stdout from some hooks is fed back to the agent).
param([string]$Agent = "claude", [string]$Event = "")
$ErrorActionPreference = 'SilentlyContinue'

$raw = [Console]::In.ReadToEnd()
try { $payload = $raw | ConvertFrom-Json } catch { exit 0 }
$hookEvent = [string]$payload.hook_event_name
# Kiro passes the event on the command line in case its hook input doesn't name it.
if (-not $hookEvent) { $hookEvent = $Event }
if (-not $hookEvent) { exit 0 }
$hookEvent = $hookEvent.Substring(0, 1).ToUpper() + $hookEvent.Substring(1)

$dir = Join-Path $env:USERPROFILE ".deskpet\sessions"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$sid = if ($payload.session_id) { [string]$payload.session_id } else { "pid$PID" }
$safe = $sid -replace '[^A-Za-z0-9-]', ''
$file = Join-Path $dir "$Agent-$safe.json"

if ($hookEvent -eq 'SessionEnd') { Remove-Item -Force $file; exit 0 }

$previous = $null
if (Test-Path $file) { try { $previous = Get-Content -Raw $file | ConvertFrom-Json } catch {} }

# Find the agent process that ran this hook (cached after the first event of a session),
# so the pet can match hook state to a live process and notice crashed sessions.
$agentPid = 0
if ($previous -and $previous.pid -and (Get-Process -Id ([int]$previous.pid))) {
  $agentPid = [int]$previous.pid
} else {
  $cur = $PID
  for ($i = 0; $i -lt 8 -and $cur -gt 0; $i++) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -Property ProcessId,ParentProcessId,Name,CommandLine
    if (-not $proc) { break }
    if ($proc.Name -like "$Agent*" -or ($proc.Name -eq 'node.exe' -and $proc.CommandLine -like '*claude-code*')) { $agentPid = [int]$cur; break }
    $cur = [int]$proc.ParentProcessId
  }
}

$subagents = 0
if ($previous) { $subagents = [int]$previous.subagents }
switch ($hookEvent) {
  'SubagentStart' { $subagents++ }
  'SubagentStop' { $subagents = [Math]::Max(0, $subagents - 1) }
  'SessionStart' { $subagents = 0 }
}

$state = [ordered]@{
  agent = $Agent
  event = $hookEvent
  ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() / 1000.0
  subagents = $subagents
  pid = $agentPid
}
if ($payload.tool_name) { $state.tool = [string]$payload.tool_name } elseif ($payload.toolName) { $state.tool = [string]$payload.toolName }
if ($payload.cwd) { $state.cwd = [string]$payload.cwd }
if ($payload.transcript_path) { $state.transcript = [string]$payload.transcript_path }

$tmp = "$file.tmp"
[IO.File]::WriteAllText($tmp, ($state | ConvertTo-Json -Compress))
Move-Item -Force $tmp $file
exit 0
