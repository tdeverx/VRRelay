# SPDX-License-Identifier: GPL-3.0-or-later
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path "$PSScriptRoot\..").Path
$OutputRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$Tray = Join-Path $OutputRoot 'VRRelayTray.exe'

& "$Root\deploy\windows\build-tray.ps1" $Tray
if ($LASTEXITCODE -ne 0) { throw "Native Windows tray build failed with exit code $LASTEXITCODE" }
Push-Location $Root
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "Windows production build failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}
