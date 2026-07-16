# SPDX-License-Identifier: GPL-3.0-or-later
param([string]$Output = '')

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path "$PSScriptRoot\..\..").Path
if (-not $Output) { $Output = "$Root\dist\windows\VRRelayTray.exe" }
$Output = [IO.Path]::GetFullPath($Output)
$Source = "$Root\apps\windows\VRRelayTray.cpp"
$VsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $VsWhere)) { throw 'Visual Studio Build Tools with MSVC x64 are required' }
$VisualStudio = (& $VsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()
if (-not $VisualStudio) { throw 'MSVC x64 build tools were not found' }
$VcVars = Join-Path $VisualStudio 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $VcVars)) { throw "vcvars64.bat was not found under $VisualStudio" }

New-Item -ItemType Directory -Force ([IO.Path]::GetDirectoryName($Output)) | Out-Null
$EnvironmentOutput = & $env:COMSPEC /d /s /c "call `"$VcVars`" >nul && set"
if ($LASTEXITCODE -ne 0) { throw 'Failed to initialize the MSVC x64 build environment' }
foreach ($Line in $EnvironmentOutput) {
  $Separator = $Line.IndexOf('=')
  if ($Separator -gt 0) {
    [Environment]::SetEnvironmentVariable(
      $Line.Substring(0, $Separator),
      $Line.Substring($Separator + 1),
      'Process'
    )
  }
}

$CompilerArguments = @(
  '/nologo', '/std:c++20', '/EHsc', '/O2', '/GL', '/MT', '/permissive-', '/W4', '/WX',
  '/DUNICODE', '/D_UNICODE', $Source, '/link', '/LTCG', '/SUBSYSTEM:WINDOWS', "/OUT:$Output"
)
& cl.exe @CompilerArguments
if ($LASTEXITCODE -ne 0) { throw "Native Windows tray build failed with exit code $LASTEXITCODE" }
if (-not (Test-Path $Output)) { throw "Native Windows tray build did not produce $Output" }
Write-Output $Output
