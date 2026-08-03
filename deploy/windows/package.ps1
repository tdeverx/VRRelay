# SPDX-License-Identifier: GPL-3.0-or-later
$ErrorActionPreference = 'Stop'
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
  $PSNativeCommandUseErrorActionPreference = $true
}

function Assert-NativeSuccess([string]$Operation, [int]$ExitCode) {
  if ($ExitCode -ne 0) { throw "$Operation failed with exit code $ExitCode" }
}

$Root = (Resolve-Path "$PSScriptRoot\..\..").Path
$PackageVersion = if ($env:VRRELAY_VERSION) { $env:VRRELAY_VERSION } else { (Get-Content "$Root\package.json" | ConvertFrom-Json).version }
$Version = (& node "$Root\script\release-version.mjs" $PackageVersion).Trim()
if ($LASTEXITCODE -ne 0) { throw 'VRRELAY_VERSION is invalid' }
$BuildNumber = if ($env:VRRELAY_BUILD_NUMBER) { $env:VRRELAY_BUILD_NUMBER } elseif ($env:GITHUB_RUN_NUMBER) { $env:GITHUB_RUN_NUMBER } else { '1' }
if ($BuildNumber -notmatch '^[1-9][0-9]*$') { throw 'VRRELAY_BUILD_NUMBER must be a positive integer' }
$BuildId = if ($env:VRRELAY_BUILD_ID) { $env:VRRELAY_BUILD_ID } else { "$Version-b$BuildNumber" }
if ($BuildId -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$') { throw 'VRRELAY_BUILD_ID must be a filesystem-safe release identity' }
$ReleasePackaging = $env:VRRELAY_RELEASE_PACKAGING -eq '1'
$SigningCertificateConfigured = -not [string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE)
$SigningPasswordConfigured = -not [string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE_PASSWORD)
if ($SigningCertificateConfigured -ne $SigningPasswordConfigured) {
  throw 'Windows signing is only partially configured; provide both signing values or neither'
}
if ($ReleasePackaging) {
  if (-not $env:VRRELAY_BUILD_ID) { throw 'VRRELAY_BUILD_ID is required for release packaging' }
  if (-not $env:VRRELAY_FFMPEG_SOURCE_BUNDLE) { throw 'VRRELAY_FFMPEG_SOURCE_BUNDLE is required for release packaging' }
  if (-not (Test-Path $env:VRRELAY_FFMPEG_SOURCE_BUNDLE)) { throw "FFmpeg source bundle not found: $env:VRRELAY_FFMPEG_SOURCE_BUNDLE" }
  node "$Root\script\windows-source-bundle.mjs" --verify $env:VRRELAY_FFMPEG_SOURCE_BUNDLE
  if ($LASTEXITCODE -ne 0) { throw 'FFmpeg source bundle verification failed' }
}
$Stage = "$Root\dist\windows"
Remove-Item $Stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$Stage\runtime\apps\relay", "$Stage\runtime\apps\web", "$Stage\runtime\packages", "$Stage\runtime\bin", "$Stage\runtime\licenses", "$Stage\downloads" | Out-Null
npm --prefix $Root run build
Assert-NativeSuccess 'Application build' $LASTEXITCODE
& "$Root\deploy\windows\build-tray.ps1" "$Stage\VRRelayTray.exe"

function Get-VerifiedRuntime([string]$Url, [string]$Destination) {
  Invoke-WebRequest $Url -OutFile $Destination
  & node "$Root\script\verify-runtime.mjs" $Destination
  Assert-NativeSuccess "Runtime verification for $Destination" $LASTEXITCODE
}

$NodeZip = "$Stage\downloads\node-v26.5.0-win-x64.zip"
$MediaMtxZip = "$Stage\downloads\mediamtx_v1.19.2_windows_amd64.zip"
$WinSW = "$Stage\downloads\WinSW-x64.exe"
$FfmpegZip = "$Stage\downloads\ffmpeg-n8.1.2-34-g9b6c8969e0-win64-gpl-8.1.zip"
Get-VerifiedRuntime 'https://nodejs.org/download/release/v26.5.0/node-v26.5.0-win-x64.zip' $NodeZip
Get-VerifiedRuntime 'https://github.com/bluenviron/mediamtx/releases/download/v1.19.2/mediamtx_v1.19.2_windows_amd64.zip' $MediaMtxZip
Get-VerifiedRuntime 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe' $WinSW
Get-VerifiedRuntime 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-07-31-14-10/ffmpeg-n8.1.2-34-g9b6c8969e0-win64-gpl-8.1.zip' $FfmpegZip
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
$RuntimeManifest = Get-Content "$Root\deploy\runtime-manifest.json" -Raw | ConvertFrom-Json
$ExpectedFfmpegRuntimeVersion = ($RuntimeManifest.components | Where-Object { $_.name -eq 'ffmpeg' }).runtimeVersion
if (-not $ExpectedFfmpegRuntimeVersion) { throw 'Runtime manifest is missing the exact FFmpeg runtime version' }
$FfmpegVersionLine = (& "$Stage\runtime\ffmpeg.exe" -hide_banner -version | Select-Object -First 1)
if ($LASTEXITCODE -ne 0) { throw 'Pinned FFmpeg binary did not report its version' }
if ($FfmpegVersionLine -notlike "*ffmpeg version n$ExpectedFfmpegRuntimeVersion*") {
  throw "Pinned FFmpeg binary reports '$FfmpegVersionLine'; expected n$ExpectedFfmpegRuntimeVersion"
}
Copy-Item "$Root\apps\relay\dist" "$Stage\runtime\apps\relay\dist" -Recurse -Force
Copy-Item "$Root\apps\relay\public" "$Stage\runtime\apps\relay\public" -Recurse -Force
Copy-Item "$Root\apps\relay\package.json" "$Stage\runtime\apps\relay\package.json" -Force
Copy-Item "$Root\apps\web\package.json" "$Stage\runtime\apps\web\package.json" -Force
Copy-Item "$Root\packages\*" "$Stage\runtime\packages" -Recurse -Force
Copy-Item "$Root\package.json", "$Root\package-lock.json" "$Stage\runtime" -Force
Copy-Item "$Root\LICENSE", "$Root\THIRD_PARTY_NOTICES.md", "$Root\deploy\runtime-manifest.json" "$Stage\runtime" -Force
Copy-Item "$Root\deploy\native\mediamtx.yml" "$Stage\runtime\mediamtx.yml" -Force
Set-Content "$Stage\runtime\build-id.txt" "$Version-$BuildNumber"
Push-Location "$Stage\runtime"
try {
  & "$Stage\downloads\node\node-v26.5.0-win-x64\npm.cmd" install --global npm@12.0.1
  Assert-NativeSuccess 'Pinned npm installation' $LASTEXITCODE
  & "$Stage\downloads\node\node-v26.5.0-win-x64\npm.cmd" ci --omit=dev --legacy-peer-deps
  Assert-NativeSuccess 'Production dependency installation' $LASTEXITCODE
} finally {
  Pop-Location
}
& node "$Root\script\select-native-prebuild.mjs" "$Stage\runtime" win32-x64
Assert-NativeSuccess 'Native prebuild selection' $LASTEXITCODE
Copy-Item $WinSW "$Stage\VRRelay.exe" -Force
$ServiceConfig = (Get-Content "$Root\deploy\windows\VRRelay.xml" -Raw).Replace('__VRRELAY_VERSION__', $Version)
Set-Content "$Stage\VRRelay.xml" $ServiceConfig
$Certificate = $null
try {
  $SignTool = $null
  if ($SigningCertificateConfigured) {
    $Certificate = "$Stage\signing.pfx"
    [IO.File]::WriteAllBytes($Certificate, [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE))
    $SignTool = (Get-Command signtool.exe -ErrorAction SilentlyContinue).Source
    if (-not $SignTool) { throw 'Windows SDK signtool.exe is required for signed packaging' }
    $NestedRuntimeBinaries = Get-ChildItem "$Stage\runtime" -Recurse -File | Where-Object {
      $_.Extension -in @('.exe', '.dll', '.node')
    } | ForEach-Object { $_.FullName }
    $SignedRuntimeFiles = @("$Stage\VRRelay.exe", "$Stage\VRRelayTray.exe") + $NestedRuntimeBinaries
    if (-not ($SignedRuntimeFiles | Where-Object { $_ -like '*.node' })) {
      throw 'Production dependencies did not install any native Node add-ons'
    }
    & $SignTool sign /fd SHA256 /td SHA256 /tr http://timestamp.digicert.com /f $Certificate /p $env:WINDOWS_CERTIFICATE_PASSWORD @SignedRuntimeFiles
    Assert-NativeSuccess 'Runtime Authenticode signing' $LASTEXITCODE
    foreach ($SignedFile in $SignedRuntimeFiles) {
      & $SignTool verify /pa /all /v $SignedFile
      Assert-NativeSuccess "Authenticode verification for $SignedFile" $LASTEXITCODE
    }
  }

  & node "$Root\script\runtime-provenance.mjs" --output "$Stage\runtime\runtime-provenance.json" "node=$Stage\runtime\node.exe" "ffmpeg=$Stage\runtime\ffmpeg.exe" "mediamtx=$Stage\runtime\mediamtx.exe" "winsw=$Stage\VRRelay.exe"
  Assert-NativeSuccess 'Runtime provenance generation' $LASTEXITCODE
  $ISCC = (Get-Command ISCC.exe -ErrorAction SilentlyContinue).Source
  if (-not $ISCC) { throw 'Inno Setup 6 (ISCC.exe) is required to build the installer' }
  & $ISCC "/DAppVersion=$Version" "/DBuildNumber=$BuildNumber" "/DBuildId=$BuildId" "$PSScriptRoot\installer.iss"
  Assert-NativeSuccess 'Inno Setup installer build' $LASTEXITCODE
  $Installer = "$Root\dist\VRRelay-$BuildId-Windows-x64.exe"
  if (-not (Test-Path $Installer -PathType Leaf)) { throw "Inno Setup did not create $Installer" }
  if ($SignTool) {
    & $SignTool sign /fd SHA256 /td SHA256 /tr http://timestamp.digicert.com /f $Certificate /p $env:WINDOWS_CERTIFICATE_PASSWORD $Installer
    Assert-NativeSuccess 'Installer Authenticode signing' $LASTEXITCODE
    & $SignTool verify /pa /all /v $Installer
    Assert-NativeSuccess 'Installer Authenticode verification' $LASTEXITCODE
  }
} finally {
  if ($Certificate) { Remove-Item $Certificate -Force -ErrorAction SilentlyContinue }
}
Remove-Item $Stage -Recurse -Force
