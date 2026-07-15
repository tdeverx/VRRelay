#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

[Setup]
AppId={{15B18FB0-DB79-4F32-93B1-22E8A1014516}
AppName=VRRelay
AppVersion={#AppVersion}
DefaultDirName={autopf}\VRRelay
DefaultGroupName=VRRelay
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist
OutputBaseFilename=VRRelay-{#AppVersion}-Windows-x64
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=admin
Uninstallable=yes

[Files]
Source: "..\..\dist\windows\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\..\dist\windows\host\*"; DestDir: "{app}\host"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\..\dist\windows\VRRelay.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\dist\windows\VRRelay.xml"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
Name: "{commonappdata}\VRRelay"; Permissions: admins-full system-full; Flags: uninsneveruninstall

[Run]
Filename: "{app}\VRRelay.exe"; Parameters: "install"; Flags: runhidden waituntilterminated
Filename: "{app}\VRRelay.exe"; Parameters: "start"; Flags: runhidden waituntilterminated

[UninstallRun]
Filename: "{app}\VRRelay.exe"; Parameters: "stop"; Flags: runhidden waituntilterminated skipifdoesntexist
Filename: "{app}\VRRelay.exe"; Parameters: "uninstall"; Flags: runhidden waituntilterminated skipifdoesntexist

[UninstallDelete]
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\host"
; ProgramData is intentionally retained across repair, upgrade, and uninstall.
