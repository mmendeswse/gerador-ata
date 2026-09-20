# =============================================================================
#  INSTALADOR DO MODO LOCAL — Gerador de Ata e Momento Aberto
# -----------------------------------------------------------------------------
#  Deixa o sistema funcionando 100% no seu computador, sem serviço de IA.
#
#  Quando instalado pelo GeradorAta-Instalador.exe, o Node.js, o whisper.cpp e
#  o modelo de transcrição JÁ VÊM EMBUTIDOS (pasta runtime/): este script só
#  precisa instalar o Ollama e baixar o modelo de redação (~4,9 GB).
#  Rodando a partir do código-fonte (GitHub), ele baixa também o que faltar.
#
#  Execute pelo instalar.cmd (duplo clique) ou:
#    powershell -ExecutionPolicy Bypass -File instalar-ia-local.ps1
# =============================================================================

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

# Qualquer falha (ex.: queda de internet no download) vira um aviso claro,
# em vez de a janela sumir sem explicação.
trap {
  Write-Host ''
  Write-Host "ERRO: $_" -ForegroundColor Red
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
      ("A instalação da IA de redação não foi concluída:" + [Environment]::NewLine + [Environment]::NewLine + $_ +
       [Environment]::NewLine + [Environment]::NewLine +
       'O programa abre e transcreve mesmo assim. Para concluir esta parte depois, use no Menu Iniciar: "Instalar ou atualizar a IA local".'),
      'Gerador de Ata e Momento Aberto',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
  } catch {}
  exit 1
}

$raiz        = Split-Path -Parent $PSScriptRoot   # pasta do projeto
$runtime     = Join-Path $raiz 'runtime'          # runtime embutido pelo .exe (se houver)
$ferramentas = Join-Path $PSScriptRoot 'ferramentas'
$modelos     = Join-Path $PSScriptRoot 'modelos'

function Etapa($mensagem) { Write-Host ''; Write-Host "==> $mensagem" -ForegroundColor Cyan }

function Atualizar-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User')
}

# -----------------------------------------------------------------------------
# 1. Node.js
# -----------------------------------------------------------------------------
Etapa 'Conferindo o Node.js...'
$nodeEmbutido = Join-Path $runtime 'node\node.exe'
if (Test-Path $nodeEmbutido) {
  Write-Host "Node.js embutido no instalador: $nodeEmbutido"
} else {
  Atualizar-Path
  $node = Get-Command node -ErrorAction SilentlyContinue
  $versaoOk = $false
  if ($node) {
    $maior = [int]((node --version) -replace '^v(\d+).*', '$1')
    if ($maior -ge 20) { $versaoOk = $true }
  }
  if (-not $versaoOk) {
    Write-Host 'Node.js 20+ nao encontrado. Instalando via winget...'
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    Atualizar-Path
  }
  Write-Host ("Node.js: " + (node --version))
}

# -----------------------------------------------------------------------------
# 2. whisper.cpp (transcrição local)
# -----------------------------------------------------------------------------
Etapa 'Conferindo o whisper.cpp (transcricao local)...'
$whisperExe = $null
$cliEmbutido = Join-Path $runtime 'whisper\whisper-cli.exe'
if (Test-Path $cliEmbutido) {
  $whisperExe = Get-Item $cliEmbutido
  Write-Host "Whisper embutido no instalador: $($whisperExe.FullName)"
} else {
  New-Item -ItemType Directory -Force -Path $ferramentas | Out-Null
  $whisperDir = Join-Path $ferramentas 'whisper'
  if (Test-Path $whisperDir) {
    $whisperExe = Get-ChildItem -Path $whisperDir -Recurse -Include 'whisper-cli.exe', 'main.exe' -ErrorAction SilentlyContinue |
      Select-Object -First 1
  }
  if (-not $whisperExe) {
    # Nem toda versão publica binários Windows: procura a mais recente que os tenha.
    $releases = Invoke-RestMethod 'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=20'
    $ativo = $null
    foreach ($r in $releases) {
      $ativo = $r.assets | Where-Object { $_.name -match '^whisper-blas-bin-x64\.zip$' } | Select-Object -First 1
      if (-not $ativo) { $ativo = $r.assets | Where-Object { $_.name -match '^whisper-bin-x64\.zip$' } | Select-Object -First 1 }
      if ($ativo) { break }
    }
    if (-not $ativo) { throw 'Nao encontrei o pacote Windows x64 do whisper.cpp. Baixe manualmente em https://github.com/ggml-org/whisper.cpp/releases e descompacte em instalacao-local\ferramentas\whisper.' }
    Write-Host ("Baixando " + $ativo.name + " (" + [math]::Round($ativo.size / 1MB, 1) + " MB)...")
    $zip = Join-Path $env:TEMP $ativo.name
    Invoke-WebRequest -Uri $ativo.browser_download_url -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $whisperDir -Force
    Remove-Item $zip -Force
    $whisperExe = Get-ChildItem -Path $whisperDir -Recurse -Include 'whisper-cli.exe', 'main.exe' |
      Select-Object -First 1
    if (-not $whisperExe) { throw 'O pacote do whisper.cpp foi baixado, mas nao contem whisper-cli.exe.' }
  }
  Write-Host ("Whisper: " + $whisperExe.FullName)
}

Etapa 'Conferindo o modelo de transcricao...'
$modeloWhisper = Join-Path $runtime 'modelos\ggml-small.bin'
if (Test-Path $modeloWhisper) {
  Write-Host "Modelo embutido no instalador: $modeloWhisper"
} else {
  New-Item -ItemType Directory -Force -Path $modelos | Out-Null
  $modeloWhisper = Join-Path $modelos 'ggml-small.bin'
  if (-not (Test-Path $modeloWhisper)) {
    Write-Host 'Baixando ggml-small (~466 MB)...'
    Invoke-WebRequest -Uri 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin' -OutFile $modeloWhisper
  } else {
    Write-Host 'Modelo ja baixado.'
  }
}

# -----------------------------------------------------------------------------
# 3. Ollama (redação local)
# -----------------------------------------------------------------------------
Etapa 'Conferindo o Ollama (redacao local)...'
Atualizar-Path
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  Write-Host 'Instalando o Ollama via winget...'
  winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements
  Atualizar-Path
}
# Garante que o servico do Ollama esta de pe antes do download do modelo.
try { ollama list *> $null } catch {}
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Iniciando o servico do Ollama...'
  Start-Process -FilePath 'ollama' -ArgumentList 'serve' -WindowStyle Hidden
  Start-Sleep -Seconds 5
}

$modeloOllama = 'llama3.1:8b'
Etapa ("Baixando o modelo de redacao $modeloOllama (~4,9 GB — pode demorar)...")
ollama pull $modeloOllama
if ($LASTEXITCODE -ne 0) { throw "Falha ao baixar o modelo $modeloOllama pelo Ollama." }

# -----------------------------------------------------------------------------
# 4. Arquivo .env
# -----------------------------------------------------------------------------
Etapa 'Configurando o arquivo .env...'
$threads = [Math]::Max(2, [Environment]::ProcessorCount - 2)
$envArquivo = Join-Path $raiz '.env'
$valores = [ordered]@{
  AI_PROVIDER            = 'local'
  WHISPER_CLI            = $whisperExe.FullName
  WHISPER_MODEL          = $modeloWhisper
  WHISPER_THREADS        = "$threads"
  OLLAMA_MODEL           = $modeloOllama
  MAX_AUDIO_MB           = '12'
  REQUEST_BUDGET_SECONDS = '1500'
}
$linhas = @()
if (Test-Path $envArquivo) { $linhas = @(Get-Content $envArquivo) }
foreach ($chave in $valores.Keys) {
  $nova = "$chave=$($valores[$chave])"
  $existente = $false
  for ($i = 0; $i -lt $linhas.Count; $i++) {
    if ($linhas[$i] -match "^\s*#?\s*$chave=") { $linhas[$i] = $nova; $existente = $true; break }
  }
  if (-not $existente) { $linhas += $nova }
}
Set-Content -Path $envArquivo -Value $linhas -Encoding utf8

Write-Host ''
Write-Host '=============================================================' -ForegroundColor Green
Write-Host ' Instalacao concluida! Para usar o sistema, abra o atalho' -ForegroundColor Green
Write-Host ' "Gerador de Ata e Momento Aberto" (Area de Trabalho ou Menu Iniciar).'
Write-Host ' Tudo roda no seu computador: nenhum dado sai dele.' -ForegroundColor Green
Write-Host '============================================================='
