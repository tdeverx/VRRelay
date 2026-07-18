# SPDX-License-Identifier: GPL-3.0-or-later
param([string]$InstallDir = "$env:ProgramFiles\VRRelay")
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$StateDir = "$env:ProgramData\VRRelay"
$ConfigDir = "$StateDir\config"
New-Item -ItemType Directory -Force -Path $StateDir, $ConfigDir | Out-Null
& icacls.exe $StateDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
& icacls.exe $ConfigDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
Copy-Item "$PSScriptRoot\VRRelay.xml" "$InstallDir\VRRelay.xml" -Force
Copy-Item "$PSScriptRoot\WinSW-x64.exe" "$InstallDir\VRRelay.exe" -Force
Copy-Item "$PSScriptRoot\..\..\dist\windows\runtime" "$InstallDir\runtime" -Recurse -Force
& "$InstallDir\VRRelay.exe" install
& "$InstallDir\VRRelay.exe" start
Write-Host "VRRelay service installed. Closing the tray application will not stop streams."
