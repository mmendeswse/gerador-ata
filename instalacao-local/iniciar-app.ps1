# Abre o Gerador de Ata como um PROGRAMA do Windows: sobe o servidor local em
# segundo plano (janela nenhuma), espera ele responder e abre a interface em
# uma janela de aplicativo (Edge --app: sem abas nem barra de endereço).
# Ao fechar a janela, o servidor é encerrado.

$ErrorActionPreference = 'SilentlyContinue'
$raiz = Split-Path -Parent $PSScriptRoot   # pasta do projeto
$porta = 3000
$endereco = "http://localhost:$porta/"

function ServidorAtivo {
  try {
    (Invoke-WebRequest -Uri "${endereco}api/health" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200
  } catch { $false }
}

$servidor = $null
if (-not (ServidorAtivo)) {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:Path
  $servidor = Start-Process -FilePath 'node' -ArgumentList 'local-server.js' `
    -WorkingDirectory $raiz -WindowStyle Hidden -PassThru
  for ($i = 0; $i -lt 120; $i++) {
    if (ServidorAtivo) { break }
    if ($servidor -and $servidor.HasExited) { break }
    Start-Sleep -Milliseconds 500
  }
}

if (-not (ServidorAtivo)) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    "Não foi possível iniciar o servidor do Gerador de Ata.`n`nConfira se o Node.js está instalado (o instalador da IA local cuida disso) e tente novamente.",
    'Gerador de Ata e Momento Aberto',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
  if ($servidor -and -not $servidor.HasExited) { Stop-Process -Id $servidor.Id -Force }
  exit 1
}

$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if ($edge) {
  # Perfil próprio: a janela vira um processo dedicado e não mexe no Edge do usuário.
  $janela = Start-Process -FilePath $edge -ArgumentList @(
    "--app=$endereco",
    "--user-data-dir=$env:LOCALAPPDATA\GeradorAtaMomentoAberto\janela",
    '--no-first-run', '--disable-features=msEdgeSplitWindow'
  ) -PassThru
  $janela.WaitForExit()
  if ($servidor -and -not $servidor.HasExited) { Stop-Process -Id $servidor.Id -Force }
} else {
  # Sem Edge (raro no Windows): abre no navegador padrão e mantém o servidor.
  Start-Process $endereco
}
