# tkrform のアイコンを描画して生成する（独自デザイン: 角丸の四角に鍵穴）。
# 出力: crates/tkrform-app/icons/{icon.ico,icon.png,tray-unlocked.png,tray-locked.png}, extension/icons/*.png
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot

function New-Icon([int]$size, [string]$mode) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::Transparent)
    if ($mode -eq 'locked') {
        $bg = [System.Drawing.Color]::FromArgb(255, 128, 134, 142)
    } else {
        $bg = [System.Drawing.Color]::FromArgb(255, 36, 140, 214)
    }
    $r = [int]($size * 0.22)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($size - $d - 1, 0, $d, $d, 270, 90)
    $path.AddArc($size - $d - 1, $size - $d - 1, $d, $d, 0, 90)
    $path.AddArc(0, $size - $d - 1, $d, $d, 90, 90)
    $path.CloseFigure()
    $g.FillPath((New-Object System.Drawing.SolidBrush($bg)), $path)
    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    # 鍵穴: 円 + 台形
    $cx = $size / 2.0
    $cr = $size * 0.17
    $g.FillEllipse($white, $cx - $cr, $size * 0.26, $cr * 2, $cr * 2)
    $pts = @(
        [System.Drawing.PointF]::new($cx - $size * 0.07, $size * 0.5),
        [System.Drawing.PointF]::new($cx + $size * 0.07, $size * 0.5),
        [System.Drawing.PointF]::new($cx + $size * 0.13, $size * 0.76),
        [System.Drawing.PointF]::new($cx - $size * 0.13, $size * 0.76)
    )
    $g.FillPolygon($white, [System.Drawing.PointF[]]$pts)
    if ($mode -eq 'unlocked') {
        # 状態の目印（右下の緑の点）
        $dot = [int]($size * 0.3)
        $g.FillEllipse((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 54, 190, 120))), $size - $dot - 1, $size - $dot - 1, $dot, $dot)
    }
    $g.Dispose()
    return $bmp
}

function Save-Png($bmp, [string]$path) {
    New-Item -ItemType Directory -Force (Split-Path -Parent $path) | Out-Null
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
}

function Write-Ico([string]$path, [int[]]$sizes) {
    $images = @()
    foreach ($s in $sizes) {
        $bmp = New-Icon $s 'unlocked'
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $images += , @($s, $ms.ToArray())
        $bmp.Dispose()
    }
    $out = New-Object System.IO.MemoryStream
    $w = New-Object System.IO.BinaryWriter($out)
    $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$images.Count)
    $offset = 6 + 16 * $images.Count
    foreach ($img in $images) {
        $s = $img[0]; $data = $img[1]
        $wh = if ($s -ge 256) { 0 } else { $s }
        $w.Write([byte]$wh); $w.Write([byte]$wh); $w.Write([byte]0); $w.Write([byte]0)
        $w.Write([uint16]1); $w.Write([uint16]32)
        $w.Write([uint32]$data.Length); $w.Write([uint32]$offset)
        $offset += $data.Length
    }
    foreach ($img in $images) { $w.Write($img[1]) }
    $w.Flush()
    [System.IO.File]::WriteAllBytes($path, $out.ToArray())
}

$icons = Join-Path $root 'crates/tkrform-app/icons'
New-Item -ItemType Directory -Force $icons | Out-Null
Write-Ico (Join-Path $icons 'icon.ico') @(16, 32, 48, 256)
Save-Png (New-Icon 256 'unlocked') (Join-Path $icons 'icon.png')
Save-Png (New-Icon 32 'unlocked') (Join-Path $icons 'tray-unlocked.png')
Save-Png (New-Icon 32 'locked') (Join-Path $icons 'tray-locked.png')
Save-Png (New-Icon 32 'unlocked') (Join-Path $icons '32x32.png')
Save-Png (New-Icon 128 'unlocked') (Join-Path $icons '128x128.png')

$ext = Join-Path $root 'extension/icons'
foreach ($s in 16, 32, 48, 128) {
    Save-Png (New-Icon $s 'unlocked') (Join-Path $ext "icon$s.png")
    Save-Png (New-Icon $s 'locked') (Join-Path $ext "locked$s.png")
}
Write-Host 'icons generated'
