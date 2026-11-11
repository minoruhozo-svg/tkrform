# TKRForm の MSIX（Microsoft Store 版）を作る。
#
# 前提: release ビルド済み（cargo build --release）。Windows SDK（MakeAppx.exe / SignTool.exe）が入っていること。
# 使い方（リポジトリのルートで）:
#   powershell -File installer\msix\build-msix.ps1                 # 署名なしの .msix（Store への提出用。Store が署名する）
#   powershell -File installer\msix\build-msix.ps1 -SelfSign       # テスト用の自己署名つき（手元でインストールして試す用）
# Partner Center で予約した値に差し替えるときは、-IdentityName / -Publisher / -DisplayName / -PublisherDisplayName を指定する。
# 出力: installer\msix\out\TKRForm_<版>_x64.msix（out\ は .gitignore。証明書の秘密鍵・.pfx はここにもリポジトリにも置かない）

param(
    [string]$IdentityName = 'TakaraSyscom.TKRForm',
    [string]$Publisher = 'CN=Takara Syscom Test',
    [string]$DisplayName = 'TKRForm',
    [string]$PublisherDisplayName = 'Takara Syscom',
    [string]$Version = '',        # 省略時は Cargo.toml の版（x.y.z）に .0 を付けた 4 桁
    [string]$ReleaseDir = '',     # 省略時は <ルート>\target\release
    [string]$OutDir = '',         # 省略時は installer\msix\out
    [string]$SdkBin = '',         # 省略時は、入っている Windows SDK のいちばん新しい x64 の bin
    [switch]$SelfSign
)
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $here '..\..')
if (-not $ReleaseDir) { $ReleaseDir = Join-Path $root 'target\release' }
if (-not $OutDir) { $OutDir = Join-Path $here 'out' }

# --- 版: Cargo.toml の [workspace.package] version（1 か所）。MSIX は 4 桁
if (-not $Version) {
    $m = Select-String -Path (Join-Path $root 'Cargo.toml') -Pattern '^version\s*=\s*"(\d+)\.(\d+)\.(\d+)"' | Select-Object -First 1
    if (-not $m) { throw 'Cargo.toml から版を読めません' }
    $Version = '{0}.{1}.{2}.0' -f $m.Matches[0].Groups[1].Value, $m.Matches[0].Groups[2].Value, $m.Matches[0].Groups[3].Value
}
if ($Version -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw "版は 4 桁（例 0.3.0.0）で指定してください: $Version" }

# --- Windows SDK のツール
if (-not $SdkBin) {
    $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $SdkBin = Get-ChildItem $kits -Directory | Where-Object { $_.Name -match '^10\.' -and (Test-Path (Join-Path $_.FullName 'x64\makeappx.exe')) } |
        Sort-Object { [version]$_.Name } -Descending | ForEach-Object { Join-Path $_.FullName 'x64' } | Select-Object -First 1
}
$makeappx = Join-Path $SdkBin 'makeappx.exe'
$signtool = Join-Path $SdkBin 'signtool.exe'
if (-not (Test-Path $makeappx)) { throw "MakeAppx.exe が見つかりません（Windows SDK を入れてください）: $SdkBin" }

# --- 入力の確認
foreach ($f in 'TKRForm.exe', 'tkrform-nmhost.exe') {
    if (-not (Test-Path (Join-Path $ReleaseDir $f))) { throw "$f がありません。先に cargo build --release を実行してください: $ReleaseDir" }
}
if (-not (Test-Path (Join-Path $root 'extension\manifest.json'))) { throw 'extension\manifest.json がありません' }

# --- 配置（パッケージの中身）を作る
$stage = Join-Path $OutDir 'layout'
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }   # この出力用のフォルダだけ（OutDir は生成物の置き場）
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'Assets') | Out-Null
Copy-Item (Join-Path $ReleaseDir 'TKRForm.exe') $stage
Copy-Item (Join-Path $ReleaseDir 'tkrform-nmhost.exe') $stage
Copy-Item (Join-Path $root 'extension') (Join-Path $stage 'extension') -Recurse
foreach ($f in 'LICENSE', 'LICENSES.md') {
    if (Test-Path (Join-Path $root $f)) { Copy-Item (Join-Path $root $f) $stage }
}

# --- ロゴ（既存のアイコンから）
Add-Type -AssemblyName System.Drawing
$icon = Join-Path $root 'crates\tkrform-app\icons\icon.png'
$src = [System.Drawing.Image]::FromFile($icon)
function New-Logo([string]$name, [int]$w, [int]$h) {
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $side = [Math]::Min($w, $h)
    $g.DrawImage($src, [int](($w - $side) / 2), [int](($h - $side) / 2), $side, $side)
    $g.Dispose()
    $bmp.Save((Join-Path $stage "Assets\$name"), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}
New-Logo 'Square44x44Logo.png' 44 44
New-Logo 'Square150x150Logo.png' 150 150
New-Logo 'StoreLogo.png' 50 50
$src.Dispose()

# --- マニフェスト（ひな形の {{...}} を埋める）
$xml = Get-Content -Raw -Encoding UTF8 (Join-Path $here 'AppxManifest.template.xml')
$esc = { param($s) [System.Security.SecurityElement]::Escape($s) }
$xml = $xml.Replace('{{IDENTITY_NAME}}', (& $esc $IdentityName)).Replace('{{PUBLISHER}}', (& $esc $Publisher)).Replace('{{VERSION}}', $Version).
    Replace('{{DISPLAY_NAME}}', (& $esc $DisplayName)).Replace('{{PUBLISHER_DISPLAY_NAME}}', (& $esc $PublisherDisplayName))
[System.IO.File]::WriteAllText((Join-Path $stage 'AppxManifest.xml'), $xml, (New-Object System.Text.UTF8Encoding($false)))

# --- パッケージ化
$msix = Join-Path $OutDir ("TKRForm_{0}_x64.msix" -f $Version)
if (Test-Path $msix) { Remove-Item -Force $msix }
& $makeappx pack /d $stage /p $msix /o
if ($LASTEXITCODE -ne 0) { throw "MakeAppx が失敗しました（終了コード $LASTEXITCODE）" }

# --- テスト用の自己署名（CN は Publisher と一致させる。秘密鍵は、この PC の現在のユーザーの証明書ストアにだけ置く）
if ($SelfSign) {
    $cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $Publisher -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) } | Select-Object -First 1
    if (-not $cert) {
        $cert = New-SelfSignedCertificate -Type Custom -Subject $Publisher -KeyUsage DigitalSignature -FriendlyName 'TKRForm MSIX test' `
            -CertStoreLocation 'Cert:\CurrentUser\My' -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
    }
    & $signtool sign /fd SHA256 /sha1 $cert.Thumbprint /s My $msix
    if ($LASTEXITCODE -ne 0) { throw "SignTool が失敗しました（終了コード $LASTEXITCODE）" }
    $cer = Join-Path $OutDir 'TKRForm-test.cer'
    Export-Certificate -Cert $cert -FilePath $cer | Out-Null   # 公開鍵だけ（秘密鍵は書き出さない）
    Write-Host ''
    Write-Host "テスト用の証明書（公開鍵）: $cer"
    Write-Host 'インストールするには、この証明書を信頼する必要があります（管理者の PowerShell で）:'
    Write-Host "  Import-Certificate -FilePath '$cer' -CertStoreLocation Cert:\LocalMachine\TrustedPeople"
    Write-Host "  Add-AppxPackage '$msix'"
}
Write-Host ''
Write-Host "作成しました: $msix"
