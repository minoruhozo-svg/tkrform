<#
  インストールした TKRForm の MSIX が、仮想化を止めるべき場所を、パッケージの外に見せているか確かめる。
  パッケージの中（Invoke-CommandInDesktopPackage）で書き込み、外（このプロセス）から見えるかを比べる。
  - フォルダ: %LOCALAPPDATA%\tkrform（見えるはず） / %LOCALAPPDATA%（除外外。見えないはず＝仮想化）
  - レジストリ: HKCU\Software\{Google\Chrome,Microsoft\Edge}\NativeMessagingHosts\jp.tkrs.tkrform の値（見えるはず）
  試しに書いたファイルと値は、最後に消す（パッケージの中の仮想の分も、中から消す）。利用者の本物の NM 登録（既定値）には触らない。
  使い方: powershell -File installer\msix\verify-virtualization.ps1 [-PackageName TakaraSyscom.TKRForm] [-AppId TKRForm]
  Windows 11 以降、MSIX を（自己署名なら証明書を信頼して）インストール済みであること。
#>
param(
    [string]$PackageName = 'TakaraSyscom.TKRForm',
    [string]$AppId = 'TKRForm'
)
$ErrorActionPreference = 'Stop'

$pkg = Get-AppxPackage -Name $PackageName | Select-Object -First 1
if (-not $pkg) { throw "パッケージ $PackageName が見つかりません。先にインストールしてください" }
$pfn = $pkg.PackageFamilyName
Write-Host "パッケージ: $($pkg.PackageFullName)（Windows $([Environment]::OSVersion.Version)）"

$id = [guid]::NewGuid().ToString('N').Substring(0, 8)
$exFile = Join-Path $env:LOCALAPPDATA "tkrform\probe-excluded-$id.txt"
$ctlFile = Join-Path $env:LOCALAPPDATA "TKRFormProbe-control-$id.txt"
$val = "probe-$id"
$regKeys = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts\jp.tkrs.tkrform',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\jp.tkrs.tkrform'
)
$ctlKey = "HKCU:\Software\TKRFormProbe-$id" # 除外していない場所（見えないはず）

function Invoke-InPackage([string]$script) {
    $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    Invoke-CommandInDesktopPackage -PackageFamilyName $pfn -AppId $AppId -Command 'powershell.exe' -Args "-NoProfile -EncodedCommand $enc" -PreventBreakaway
    Start-Sleep -Seconds 4
}

$write = @"
`$ErrorActionPreference = 'Continue'
Set-Content -Path '$exFile' -Value 'x'
Set-Content -Path '$ctlFile' -Value 'x'
foreach (`$k in @('$($regKeys -join "','")')) { if (-not (Test-Path `$k)) { New-Item -Path `$k -Force | Out-Null }; New-ItemProperty -Path `$k -Name '$val' -Value '1' -Force | Out-Null }
New-Item -Path '$ctlKey' -Force | Out-Null; New-ItemProperty -Path '$ctlKey' -Name '$val' -Value '1' -Force | Out-Null
"@
$clean = @"
Remove-Item -Path '$exFile','$ctlFile' -Force -ErrorAction SilentlyContinue
foreach (`$k in @('$($regKeys -join "','")')) { foreach (`$n in @('$val','probe','probe2')) { Remove-ItemProperty -Path `$k -Name `$n -ErrorAction SilentlyContinue } }
Remove-Item -Path '$(Join-Path $env:LOCALAPPDATA 'tkrformprobe-excluded.txt')' -Force -ErrorAction SilentlyContinue
Remove-Item -Path '$ctlKey' -Recurse -Force -ErrorAction SilentlyContinue
"@

$results = @()
try {
    Invoke-InPackage $write
    $results += [pscustomobject]@{ 項目 = 'フォルダ（除外）%LOCALAPPDATA%\tkrform'; 期待 = '外から見える'; 結果 = (Test-Path $exFile) ; 合格 = (Test-Path $exFile) }
    $results += [pscustomobject]@{ 項目 = 'フォルダ（対照）%LOCALAPPDATA%'; 期待 = '外から見えない'; 結果 = (Test-Path $ctlFile) ; 合格 = (-not (Test-Path $ctlFile)) }
    foreach ($k in $regKeys) {
        $seen = $null -ne (Get-ItemProperty -Path $k -Name $val -ErrorAction SilentlyContinue)
        $results += [pscustomobject]@{ 項目 = "レジストリ $($k -replace '^HKCU:\\','HKCU\')"; 期待 = '外から見える'; 結果 = $seen; 合格 = $seen }
    }
    $seenCtl = $null -ne (Get-ItemProperty -Path $ctlKey -Name $val -ErrorAction SilentlyContinue)
    $results += [pscustomobject]@{ 項目 = 'レジストリ（対照。HKCU の別の場所）'; 期待 = 'どちらでもよい（参考）'; 結果 = $seenCtl; 合格 = $true }
}
finally {
    # 片付け: 外の分は外から、パッケージの中の仮想の分は中から消す
    Remove-Item -Path $exFile, $ctlFile -Force -ErrorAction SilentlyContinue
    foreach ($k in $regKeys) { Remove-ItemProperty -Path $k -Name $val -ErrorAction SilentlyContinue }
    Remove-Item -Path $ctlKey -Recurse -Force -ErrorAction SilentlyContinue
    try { Invoke-InPackage $clean } catch { Write-Warning "パッケージの中の片付けに失敗: $_" }
}

$results | Format-Table -AutoSize | Out-String | Write-Host
if ($results | Where-Object { -not $_.合格 }) { Write-Host '不合格の項目があります' -ForegroundColor Red; exit 1 }
Write-Host 'すべて合格' -ForegroundColor Green
