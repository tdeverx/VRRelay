# Windows package

`package.ps1` builds the dependency-free Win32 C++ tray controller, assembles the pinned
Node, MediaMTX, and WinSW artifacts, adds the validated release-CI FFmpeg build, and produces
an Inno Setup installer.
The installer registers WinSW as an automatic background service. The relay
service supervises its bundled MediaMTX child, so service recovery covers both
the API/transcoder and OBS ingest runtime. The tray starts at user sign-in, opens the dashboard
at the exact listener saved in `%ProgramData%\VRRelay\config\runtime-config.json`, and requests UAC elevation only for start, stop, restart, or quit through
Windows SCM. Quit waits for the service to stop before closing the tray so the managed runtime and active streams cannot be left behind.

FFmpeg 8.1.2 is downloaded from the exact BtbN GPL build referenced by the
runtime manifest and verified before extraction. Optional Authenticode
credentials are consumed only by release CI. Repair, upgrades, and uninstall
preserve `%ProgramData%\VRRelay`; deleting retained data is a separate
administrator action.
