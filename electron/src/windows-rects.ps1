# Long-running helper for DeskPet on Windows: prints the visible top-level windows, front to back,
# as JSON [[hwnd, x, y, width, height], ...] in physical pixels whenever they change.
# Used for walking on windows. __SKIP_PID__ is replaced with DeskPet's own process id.
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class DeskPetRects {
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);

  public static string Scan(uint skipPid) {
    var sb = new StringBuilder("[");
    bool first = true;
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      int ex = GetWindowLong(h, -20);
      if ((ex & 0x80) != 0) return true;                                   // tool windows
      if (GetWindow(h, 4) != IntPtr.Zero && (ex & 0x40000) == 0) return true; // owned popups
      int cloaked;
      if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true; // hidden UWP windows
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid == skipPid) return true;
      RECT r;
      if (DwmGetWindowAttribute(h, 9, out r, 16) != 0) return true;       // visible frame bounds
      int w = r.R - r.L, hh = r.B - r.T;
      if (w < 120 || hh < 60) return true;
      sb.Append(first ? "" : ",").Append('[').Append(h.ToInt64()).Append(',').Append(r.L).Append(',')
        .Append(r.T).Append(',').Append(w).Append(',').Append(hh).Append(']');
      first = false;
      return true;
    }, IntPtr.Zero);
    return sb.Append(']').ToString();
  }
}
'@
[void][DeskPetRects]::SetProcessDpiAwarenessContext([IntPtr](-4)) # per-monitor aware: physical pixels
$last = ''
while ($true) {
  $json = [DeskPetRects]::Scan([uint32]__SKIP_PID__)
  if ($json -ne $last) {
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
    $last = $json
  }
  Start-Sleep -Milliseconds 250
}
