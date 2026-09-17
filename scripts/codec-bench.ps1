<#
  codec-bench.ps1 - compare Oberon's pure-Rust decode kernels against FFmpeg.

  Why: the app ships pure-Rust decoders (symphonia / opus-pure / ADTS / DSD) instead of
  bundling FFmpeg. This answers the only question that matters for that choice:
  "how much slower is my kernel than FFmpeg on the same file?"

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/codec-bench.ps1 -Files <paths...>
    powershell ... -File scripts/codec-bench.ps1 -Dir '<music dir>'      # auto-pick per extension

  Method (kept deliberately equal on both sides):
    - decode the WHOLE file to PCM, single-threaded, repeats times, take the FASTEST;
    - report wall seconds and CPU seconds; CPU (ffmpeg utime+stime) is the fair metric,
      wall time can be dominated by disk IO;
    - x-realtime = audio seconds / elapsed seconds.
    - DSD is forced to 88200 Hz PCM on both sides (ffmpeg -ar 88200 => its dsd2pcm path).
  Caveats printed with the table: our pipeline outputs interleaved f32 (what rodio wants),
  while ffmpeg -f null defaults to s16; and our DSD low-pass is 256-tap vs ffmpeg's dsd2pcm.

  Keep this file ASCII-only: PowerShell 5.1 reads BOM-less files as ANSI/GBK and a GBK lead
  byte can swallow the following quote (same note as in release.ps1).
#>
param(
  [string[]]$Files = @(),
  [string]$Dir = '',
  [int]$Repeats = 3,
  [string]$FfmpegPath = ''
)
# 'Continue', not 'Stop': Windows PowerShell turns ANY stderr output from a native command
# into a terminating error, and ffmpeg writes ordinary info (duration, stream layout) to
# stderr. Every native call below is checked explicitly against $LASTEXITCODE instead.
$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent

function Find-Ffmpeg {
  if ($FfmpegPath -and (Test-Path $FfmpegPath)) { return $FfmpegPath }
  $links = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\ffmpeg.exe'
  if (Test-Path $links) { return $links }
  $pkg = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
  if (Test-Path $pkg) {
    $hit = Get-ChildItem $pkg -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue -File | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw 'ffmpeg not found. Install it with: winget install --id Gyan.FFmpeg -e'
}

function Build-OberonBench {
  $exe = Join-Path $root 'src-tauri\target\release\examples\codec_bench.exe'
  if (-not (Test-Path $exe)) {
    Write-Host '[bench] building codec_bench (release) ...' -ForegroundColor Cyan
    Push-Location (Join-Path $root 'src-tauri')
    & cargo build --release --example codec_bench
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { throw 'cargo build --release --example codec_bench failed' }
  }
  return $exe
}

function Auto-PickFiles([string]$dir) {
  # one file per extension, largest first (largest = least noisy measurement)
  $exts = @('.dsf', '.dff', '.opus', '.aac', '.mp3', '.flac')
  $pick = @()
  foreach ($e in $exts) {
    $hit = Get-ChildItem $dir -Recurse -File -Filter "*$e" -ErrorAction SilentlyContinue |
      Sort-Object Length -Descending | Select-Object -First 1
    if ($hit) { $pick += $hit.FullName }
  }
  return $pick
}

function Run-Oberon([string]$exe, [string]$file, [int]$repeats) {
  $out = (& $exe $file $repeats 2>&1 | Out-String)
  $line = (($out -split "`n") | Where-Object { $_ -like 'RESULT oberon*' } | Select-Object -First 1)
  if (-not $line) { return $null }
  $kv = @{}
  foreach ($tok in ($line.Trim() -split '\s+')) {
    if ($tok -match '^([a-zA-Z]+)=(.*)$') { $kv[$Matches[1]] = $Matches[2] }
  }
  return [pscustomobject]@{
    kind  = $kv['kind']
    rate  = [int]$kv['rate']
    ch    = [int]$kv['ch']
    audio = [double]$kv['audio']
    wall  = [double]$kv['wall']
    cpu   = [double]$kv['cpu']
  }
}

function Run-Ffmpeg([string]$ff, [string]$file, [int]$repeats) {
  $ext = [System.IO.Path]::GetExtension($file).ToLower()
  $extra = @()
  if ($ext -eq '.dsf' -or $ext -eq '.dff') { $extra = @('-ar', '88200') }
  $best = $null
  for ($i = 0; $i -lt [Math]::Max(1, $repeats); $i++) {
    $out = (& $ff -hide_banner -nostdin -threads 1 -filter_threads 1 -benchmark -i $file -map 0:a:0 @extra -f null - 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { Write-Host "        ffmpeg exit=$LASTEXITCODE" -ForegroundColor Yellow }
    $m = [regex]::Match($out, 'bench:\s*utime=([0-9.]+)s\s+stime=([0-9.]+)s\s+rtime=([0-9.]+)s')
    if ($m.Success) {
      $cpu = [double]$m.Groups[1].Value + [double]$m.Groups[2].Value
      $rt = [double]$m.Groups[3].Value
      if (-not $best -or $cpu -lt $best.cpu) { $best = [pscustomobject]@{ cpu = $cpu; wall = $rt } }
    }
  }
  return $best
}

$files = @($Files | Where-Object { $_ -and (Test-Path $_) })
if ($files.Count -eq 0 -and $Dir) { $files = @(Auto-PickFiles $Dir) }
if ($files.Count -eq 0) {
  Write-Host 'usage: codec-bench.ps1 -Files <paths...>   |   -Dir <music dir>' -ForegroundColor Yellow
  exit 2
}

$ff = Find-Ffmpeg
$exe = Build-OberonBench
Write-Host "[bench] ffmpeg : $ff" -ForegroundColor Cyan
Write-Host "[bench] oberon : $exe" -ForegroundColor Cyan
& $ff -hide_banner -version 2>&1 | Select-Object -First 1 | Write-Host
Write-Host ''

$rows = @()
foreach ($f in $files) {
  $name = [System.IO.Path]::GetFileName($f)
  Write-Host "[bench] $name ..." -ForegroundColor DarkGray
  $ob = Run-Oberon $exe $f $Repeats
  $ffr = Run-Ffmpeg $ff $f $Repeats
  if (-not $ob -or -not $ffr) {
    Write-Host "        SKIPPED (oberon=$([bool]$ob) ffmpeg=$([bool]$ffr))" -ForegroundColor Yellow
    continue
  }
  $rows += [pscustomobject]@{
    File     = $name
    Kernel   = $ob.kind
    Audio    = $ob.audio
    ObWall   = $ob.wall
    ObCpu    = $ob.cpu
    ObX      = $ob.audio / [Math]::Max($ob.wall, 1e-9)
    FfWall   = $ffr.wall
    FfCpu    = $ffr.cpu
    FfX      = $ob.audio / [Math]::Max($ffr.wall, 1e-9)
    CpuRatio = $ffr.cpu / [Math]::Max($ob.cpu, 1e-9)
  }
}

Write-Host ''
Write-Host '== decode whole file to PCM (fastest of N, single-threaded) ==' -ForegroundColor Green
$rows | Format-Table -AutoSize @{
    n = 'file'; e = { $_.File }
  }, @{ n = 'kernel'; e = { $_.Kernel } }, @{ n = 'audio_s'; e = { '{0:N1}' -f $_.Audio } },
  @{ n = 'oberon_wall'; e = { '{0:N3}' -f $_.ObWall } }, @{ n = 'oberon_cpu'; e = { '{0:N3}' -f $_.ObCpu } },
  @{ n = 'oberon_x'; e = { '{0:N1}' -f $_.ObX } }, @{ n = 'ff_wall'; e = { '{0:N3}' -f $_.FfWall } },
  @{ n = 'ff_cpu'; e = { '{0:N3}' -f $_.FfCpu } }, @{ n = 'ff_x'; e = { '{0:N1}' -f $_.FfX } },
  @{ n = 'ff/oberon_cpu'; e = { '{0:N2}x' -f $_.CpuRatio } } | Out-String | Write-Host

if ($rows.Count -gt 0) {
  $avg = ($rows | Measure-Object -Property CpuRatio -Average).Average
  Write-Host ('Average CPU-time ratio (ffmpeg / oberon) = {0:N2}x  (>1 = ffmpeg used MORE CPU than us)' -f $avg) -ForegroundColor Cyan
  Write-Host 'Caveats:' -ForegroundColor DarkGray
  Write-Host '  - oberon outputs interleaved f32 (what rodio wants); ffmpeg -f null defaults to s16.' -ForegroundColor DarkGray
  Write-Host '  - DSD: our 256-tap low-pass vs ffmpeg dsd2pcm (48-tap), and ffmpeg has SIMD.' -ForegroundColor DarkGray
  Write-Host '  - ffmpeg may still spend CPU on helper threads, so compare CPU seconds (not just wall).' -ForegroundColor DarkGray
}