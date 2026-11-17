<#
  インストールした TKRForm の MSIX で、Chrome / Edge から見える場所（パッケージの外）に、NM ホストの登録ができているかを確かめる。
  Store 版は、仮想化を止める宣言（unvirtualizedResources）を使わない。アプリは、パッケージの外で動かした cmd.exe / reg.exe に、
  データのフォルダの作成と HKCU の登録をさせ、その本物のフォルダに、NM ホストと拡張をコピーする。先に、アプリを 1 回起動しておくこと。

  確かめること（このプロセスは、パッケージの外で動くので、本物のレジストリとファイルが見える）:
  - レジストリ: HKCU\Software\{Google\Chrome,Microsoft\Edge}\NativeMessagingHosts\jp.tkrs.tkrform の既定値が、
    %LOCALAPPDATA%\tkrform\nm\jp.tkrs.tkrform.json を指す
  - そのファイルが実在し、"path" の NM ホスト（%LOCALAPPDATA%\tkrform\nm\tkrform-nmhost.exe）と app-id.txt も実在する
  - パッケージの仮想の場所（%LOCALAPPDATA%\Packages\<ファミリー名>\LocalCache\Local\tkrform）に、NM の登録のファイルがない
  - パッケージの中（Invoke-CommandInDesktopPackage）から %LOCALAPPDATA%\tkrform に新しく作ったファイルが、外から見える
    （保管庫などのデータが、仮想化されずに、本物のフォルダに残ること）。対照: %LOCALAPPDATA% の直下に作ったものは、外から見えない
  試しに作ったファイルは、最後に消す（パッケージの中の仮想の分も、中から消す）。利用者の本物の NM 登録には触らない。
  使い方: powershell -File installer\msix\verify-virtualization.ps1 [-PackageName TakaraSyscom.TKRForm] [-AppId TKRForm]
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

$data = Join-Path $env:LOCALAPPDATA 'tkrform'
$nm = Join-Path $data 'nm'
$json = Join-Path $nm 'jp.tkrs.tkrform.json'
$virt = Join-Path $env:LOCALAPPDATA "Packages\$pfn\LocalCache\Local\tkrform"
$regKeys = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts\jp.tkrs.tkrform',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\jp.tkrs.tkrform'
)

$results = @()
function Add-Result([string]$item, [string]$expect, $actual, [bool]$pass) {
    $script:results += [pscustomobject]@{ 項目 = $item; 期待 = $expect; 結果 = $actual; 合格 = $pass }
}

# --- 本物のレジストリ
foreach ($k in $regKeys) {
    $v = (Get-ItemProperty -Path $k -ErrorAction SilentlyContinue).'(default)'
    Add-Result "レジストリ $($k -replace '^HKCU:\\','HKCU\')" $json $v ($v -eq $json)
}
# --- 本物のファイル
$hostPath = $null
if (Test-Path $json) { $hostPath = (Get-Content $json -Raw | ConvertFrom-Json).path }
Add-Result 'NM のマニフェスト（本物の場所）' '実在する' (Test-Path $json) (Test-Path $json)
$wantHost = Join-Path $nm 'tkrform-nmhost.exe'
Add-Result 'マニフェストの path' $wantHost $hostPath ($hostPath -eq $wantHost)
Add-Result 'NM ホストのコピー（本物の場所）' '実在する' (Test-Path $wantHost) (Test-Path $wantHost)
Add-Result 'app-id.txt（本物の場所）' '実在する' (Test-Path (Join-Path $nm 'app-id.txt')) (Test-Path (Join-Path $nm 'app-id.txt'))
Add-Result '拡張のコピー（本物の場所）' '実在する' (Test-Path (Join-Path $data 'extension\manifest.json')) (Test-Path (Join-Path $data 'extension\manifest.json'))
$virtNm = Join-Path $virt 'nm'
Add-Result 'LocalCache 側の nm フォルダ' 'ない' (Test-Path $virtNm) (-not (Test-Path $virtNm))

# --- パッケージの中から、データのフォルダに新しく作ったファイルが、外から見えるか
$id = [guid]::NewGuid().ToString('N').Substring(0, 8)
$exFile = Join-Path $data "probe-data-$id.txt"
$ctlFile = Join-Path $env:LOCALAPPDATA "TKRFormProbe-control-$id.txt"
function Invoke-InPackage([string]$script) {
    $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    Invoke-CommandInDesktopPackage -PackageFamilyName $pfn -AppId $AppId -Command 'powershell.exe' -Args "-NoProfile -EncodedCommand $enc" -PreventBreakaway
    Start-Sleep -Seconds 4
}
try {
    Invoke-InPackage "Set-Content -Path '$exFile' -Value 'x'; Set-Content -Path '$ctlFile' -Value 'x'"
    Add-Result 'パッケージの中から %LOCALAPPDATA%\tkrform に作ったファイル' '外から見える' (Test-Path $exFile) (Test-Path $exFile)
    Add-Result '（対照）%LOCALAPPDATA% の直下に作ったファイル' '外から見えない' (Test-Path $ctlFile) (-not (Test-Path $ctlFile))
}
finally {
    Remove-Item -Path $exFile, $ctlFile -Force -ErrorAction SilentlyContinue
    try { Invoke-InPackage "Remove-Item -Path '$exFile','$ctlFile' -Force -ErrorAction SilentlyContinue" } catch { Write-Warning "パッケージの中の片付けに失敗: $_" }
}

$results | Format-Table -AutoSize | Out-String -Width 300 | Write-Host
if ($results | Where-Object { -not $_.合格 }) { Write-Host '不合格の項目があります' -ForegroundColor Red; exit 1 }
Write-Host 'すべて合格' -ForegroundColor Green
