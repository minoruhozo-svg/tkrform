# E2E guard: lists visible top-level windows owned by the test process tree that lie inside the virtual screen.
# Usage: winwatch.ps1 -RootPid <pid> -Out <file>   (appends one line per violation; runs until the root process exits)
param([int]$RootPid, [string]$Out)
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public class WW {
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EP cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr h, int i);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static List<string> Scan(HashSet<uint> pids) {
    var res = new List<string>();
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!pids.Contains(pid) || !IsWindowVisible(h)) return true;
      RECT r; GetWindowRect(h, out r);
      int w = r.R - r.L, hh = r.B - r.T;
      if (w <= 2 || hh <= 2) return true;
      // Skip the internal message window created by tao (Tauri's window library): class "Tao Thread Event Target".
      // It is a tiny (14x14 at 0,0) helper that only receives messages; it is created with WS_EX_TOOLWINDOW (0x80) and/or
      // WS_EX_NOACTIVATE (0x08000000), so it has no taskbar button, no focus and no visible content for the user.
      // We exclude it only when the class, a tiny size and a tool-window/no-activate style all match.
      var cls = new StringBuilder(128); GetClassNameW(h, cls, 128);
      int ex = GetWindowLongW(h, -20);
      if (cls.ToString() == "Tao Thread Event Target" && w <= 16 && hh <= 16 && (ex & 0x08000080) != 0) return true;
      bool inside = r.R > vx && r.L < vx + vw && r.B > vy && r.T < vy + vh;
      if (!inside) return true;
      var c = new StringBuilder(128); GetClassNameW(h, c, 128);
      var t = new StringBuilder(128); GetWindowTextW(h, t, 128);
      res.Add("pid=" + pid + " class=" + c + " title=" + t + " rect=" + r.L + "," + r.T + "," + r.R + "," + r.B + (IsIconic(h) ? " iconic" : ""));
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
'@
$seen = @{}
while ($true) {
  $root = Get-Process -Id $RootPid -ErrorAction SilentlyContinue
  if (-not $root) { break }
  $all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId
  $set = New-Object 'System.Collections.Generic.HashSet[uint32]'
  [void]$set.Add([uint32]$RootPid)
  $grew = $true
  while ($grew) {
    $grew = $false
    foreach ($p in $all) { if ($set.Contains([uint32]$p.ParentProcessId) -and $set.Add([uint32]$p.ProcessId)) { $grew = $true } }
  }
  foreach ($line in [WW]::Scan($set)) {
    if (-not $seen.ContainsKey($line)) { $seen[$line] = 1; Add-Content -LiteralPath $Out -Value ((Get-Date -Format 'HH:mm:ss.fff') + ' ' + $line) }
  }
  Start-Sleep -Milliseconds 150
}
