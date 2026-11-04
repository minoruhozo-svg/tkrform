; TKRForm インストーラ（Inno Setup 6）
;
; ビルド手順（リポジトリのルートで）:
;   cargo build --release
;   "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\tkrform.iss
; 出力: installer\Output\tkrform-setup-<版>.exe
;
; - ユーザー単位のインストール（管理者権限は不要）。レジストリは HKCU だけに書く。
; - Chrome / Edge の Native Messaging ホストを HKCU に登録する（§9）。
; - ブラウザ拡張（extension フォルダ）を同梱し、導入案内を出す。
; - アンインストール時は、ユーザーデータ（%LOCALAPPDATA%\tkrform）を消すかどうかを必ず確認する。既定は「残す」。

#define AppName "TKRForm"
; 版は Cargo.toml から来る（リリースビルドした TKRForm.exe の製品バージョン）。ここには書かない
#define AppVersion GetStringFileInfo("..\target\release\TKRForm.exe", "ProductVersion")
#define AppPublisher "Takara Syscom"
#define NmHostName "jp.tkrs.tkrform"
; 拡張 ID は extension/manifest.json の key から決まる固定値（tools/ext-id.txt）
#define ExtId "peloncdiaianimbhoficpdcpiooldofd"
; Chrome ウェブストアで割り当てられた ID（crates/tkrform-ipc/src/proto.rs の ALLOWED_EXTENSION_IDS と同じにする。アプリも起動時に書き直す）
#define ExtIdStore "fkhigfffleejckieoikjboabidigggee"

[Setup]
AppId={{6F1B7A52-3C0D-4E8B-9B7A-5D2E8C41A7F3}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\tkrform
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=Output
OutputBaseFilename=tkrform-setup-{#AppVersion}
VersionInfoVersion={#AppVersion}.0
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion}
VersionInfoCompany={#AppPublisher}
VersionInfoCopyright=Copyright (c) 2026 Takara Syscom
VersionInfoDescription={#AppName} Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\TKRForm.exe
SetupIconFile=..\crates\tkrform-app\icons\icon.ico
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "japanese"; MessagesFile: "compiler:Languages\Japanese.isl"

[CustomMessages]
japanese.TaskAutostart=Windows の起動時に TKRForm を起動する
japanese.RunExtHelp=ブラウザ拡張の導入案内を開く
japanese.RunLaunch=TKRForm を起動してセットアップする
japanese.AskDeleteData=ユーザーデータ（保管庫・設定・バックアップ）も削除しますか？%n%n保存先: %1%n%n「いいえ」を選ぶとデータは残り、再インストールすると続きから使えます。（削除したデータは元に戻せません）

[Tasks]
Name: "autostart"; Description: "{cm:TaskAutostart}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checkedonce

[Files]
Source: "..\target\release\TKRForm.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\target\release\tkrform-nmhost.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\extension\*"; DestDir: "{app}\extension"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\LICENSES.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\TKRForm.exe"
Name: "{autoprograms}\{#AppName} ブラウザ拡張の導入案内"; Filename: "{app}\TKRForm.exe"; Parameters: "--ext-help"

[Registry]
; Native Messaging ホストの登録（Chrome / Edge）。マニフェストは [Code] で {app}\nm に書く
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\{#NmHostName}"; ValueType: string; ValueName: ""; ValueData: "{app}\nm\{#NmHostName}.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Edge\NativeMessagingHosts\{#NmHostName}"; ValueType: string; ValueName: ""; ValueData: "{app}\nm\{#NmHostName}.json"; Flags: uninsdeletekey
; Windows ログオン時の自動起動（HKCU Run）
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "tkrform"; ValueData: """{app}\TKRForm.exe"" --background"; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\TKRForm.exe"; Description: "{cm:RunLaunch}"; Flags: nowait postinstall skipifsilent
Filename: "{app}\TKRForm.exe"; Parameters: "--ext-help"; Description: "{cm:RunExtHelp}"; Flags: nowait postinstall skipifsilent unchecked

[Code]
// NM ホストのマニフェストを書く（allowed_origins は自分の拡張 ID だけ）
procedure WriteNmManifest;
var
  Dir, HostPath, Json: String;
begin
  Dir := ExpandConstant('{app}\nm');
  ForceDirectories(Dir);
  HostPath := ExpandConstant('{app}\tkrform-nmhost.exe');
  StringChangeEx(HostPath, '\', '\\', True);
  Json := '{' + #13#10 +
    '  "name": "{#NmHostName}",' + #13#10 +
    '  "description": "tkrform Native Messaging Host",' + #13#10 +
    '  "path": "' + HostPath + '",' + #13#10 +
    '  "type": "stdio",' + #13#10 +
    '  "allowed_origins": ["chrome-extension://{#ExtId}/", "chrome-extension://{#ExtIdStore}/"]' + #13#10 +
    '}' + #13#10;
  SaveStringToFile(Dir + '\{#NmHostName}.json', Json, False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    WriteNmManifest;
end;

function InitializeUninstall: Boolean;
var
  ResultCode: Integer;
begin
  // 常駐中のアプリを止める（保管庫のファイルを閉じてから消すため）
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/im TKRForm.exe /f', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/im tkrform-nmhost.exe /f', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{localappdata}\tkrform');
    if DirExists(DataDir) then
    begin
      // 既定は「いいえ」（残す）。確認なしには消さない
      if MsgBox(FmtMessage(CustomMessage('AskDeleteData'), [DataDir]), mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
        DelTree(DataDir, True, True, True);
    end;
  end;
end;
