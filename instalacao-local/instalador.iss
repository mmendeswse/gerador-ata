; =============================================================================
;  Instalador Windows (.exe) — Gerador de Ata e Momento Aberto (modo local)
; -----------------------------------------------------------------------------
;  Compilado com o Inno Setup 6 (https://jrsoftware.org/isinfo.php):
;    ISCC.exe /DSourceDir=<pasta-com-os-arquivos> /O<pasta-de-saida> instalador.iss
;  O .exe instala o programa em %LOCALAPPDATA% (sem exigir administrador),
;  cria os atalhos e, ao final, oferece executar instalar-ia-local.ps1, que
;  baixa o whisper.cpp, o Ollama e os modelos (~5,5 GB) e configura o .env.
; =============================================================================

#ifndef SourceDir
  #define SourceDir ".."
#endif
#define AppName "Gerador de Ata e Momento Aberto"
#define AppVersion "1.0.0"

[Setup]
AppId={{A7C9F3D2-5E84-4B61-9C2A-3D5B8E1F6A47}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Projeto Gerador de Ata e Momento Aberto
DefaultDirName={localappdata}\GeradorAtaMomentoAberto
DefaultGroupName={#AppName}
PrivilegesRequired=lowest
OutputBaseFilename=GeradorAta-Instalador
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
UninstallDisplayName={#AppName}
SetupIconFile={#SourceDir}\instalacao-local\app.ico
UninstallDisplayIcon={app}\instalacao-local\app.ico

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Tasks]
Name: "desktopicon"; Description: "Criar atalho na &Área de Trabalho"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{sys}\wscript.exe"; \
  Parameters: """{app}\instalacao-local\iniciar-app.vbs"""; \
  WorkingDir: "{app}"; IconFilename: "{app}\instalacao-local\app.ico"; \
  Comment: "Abre o Gerador de Ata e Momento Aberto"
Name: "{group}\Instalar ou atualizar a IA local"; Filename: "{app}\instalacao-local\instalar.cmd"; WorkingDir: "{app}\instalacao-local"
Name: "{userdesktop}\{#AppName}"; Filename: "{sys}\wscript.exe"; \
  Parameters: """{app}\instalacao-local\iniciar-app.vbs"""; \
  WorkingDir: "{app}"; IconFilename: "{app}\instalacao-local\app.ico"; Tasks: desktopicon

[Run]
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\instalacao-local\instalar-ia-local.ps1"""; \
  Description: "Baixar e configurar a IA local agora (Whisper + Ollama, ~5,5 GB)"; \
  Flags: postinstall hidewizard
Filename: "{sys}\wscript.exe"; \
  Parameters: """{app}\instalacao-local\iniciar-app.vbs"""; \
  WorkingDir: "{app}"; \
  Description: "Abrir o programa ao concluir"; \
  Flags: postinstall nowait skipifsilent

[UninstallDelete]
; Remove também o que o instalador da IA baixou e o .env gerado.
Type: filesandordirs; Name: "{app}"
