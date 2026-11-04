; Inno Setup recipe for Jarvis-Setup.exe. Installs for the current user only (no admin prompt).
; Build: iscc desktop\installer.iss   after PyInstaller has made dist\Jarvis
#define AppVer GetEnv("JARVIS_VERSION")
#if AppVer == ""
  #define AppVer "1.0.0"
#endif

[Setup]
AppId={{8045A67E-985B-4E21-A447-B0E54DDE364E}
AppName=Jarvis
AppVersion={#AppVer}
DefaultDirName={localappdata}\Programs\Jarvis
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=Jarvis-Setup
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\Jarvis.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes

[Tasks]
Name: "desktopicon"; Description: "Put Jarvis on the desktop"

[InstallDelete]
; a new version replaces the old program files completely (memory, key and voices live in %APPDATA%\Jarvis and stay)
Type: filesandordirs; Name: "{app}\_internal"

[Files]
Source: "..\dist\Jarvis\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Jarvis"; Filename: "{app}\Jarvis.exe"
Name: "{autodesktop}\Jarvis"; Filename: "{app}\Jarvis.exe"; Tasks: desktopicon

[Run]
; no skipifsilent: after a silent update from the app's Update button, Jarvis starts again by itself
Filename: "{app}\Jarvis.exe"; Description: "Start Jarvis now"; Flags: nowait postinstall
