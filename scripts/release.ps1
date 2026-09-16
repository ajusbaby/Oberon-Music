<#
  Build a signed release bundle and emit the latest.json manifest for GitHub Releases.

  Why this script exists: tauri.conf.json sets bundle.createUpdaterArtifacts = true,
  so Tauri REQUIRES the updater signing private key. Running "npm run tauri:build"
  directly fails with "A public key has been found, but no private key".

  The private key defaults to .build\oberon-updater.key (that directory is gitignored).
  Override with TAURI_SIGNING_PRIVATE_KEY_PATH.

  NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less files as ANSI
  (GBK on zh-CN), and a GBK lead byte can swallow the following ASCII quote, which makes
  the whole script fail to parse. ASCII content is immune to that.

  Usage:
    npm run release                  # version from tauri.conf.json, tag = v<version>
    npm run release -- -Tag v1.0.0   # explicit tag
#>
param(
  [string]$Tag = ""
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$keyPath = if ($env:TAURI_SIGNING_PRIVATE_KEY_PATH) { $env:TAURI_SIGNING_PRIVATE_KEY_PATH } else { Join-Path $root '.build\oberon-updater.key' }

if (-not (Test-Path $keyPath)) {
  Write-Host "[release] signing key not found: $keyPath" -ForegroundColor Red
  Write-Host "[release] restore it from your backup, or generate a new one (WARNING: rotating"
  Write-Host "[release] the key means already-shipped clients can no longer verify new builds):"
  Write-Host "[release]   npx tauri signer generate -w .build\oberon-updater.key"
  exit 1
}

# The bundler reads the key CONTENT from TAURI_SIGNING_PRIVATE_KEY
# (TAURI_SIGNING_PRIVATE_KEY_PATH is understood by the signer CLI but not by the bundler).
# The password MUST also be set: with no password variable the bundler drops into an
# interactive "Password:" prompt and the build hangs forever in a non-interactive shell
# (Windows cannot hold a truly empty environment variable, so we keep a real password).
$pwPath = if ($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD_PATH) { $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD_PATH } else { Join-Path $root '.build\oberon-updater.password' }
if (-not (Test-Path $pwPath)) {
  Write-Host "[release] signing key password not found: $pwPath" -ForegroundColor Red
  Write-Host "[release] it must match the key; restore both from your backup."
  exit 1
}
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content $keyPath -Raw).Trim()
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content $pwPath -Raw).Trim()
Write-Host "[release] signing key: $keyPath (password loaded)" -ForegroundColor Cyan

Set-Location $root
npm run tauri:build
if ($LASTEXITCODE -ne 0) { Write-Host "[release] build failed" -ForegroundColor Red; exit $LASTEXITCODE }

$nsisDir = Join-Path $root 'src-tauri\target\release\bundle\nsis'
$conf = Get-Content (Join-Path $root 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$version = $conf.version
if (-not $Tag) { $Tag = "v$version" }

# Tauri v2 signs the NSIS installer itself: the updater artifact IS <setup>.exe and its
# signature is <setup>.exe.sig. (There is no .nsis.zip in v2 - the updater downloads the
# installer and runs it with the /UPDATER flag.)
$sig = Get-ChildItem $nsisDir -Filter '*-setup.exe.sig' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $sig) {
  Write-Host "[release] updater signature (*-setup.exe.sig) missing - check createUpdaterArtifacts and the signing key" -ForegroundColor Red
  exit 1
}
$artifact = Get-Item $sig.FullName.Substring(0, $sig.FullName.Length - 4)

$repo = 'ajusbaby/Oberon-Music'
$latest = [ordered]@{
  version   = $version
  notes     = "Oberon $version"
  pub_date  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  platforms = [ordered]@{
    'windows-x86_64' = [ordered]@{
      signature = (Get-Content $sig.FullName -Raw).Trim()
      url       = "https://github.com/$repo/releases/download/$Tag/$($artifact.Name)"
    }
  }
}
$jsonPath = Join-Path $nsisDir 'latest.json'
$latest | ConvertTo-Json -Depth 6 | Set-Content -Path $jsonPath -Encoding UTF8

Write-Host ""
Write-Host "== artifacts ==" -ForegroundColor Green
Get-ChildItem $nsisDir -File | Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-20) } |
  Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,2)}} | Format-Table -AutoSize

Write-Host "Upload these 3 files to the GitHub Release (tag $Tag):" -ForegroundColor Yellow
Write-Host "  $($artifact.Name)   manual install AND the in-app updater payload"
Write-Host "  $($sig.Name)   signature"
Write-Host "  latest.json          updater manifest (endpoint = releases/latest/download/latest.json)"
