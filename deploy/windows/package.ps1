# SPDX-License-Identifier: GPL-3.0-or-later
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path "$PSScriptRoot\..\..").Path
$PackageVersion = if ($env:VRRELAY_VERSION) { $env:VRRELAY_VERSION } else { (Get-Content "$Root\package.json" | ConvertFrom-Json).version }
$Version = (& node "$Root\script\release-version.mjs" $PackageVersion).Trim()
if ($LASTEXITCODE -ne 0) { throw 'VRRELAY_VERSION is invalid' }
$ReleasePackaging = $env:VRRELAY_RELEASE_PACKAGING -eq '1'
if ($ReleasePackaging) {
  if (-not $env:WINDOWS_CERTIFICATE) { throw 'WINDOWS_CERTIFICATE is required for release packaging' }
  if (-not $env:WINDOWS_CERTIFICATE_PASSWORD) { throw 'WINDOWS_CERTIFICATE_PASSWORD is required for release packaging' }
  if (-not $env:VRRELAY_FFMPEG_SOURCE_BUNDLE) { throw 'VRRELAY_FFMPEG_SOURCE_BUNDLE is required for release packaging' }
  if (-not (Test-Path $env:VRRELAY_FFMPEG_SOURCE_BUNDLE)) { throw "FFmpeg source bundle not found: $env:VRRELAY_FFMPEG_SOURCE_BUNDLE" }
  node "$Root\script\windows-source-bundle.mjs" --verify $env:VRRELAY_FFMPEG_SOURCE_BUNDLE
  if ($LASTEXITCODE -ne 0) { throw 'FFmpeg source bundle verification failed' }
}
$Stage = "$Root\dist\windows"
Remove-Item $Stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$Stage\runtime\apps\relay", "$Stage\runtime\apps\web", "$Stage\runtime\packages", "$Stage\runtime\bin", "$Stage\runtime\licenses", "$Stage\downloads" | Out-Null
npm --prefix $Root run build
& "$Root\deploy\windows\build-tray.ps1" "$Stage\VRRelayTray.exe"

function Get-VerifiedRuntime([string]$Url, [string]$Destination) {
  Invoke-WebRequest $Url -OutFile $Destination
  node "$Root\script\verify-runtime.mjs" $Destination
}

$NodeZip = "$Stage\downloads\node-v26.5.0-win-x64.zip"
$MediaMtxZip = "$Stage\downloads\mediamtx_v1.19.2_windows_amd64.zip"
$WinSW = "$Stage\downloads\WinSW-x64.exe"
$FfmpegZip = "$Stage\downloads\ffmpeg-n8.1.2-22-g94138f6973-win64-gpl-8.1.zip"
Get-VerifiedRuntime 'https://nodejs.org/download/release/v26.5.0/node-v26.5.0-win-x64.zip' $NodeZip
Get-VerifiedRuntime 'https://github.com/bluenviron/mediamtx/releases/download/v1.19.2/mediamtx_v1.19.2_windows_amd64.zip' $MediaMtxZip
Get-VerifiedRuntime 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe' $WinSW
Get-VerifiedRuntime 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-07-15-14-01/ffmpeg-n8.1.2-22-g94138f6973-win64-gpl-8.1.zip' $FfmpegZip
Expand-Archive $NodeZip "$Stage\downloads\node" -Force
Expand-Archive $MediaMtxZip "$Stage\downloads\mediamtx" -Force
Expand-Archive $FfmpegZip "$Stage\downloads\ffmpeg" -Force
Copy-Item "$Stage\downloads\node\node-v26.5.0-win-x64\node.exe" "$Stage\runtime\node.exe"
Copy-Item "$Stage\downloads\mediamtx\mediamtx.exe" "$Stage\runtime\mediamtx.exe"
$FfmpegExe = Get-ChildItem "$Stage\downloads\ffmpeg" -Filter ffmpeg.exe -Recurse | Select-Object -First 1
if (-not $FfmpegExe) { throw 'Pinned FFmpeg archive did not contain ffmpeg.exe' }
Copy-Item $FfmpegExe.FullName "$Stage\runtime\ffmpeg.exe"
$FfmpegLicense = Get-ChildItem "$Stage\downloads\ffmpeg" -Filter LICENSE.txt -Recurse | Select-Object -First 1
if (-not $FfmpegLicense) { throw 'Pinned FFmpeg archive did not contain its license' }
Copy-Item $FfmpegLicense.FullName "$Stage\runtime\licenses\FFmpeg-GPLv3.txt"
& "$Stage\runtime\ffmpeg.exe" -hide_banner -version | Select-Object -First 1
Copy-Item "$Root\apps\relay\dist" "$Stage\runtime\apps\relay\dist" -Recurse -Force
Copy-Item "$Root\apps\relay\public" "$Stage\runtime\apps\relay\public" -Recurse -Force
Copy-Item "$Root\apps\relay\package.json" "$Stage\runtime\apps\relay\package.json" -Force
Copy-Item "$Root\apps\web\package.json" "$Stage\runtime\apps\web\package.json" -Force
Copy-Item "$Root\packages\*" "$Stage\runtime\packages" -Recurse -Force
Copy-Item "$Root\package.json", "$Root\package-lock.json" "$Stage\runtime" -Force
Copy-Item "$Root\LICENSE", "$Root\THIRD_PARTY_NOTICES.md", "$Root\deploy\runtime-manifest.json" "$Stage\runtime" -Force
Copy-Item "$Root\deploy\native\mediamtx.yml" "$Stage\runtime\mediamtx.yml" -Force
Push-Location "$Stage\runtime"; & "$Stage\downloads\node\node-v26.5.0-win-x64\npm.cmd" install --global npm@12.0.1; & "$Stage\downloads\node\node-v26.5.0-win-x64\npm.cmd" ci --omit=dev; Pop-Location
Copy-Item $WinSW "$Stage\VRRelay.exe" -Force
$ServiceConfig = (Get-Content "$Root\deploy\windows\VRRelay.xml" -Raw).Replace('__VRRELAY_VERSION__', $Version)
Set-Content "$Stage\VRRelay.xml" $ServiceConfig
if ($env:WINDOWS_CERTIFICATE) {
  $certificate = "$Stage\signing.pfx"
  [IO.File]::WriteAllBytes($certificate, [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE))
  signtool sign /fd SHA256 /td SHA256 /tr http://timestamp.digicert.com /f $certificate /p $env:WINDOWS_CERTIFICATE_PASSWORD "$Stage\VRRelay.exe" "$Stage\VRRelayTray.exe" "$Stage\runtime\node.exe" "$Stage\runtime\ffmpeg.exe" "$Stage\runtime\mediamtx.exe"
}
node "$Root\script\runtime-provenance.mjs" --output "$Stage\runtime\runtime-provenance.json" "node=$Stage\runtime\node.exe" "ffmpeg=$Stage\runtime\ffmpeg.exe" "mediamtx=$Stage\runtime\mediamtx.exe" "winsw=$Stage\VRRelay.exe"
$ISCC = (Get-Command ISCC.exe -ErrorAction SilentlyContinue).Source
if (-not $ISCC) { throw 'Inno Setup 6 (ISCC.exe) is required to build the installer' }
& $ISCC "/DAppVersion=$Version" "$PSScriptRoot\installer.iss"
$Installer = "$Root\dist\VRRelay-$Version-Windows-x64.exe"
if ($env:WINDOWS_CERTIFICATE) { signtool sign /fd SHA256 /td SHA256 /tr http://timestamp.digicert.com /f $certificate /p $env:WINDOWS_CERTIFICATE_PASSWORD $Installer; Remove-Item $certificate }
Remove-Item $Stage -Recurse -Force
