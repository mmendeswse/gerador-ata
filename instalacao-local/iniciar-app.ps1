# Abre o Gerador de Ata como um PROGRAMA do Windows: sobe o servidor local em
# segundo plano (janela nenhuma), espera ele responder e abre a interface em
# uma janela de aplicativo (Edge --app: sem abas nem barra de endereço).
# Ao fechar a janela, o servidor é encerrado.
# Problemas são explicados em caixas de mensagem e registrados em
# %LOCALAPPDATA%\GeradorAtaMomentoAberto\servidor.log.

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms

$raiz = Split-Path -Parent $PSScriptRoot   # pasta do projeto
$porta = 3000
$endereco = "http://localhost:$porta/"
$pastaDados = Join-Path $env:LOCALAPPDATA 'GeradorAtaMomentoAberto'
New-Item -ItemType Directory -Force -Path $pastaDados | Out-Null
$log = Join-Path $pastaDados 'servidor.log'

function Avisar($texto, $icone) {
  [System.Windows.Forms.MessageBox]::Show($texto, 'Gerador de Ata e Momento Aberto',
    [System.Windows.Forms.MessageBoxButtons]::OK, $icone) | Out-Null
}

function ServidorAtivo {
  try {
    (Invoke-WebRequest -Uri "${endereco}api/health" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200
  } catch { $false }
}

# --- Node.js: primeiro o embutido no instalador, depois o do sistema ---------
$nodeExe = Join-Path $raiz 'runtime\node\node.exe'
if (-not (Test-Path $nodeExe)) {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:Path
  $doSistema = Get-Command node -ErrorAction SilentlyContinue
  $nodeExe = if ($doSistema) { $doSistema.Source } else { $null }
}
$temServidor = ServidorAtivo
if (-not $temServidor -and -not $nodeExe) {
  Avisar ("A instalação ainda não está completa neste computador: o Node.js não foi encontrado." + [Environment]::NewLine + [Environment]::NewLine +
    'Vou abrir agora o instalador da IA local, que baixa tudo o que falta. Ao final, clique de novo no ícone do programa.') `
    ([System.Windows.Forms.MessageBoxIcon]::Warning)
  Start-Process -FilePath (Join-Path $PSScriptRoot 'instalar.cmd') -WorkingDirectory $PSScriptRoot
  exit 0
}

# --- servidor ----------------------------------------------------------------
$servidor = $null
if (-not $temServidor) {
  Set-Content -Path $log -Value "[$(Get-Date)] Iniciando $nodeExe local-server.js em $raiz" -Encoding utf8
  $servidor = Start-Process -FilePath $nodeExe -ArgumentList 'local-server.js' `
    -WorkingDirectory $raiz -WindowStyle Hidden -PassThru `
    -RedirectStandardError (Join-Path $pastaDados 'servidor-erro.log')
  for ($i = 0; $i -lt 60; $i++) {
    if (ServidorAtivo) { break }
    if ($servidor -and $servidor.HasExited) { break }
    Start-Sleep -Milliseconds 500
  }
}

if (-not (ServidorAtivo)) {
  $detalhe = ''
  $erroLog = Join-Path $pastaDados 'servidor-erro.log'
  if (Test-Path $erroLog) {
    $detalhe = ((Get-Content $erroLog -Tail 5) -join [Environment]::NewLine)
  }
  Avisar ("Não foi possível iniciar o servidor do programa." + [Environment]::NewLine + [Environment]::NewLine +
    $(if ($detalhe) { "Detalhes técnicos:" + [Environment]::NewLine + $detalhe } else { "Nenhum detalhe registrado em $erroLog." }) + [Environment]::NewLine + [Environment]::NewLine +
    'Tente executar, no Menu Iniciar, "Instalar ou atualizar a IA local".') `
    ([System.Windows.Forms.MessageBoxIcon]::Error)
  if ($servidor -and -not $servidor.HasExited) { Stop-Process -Id $servidor.Id -Force }
  exit 1
}

# --- janela do aplicativo ------------------------------------------------------
$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if ($edge) {
  # Perfil próprio: a janela vira um processo dedicado e não mexe no Edge do usuário.
  $janela = Start-Process -FilePath $edge -ArgumentList @(
    "--app=$endereco",
    "--user-data-dir=$pastaDados\janela",
    '--no-first-run', '--disable-features=msEdgeSplitWindow'
  ) -PassThru
  $janela.WaitForExit()
  if ($servidor -and -not $servidor.HasExited) { Stop-Process -Id $servidor.Id -Force }
} else {
  # Sem Edge (raro no Windows): abre no navegador padrão e mantém o servidor.
  Start-Process $endereco
}
