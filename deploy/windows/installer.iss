#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef BuildNumber
  #define BuildNumber "1"
#endif
#ifndef BuildId
  #define BuildId "{#AppVersion}-b{#BuildNumber}"
#endif

[Setup]
AppId={{15B18FB0-DB79-4F32-93B1-22E8A1014516}
AppName=VRRelay
AppVersion={#AppVersion}
AppVerName=VRRelay {#AppVersion} (build {#BuildNumber})
DefaultDirName={autopf}\VRRelay
DefaultGroupName=VRRelay
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist
OutputBaseFilename=VRRelay-{#BuildId}-Windows-x64
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=admin
Uninstallable=yes

[Files]
Source: "..\..\dist\windows\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\..\dist\windows\VRRelay.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\dist\windows\VRRelayTray.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\dist\windows\VRRelay.xml"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
Name: "{commonappdata}\VRRelay"; Permissions: admins-full system-full; Flags: uninsneveruninstall
Name: "{commonappdata}\VRRelay\config"; Permissions: admins-full system-full users-readexec; Flags: uninsneveruninstall

[InstallDelete]
Type: filesandordirs; Name: "{app}\host"
Type: filesandordirs; Name: "{app}\runtime\apps\windows"

[Tasks]
Name: "startuptray"; Description: "Start the VRRelay tray controller when I sign in"; Flags: checkedonce

[Icons]
Name: "{group}\VRRelay Dashboard and Controls"; Filename: "{app}\VRRelayTray.exe"
Name: "{userstartup}\VRRelay Tray"; Filename: "{app}\VRRelayTray.exe"; Tasks: startuptray

[Run]
Filename: "{app}\VRRelay.exe"; Parameters: "install"; Flags: runhidden waituntilterminated
Filename: "{app}\VRRelay.exe"; Parameters: "start"; Flags: runhidden waituntilterminated
Filename: "{app}\VRRelayTray.exe"; Description: "Open VRRelay dashboard controls"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{app}\VRRelay.exe"; Parameters: "stop"; Flags: runhidden waituntilterminated skipifdoesntexist
Filename: "{app}\VRRelayTray.exe"; Parameters: "--quit"; Flags: runhidden waituntilterminated skipifdoesntexist
Filename: "{app}\VRRelay.exe"; Parameters: "uninstall"; Flags: runhidden waituntilterminated skipifdoesntexist

[UninstallDelete]
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\host"
; ProgramData is intentionally retained across repair, upgrade, and uninstall.
