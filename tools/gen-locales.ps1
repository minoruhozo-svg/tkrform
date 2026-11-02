# locales/ja.json と en.json から、ブラウザ拡張用の extension/_locales/<lang>/messages.json を生成する（§18）。
# %1、%2 は Chrome の置換記法（$1$）に変換する。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

foreach ($lang in 'ja', 'en') {
    $src = Get-Content -Raw -Encoding UTF8 (Join-Path $root "locales/$lang.json") | ConvertFrom-Json
    $out = [ordered]@{}
    foreach ($p in $src.PSObject.Properties) {
        $text = [string]$p.Value
        $entry = [ordered]@{}
        $phs = [ordered]@{}
        # 置換記法 $ は $$ に退避してから、%n を $n$ にする
        $msg = $text.Replace('$', '$$')
        foreach ($m in [regex]::Matches($msg, '%(\d)')) {
            $n = $m.Groups[1].Value
            $phs[$n] = [ordered]@{ content = '$' + $n }
        }
        $msg = [regex]::Replace($msg, '%(\d)', '$$$1$$')
        $entry['message'] = $msg
        if ($phs.Count -gt 0) { $entry['placeholders'] = $phs }
        $out[$p.Name] = $entry
    }
    $dir = Join-Path $root "extension/_locales/$lang"
    New-Item -ItemType Directory -Force $dir | Out-Null
    $json = $out | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText((Join-Path $dir 'messages.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "$lang : $($out.Count) messages"
}
