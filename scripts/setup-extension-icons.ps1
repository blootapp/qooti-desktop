# Generates extension/icons/ PNG files from assets/logo solo.png
# Run once from the repo root: .\scripts\setup-extension-icons.ps1

param([string]$Root = $PSScriptRoot + '\..')

Add-Type -AssemblyName System.Drawing

$src  = Join-Path $Root 'assets\logo solo.png'
$dest = Join-Path $Root 'extension\icons'

if (!(Test-Path $src)) {
    Write-Error "Source not found: $src"
    exit 1
}
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$source = [System.Drawing.Image]::FromFile((Resolve-Path $src).Path)

foreach ($size in @(16, 48, 128)) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.DrawImage($source, 0, 0, $size, $size)
    $out = Join-Path $dest "icon-$size.png"
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    Write-Host "Created $out"
}

# Also copy as logo-solo.png for the badge image used in content.js
$logoDest = Join-Path $dest 'logo-solo.png'
Copy-Item -Path $src -Destination $logoDest -Force
Write-Host "Copied $logoDest"

$source.Dispose()
Write-Host "Done. Load extension/  in chrome://extensions"
