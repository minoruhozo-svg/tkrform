# Microsoft Store / Chrome ウェブストア / Edge アドオン用のロゴ・タイルを、既存のアイコンから作る。
#   powershell -File tools\gen-store-assets.ps1
# 出力: docs\store\*.png（アイコンは crates\tkrform-app\icons\icon.png）
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$out = Join-Path $root 'docs\store'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$icon = [System.Drawing.Image]::FromFile((Join-Path $root 'crates\tkrform-app\icons\icon.png'))

function New-Asset([string]$name, [int]$w, [int]$h, [double]$iconRatio, [string]$caption) {
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
    $c1 = [System.Drawing.Color]::FromArgb(43, 141, 224)
    $c2 = [System.Drawing.Color]::FromArgb(24, 100, 170)
    $br = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $c1, $c2, 60.0
    $g.FillRectangle($br, $rect)
    $br.Dispose()
    $side = [int]([Math]::Min($w, $h) * $iconRatio)
    $hasText = [bool]$caption
    $cy = if ($hasText) { [int](($h - $side) / 2 - $side * 0.12) } else { [int](($h - $side) / 2) }
    $g.DrawImage($icon, [int](($w - $side) / 2), $cy, $side, $side)
    if ($hasText) {
        $fs = [Math]::Max(10, [int]($side * 0.22))
        $font = New-Object System.Drawing.Font 'Segoe UI Semibold', $fs, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
        $sf = New-Object System.Drawing.StringFormat
        $sf.Alignment = [System.Drawing.StringAlignment]::Center
        $g.DrawString($caption, $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, ($cy + $side + $fs * 0.1), $w, ($fs * 1.6)), $sf)
        $font.Dispose()
    }
    $g.Dispose()
    $bmp.Save((Join-Path $out $name), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "$name (${w}x${h})"
}

# Microsoft Store: 1:1 のボックスアート（300 は最小、1080 は推奨）と、2:3 のポスター
New-Asset 'store-logo-300x300.png' 300 300 0.62 ''
New-Asset 'store-boxart-1080x1080.png' 1080 1080 0.62 ''
New-Asset 'store-poster-720x1080.png' 720 1080 0.52 'TKRForm'
# ブラウザ拡張のストア（Chrome ウェブストア / Edge アドオン）
New-Asset 'extension-logo-300x300.png' 300 300 0.62 ''
New-Asset 'extension-icon-128x128.png' 128 128 0.7 ''
New-Asset 'extension-promo-small-440x280.png' 440 280 0.52 'TKRForm'
New-Asset 'extension-promo-large-1400x560.png' 1400 560 0.5 'TKRForm'
$icon.Dispose()
