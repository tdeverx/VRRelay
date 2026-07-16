# Windows package

`package.ps1` builds the dependency-free Win32 C++ tray controller, assembles the pinned
Node, MediaMTX, and WinSW artifacts, adds the validated release-CI FFmpeg build, and produces
an Inno Setup installer.
The installer registers WinSW as an automatic background service. The relay
service supervises its bundled MediaMTX child, so service recovery covers both
the API/transcoder and OBS ingest runtime. The tray starts at user sign-in, opens the dashboard
in the system browser, and requests UAC elevation only for start, stop, or restart through
Windows SCM; quitting the tray never terminates streams.

FFmpeg 8.1.2 is downloaded from the exact BtbN GPL build referenced by the
runtime manifest and verified before extraction. Optional Authenticode
credentials are consumed only by release CI. Repair, upgrades, and uninstall
preserve `%ProgramData%\VRRelay`; deleting retained data is a separate
administrator action.
