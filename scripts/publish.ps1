<#
  Publish the built artifacts to GitHub Releases so the in-app updater can see them.

  The updater only ever reads one URL:
      https://github.com/<repo>/releases/latest/download/latest.json
  so a Release MUST exist carrying the installer, its .sig and latest.json.

  Run "npm run release" first (it produces those three files in
  src-tauri/target/release/bundle/nsis/ and writes latest.json for tag v<version>).

  Auth: uses GH_TOKEN when set; otherwise it reuses the credential git already stores for
  github.com (nothing is ever printed). In CI, set GH_TOKEN.
  NOTE: "gh auth login --with-token" is NOT used - it demands the read:org scope, which a
  plain repo-scoped token does not have.

  Keep this file ASCII-only (see the note in release.ps1).

  Usage:
    npm run publish
#>
# NOTE: 'Continue', not 'Stop'. With 'Stop', Windows PowerShell turns ANY stderr output
# from a native command into a terminating error - and gh writes ordinary things (including
# "release not found" from a probe) to stderr. Every native call below is checked explicitly
# against $LASTEXITCODE instead.
$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent

# --- locate gh ---
$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh) {
  foreach ($p in @("$env:ProgramFiles\GitHub CLI\gh.exe", "${env:ProgramFiles(x86)}\GitHub CLI\gh.exe")) {
    if (Test-Path $p) { $gh = $p; break }
  }
}
if (-not $gh) {
  Write-Host "[publish] gh not found - install it with: winget install --id GitHub.cli -e" -ForegroundColor Red
  exit 1
}

# --- resolve a token for gh ---
if (-not $env:GH_TOKEN) {
  $nl = [Environment]::NewLine
  $req = @('protocol=https', 'host=github.com', '') -join $nl
  $out = $req | git credential fill 2>$null
  $line = $out | Where-Object { $_ -like 'password=*' } | Select-Object -First 1
  if ($line) { $env:GH_TOKEN = $line.Substring(9); Write-Host "[publish] reusing the github.com credential from git" -ForegroundColor Cyan }
}
if (-not $env:GH_TOKEN) {
  Write-Host "[publish] no GitHub token available. Set GH_TOKEN or run: gh auth login" -ForegroundColor Red
  exit 1
}

$repo = 'ajusbaby/Oberon-Music'
$conf = Get-Content (Join-Path $root 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$version = $conf.version
$tag = "v$version"
$nsisDir = Join-Path $root 'src-tauri\target\release\bundle\nsis'

$exe = Get-ChildItem $nsisDir -Filter "*_${version}_*-setup.exe" | Select-Object -First 1
if (-not $exe) { Write-Host "[publish] installer for $version not found in $nsisDir - run 'npm run release' first" -ForegroundColor Red; exit 1 }
$sigPath = $exe.FullName + '.sig'
if (-not (Test-Path $sigPath)) { Write-Host "[publish] signature missing: $sigPath (unsigned build?)" -ForegroundColor Red; exit 1 }
$jsonPath = Join-Path $nsisDir 'latest.json'
if (-not (Test-Path $jsonPath)) { Write-Host "[publish] latest.json missing - run 'npm run release' first" -ForegroundColor Red; exit 1 }

# latest.json must point at this tag, otherwise the updater would download the wrong build
$manifest = Get-Content $jsonPath -Raw | ConvertFrom-Json
$url = $manifest.platforms.'windows-x86_64'.url
if ($url -notlike "*$tag*") { Write-Host "[publish] latest.json points at '$url', expected tag $tag" -ForegroundColor Red; exit 1 }

Write-Host "[publish] version=$version tag=$tag" -ForegroundColor Cyan

# --- make sure the tag exists on the remote ---
& $gh api "repos/$repo/git/ref/tags/$tag" *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host "[publish] tag $tag is not on the remote yet; creating and pushing it..." -ForegroundColor Yellow
  # 本地没有就建（已存在时 git tag 会报错，无害）
  git tag -a $tag -m "Oberon $version" 2>$null
  git push origin $tag
  if ($LASTEXITCODE -ne 0) { Write-Host "[publish] failed to push tag $tag" -ForegroundColor Red; exit 1 }
}

$files = @($exe.FullName, $sigPath, $jsonPath)

# --- create the release, or refresh its assets if it already exists ---
& $gh release view $tag --repo $repo *> $null
if ($LASTEXITCODE -eq 0) {
  Write-Host "[publish] release $tag exists - uploading assets with --clobber" -ForegroundColor Yellow
  & $gh release upload $tag @files --clobber --repo $repo
  # 同名重发时简介也要一起刷新，否则会出现「包换了、简介还是旧的」
  $notesRefresh = Join-Path $PSScriptRoot 'release-notes.md'
  if (Test-Path $notesRefresh) {
    Write-Host "[publish] refreshing release notes from $notesRefresh"
    & $gh release edit $tag --repo $repo --notes-file $notesRefresh
  }
} else {
  Write-Host "[publish] creating release $tag" -ForegroundColor Green
  # 手写简介优先（scripts/release-notes.md）—— 里面会列出支持的格式；没有才用自动生成的提交列表
  $notesFile = Join-Path $PSScriptRoot 'release-notes.md'
  if (Test-Path $notesFile) {
    Write-Host "[publish] using release notes from $notesFile"
    & $gh release create $tag @files --repo $repo --title "Oberon $version" --verify-tag --latest --notes-file $notesFile
  } else {
    & $gh release create $tag @files --repo $repo --title "Oberon $version" --verify-tag --latest --generate-notes
  }
}
if ($LASTEXITCODE -ne 0) { Write-Host "[publish] gh release command failed" -ForegroundColor Red; exit $LASTEXITCODE }

# --- verify the exact URL the updater uses ---
$endpoint = "https://github.com/$repo/releases/latest/download/latest.json"
Start-Sleep -Seconds 3
try {
  $r = Invoke-WebRequest -Uri $endpoint -UseBasicParsing -TimeoutSec 30
  # GitHub serves this asset as application/octet-stream, so Content may arrive as bytes.
  $text = if ($r.Content -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($r.Content) } else { [string]$r.Content }
  $remote = $text.TrimStart([char]0xFEFF) | ConvertFrom-Json
  Write-Host ""
  Write-Host "[publish] $endpoint" -ForegroundColor Green
  Write-Host "[publish]   HTTP $($r.StatusCode), version = $($remote.version)" -ForegroundColor Green
  if ($remote.version -eq $version) {
    Write-Host "[publish] OK - in-app update endpoint is live and serving $version" -ForegroundColor Green
  } else {
    Write-Host "[publish] WARNING: endpoint serves $($remote.version), expected $version" -ForegroundColor Yellow
  }
} catch {
  Write-Host "[publish] could not fetch $endpoint : $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
