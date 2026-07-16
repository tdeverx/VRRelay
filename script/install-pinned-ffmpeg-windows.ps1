# SPDX-License-Identifier: GPL-3.0-or-later
param([string]$Destination)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'The pinned Windows FFmpeg installer requires a Windows host.' }
if ([string]::IsNullOrWhiteSpace($Destination)) {
  $Base = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
  $Destination = Join-Path $Base 'vrrelay-ffmpeg'
}
$Destination = [IO.Path]::GetFullPath($Destination)
if ($Destination -eq [IO.Path]::GetPathRoot($Destination)) {
  throw 'Refusing to install FFmpeg into a filesystem root.'
}

$Root = (Resolve-Path "$PSScriptRoot\..").Path
$Archive = 'ffmpeg-n8.1.2-22-g94138f6973-win64-gpl-8.1.zip'
$Url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-07-15-14-01/$Archive"
$Work = Join-Path ([IO.Path]::GetTempPath()) "vrrelay-ffmpeg-$([Guid]::NewGuid().ToString('N'))"
$ArchivePath = Join-Path $Work $Archive

try {
  New-Item -ItemType Directory -Force $Work, $Destination | Out-Null
  Invoke-WebRequest $Url -OutFile $ArchivePath -MaximumRetryCount 3 -RetryIntervalSec 2
  $Verification = & node "$Root\script\verify-runtime.mjs" $ArchivePath
  if ($LASTEXITCODE -ne 0) { throw 'Pinned FFmpeg archive verification failed.' }
  $Verification | Write-Host
  Expand-Archive $ArchivePath $Destination -Force

  $Ffmpeg = Get-ChildItem $Destination -Filter ffmpeg.exe -Recurse | Select-Object -First 1
  if (-not $Ffmpeg) { throw 'Pinned FFmpeg archive did not contain ffmpeg.exe.' }

  $VersionOutput = (& $Ffmpeg.FullName -nostdin -hide_banner -version 2>&1) -join "`n"
  $EncoderOutput = (& $Ffmpeg.FullName -nostdin -hide_banner -encoders 2>&1) -join "`n"
  $FilterOutput = (& $Ffmpeg.FullName -nostdin -hide_banner -filters 2>&1) -join "`n"
  if ($VersionOutput -notlike '*ffmpeg version n8.1.2-22-g94138f6973*') {
    throw 'Pinned FFmpeg version check failed.'
  }
  if ($EncoderOutput -notlike '*libx264*') { throw 'Pinned FFmpeg lacks libx264.' }
  if ($FilterOutput -notlike '*subtitles*') { throw 'Pinned FFmpeg lacks subtitles.' }

  Write-Output $Ffmpeg.DirectoryName
} finally {
  Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
}
