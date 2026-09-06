# release.ps1 — Build, sign, and publish a qooti update to Cloudflare R2.
#
# Usage:
#   .\scripts\release.ps1 -Version 2.0.1 -Notes "Bug fixes"
#   .\scripts\release.ps1 -Version 2.0.1 -Notes "New feature" -DryRun
#
# First-time setup (run once):
#   cargo tauri signer generate -w .tauri-key
#   # Copy the public key printed to stdout into tauri.conf.json "pubkey" field.
#   # Set $env:TAURI_SIGNING_PRIVATE_KEY to the content of .tauri-key
#   # Set $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD if you used a password.
#
# R2 setup (run once):
#   wrangler r2 bucket create qooti-releases
#   # Then in Cloudflare dashboard: R2 → qooti-releases → Settings → Public Access → Enable
#   # Add custom domain: updates.bloot.app

param(
  [Parameter(Mandatory)][string] $Version,
  [Parameter(Mandatory)][string] $Notes,
  [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
$Root    = Split-Path $PSScriptRoot -Parent
$SrcTauri = Join-Path $Root 'src-tauri'

# ── 1. Validate environment ──────────────────────────────────────────────────

if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
  Write-Error @"
TAURI_SIGNING_PRIVATE_KEY is not set.

First-time setup:
  cargo tauri signer generate -w .tauri-key
  `$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content .tauri-key -Raw
  # Paste the PUBLIC key that was printed to stdout into src-tauri/tauri.conf.json "pubkey"
"@
}

# ── 2. Bump version in tauri.conf.json and Cargo.toml ───────────────────────

Write-Host "`n[1/5] Setting version to $Version..." -ForegroundColor Cyan

$confPath  = Join-Path $SrcTauri 'tauri.conf.json'
$cargoPath = Join-Path $SrcTauri 'Cargo.toml'

$conf = Get-Content $confPath -Raw | ConvertFrom-Json
$oldVersion = $conf.version
$conf.version = $Version
$conf | ConvertTo-Json -Depth 10 | Set-Content $confPath -Encoding utf8

(Get-Content $cargoPath -Raw) -replace '(?m)^version = "[\d.]+"', "version = `"$Version`"" |
  Set-Content $cargoPath -Encoding utf8

Write-Host "  $oldVersion → $Version"

# ── 3. Build ─────────────────────────────────────────────────────────────────

Write-Host "`n[2/5] Building release bundle..." -ForegroundColor Cyan

if (-not $DryRun) {
  Set-Location $Root
  cargo tauri build --bundles nsis
  if ($LASTEXITCODE -ne 0) { Write-Error "cargo tauri build failed" }
}

# ── 4. Locate output artifacts ───────────────────────────────────────────────

Write-Host "`n[3/5] Locating build artifacts..." -ForegroundColor Cyan

$bundleDir = Join-Path $SrcTauri 'target\release\bundle\nsis'
$zipFile   = Get-ChildItem $bundleDir -Filter '*.nsis.zip'   | Select-Object -First 1
$sigFile   = Get-ChildItem $bundleDir -Filter '*.nsis.zip.sig' | Select-Object -First 1

if (-not $zipFile -and -not $DryRun) {
  Write-Error "Could not find .nsis.zip in $bundleDir. Did the build succeed?"
}

$zipName = "qooti_${Version}_x64-setup.nsis.zip"
$sigName = "qooti_${Version}_x64-setup.nsis.zip.sig"

Write-Host "  Binary : $($zipFile?.Name ?? '(dry run)')"
Write-Host "  Sig    : $($sigFile?.Name ?? '(dry run)')"

# ── 5. Upload to R2 ──────────────────────────────────────────────────────────

Write-Host "`n[4/5] Uploading to R2 (qooti-releases)..." -ForegroundColor Cyan

$sig = if ($sigFile) { Get-Content $sigFile.FullName -Raw } else { 'DRY_RUN_SIG' }

$manifest = [ordered]@{
  version  = $Version
  notes    = $Notes
  pub_date = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ')
  platforms = [ordered]@{
    'windows-x86_64' = [ordered]@{
      signature = $sig.Trim()
      url       = "https://updates.bloot.app/$zipName"
    }
  }
}

$manifestJson = $manifest | ConvertTo-Json -Depth 5

if (-not $DryRun) {
  # Upload the binary
  wrangler r2 object put "qooti-releases/$zipName" --file $zipFile.FullName --content-type 'application/zip'
  if ($LASTEXITCODE -ne 0) { Write-Error "R2 binary upload failed" }

  # Upload the signature (plain text, referenced inside latest.json)
  wrangler r2 object put "qooti-releases/$sigName" --file $sigFile.FullName --content-type 'text/plain'

  # Update the manifest — Tauri updater reads this via the Worker
  $tmpManifest = Join-Path $env:TEMP 'qooti-latest.json'
  $manifestJson | Set-Content $tmpManifest -Encoding utf8
  wrangler r2 object put 'qooti-releases/latest.json' --file $tmpManifest --content-type 'application/json'
  if ($LASTEXITCODE -ne 0) { Write-Error "R2 manifest upload failed" }
  Remove-Item $tmpManifest

  # Redeploy Worker so it picks up the latest R2 binding (usually not needed,
  # but ensures the route is live if this is the first release).
  Write-Host "`n[5/5] Deploying Worker..." -ForegroundColor Cyan
  Set-Location (Join-Path $Root 'worker')
  wrangler deploy
  Set-Location $Root
} else {
  Write-Host "`n  [DRY RUN] Would upload:"
  Write-Host "    qooti-releases/$zipName"
  Write-Host "    qooti-releases/$sigName"
  Write-Host "    qooti-releases/latest.json"
  Write-Host "`n  Manifest preview:"
  Write-Host $manifestJson
}

Write-Host "`nDone. qooti $Version is live at https://api.bloot.app/update/windows/x86_64/$oldVersion" -ForegroundColor Green
