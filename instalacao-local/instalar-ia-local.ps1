# =============================================================================
#  INSTALADOR DO MODO LOCAL — Gerador de Ata e Momento Aberto
# -----------------------------------------------------------------------------
#  Deixa o sistema funcionando 100% no seu computador, sem serviço de IA:
#    1. Confere o Node.js (instala via winget se faltar);
#    2. Baixa o whisper.cpp (transcrição) e o modelo de áudio em português;
#    3. Instala o Ollama e baixa o modelo de redação (llama3.1:8b);
#    4. Preenche o arquivo .env com AI_PROVIDER=local e os caminhos.
#  Downloads: ~350 MB (whisper + modelo small) + ~4,9 GB (modelo de redação).
#  Execute pelo instalar.cmd (duplo clique) ou:
#    powershell -ExecutionPolicy Bypass -File instalar-ia-local.ps1
# =============================================================================

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$raiz        = Split-Path -Parent $PSScriptRoot   # pasta do projeto
$ferramentas = Join-Path $PSScriptRoot 'ferramentas'
$modelos     = Join-Path $PSScriptRoot 'modelos'
New-Item -ItemType Directory -Force -Path $ferramentas, $modelos | Out-Null

function Etapa($mensagem) { Write-Host ''; Write-Host "==> $mensagem" -ForegroundColor Cyan }

function Atualizar-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User')
}

# -----------------------------------------------------------------------------
# 1. Node.js 20+
# -----------------------------------------------------------------------------
Etapa 'Conferindo o Node.js...'
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

# -----------------------------------------------------------------------------
# 2. whisper.cpp (transcrição local)
# -----------------------------------------------------------------------------
Etapa 'Baixando o whisper.cpp (transcricao local)...'
$whisperDir = Join-Path $ferramentas 'whisper'
$whisperExe = $null
if (Test-Path $whisperDir) {
  $whisperExe = Get-ChildItem -Path $whisperDir -Recurse -Include 'whisper-cli.exe', 'main.exe' -ErrorAction SilentlyContinue |
    Select-Object -First 1
}
if (-not $whisperExe) {
  $release = Invoke-RestMethod 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest'
  $ativo = $release.assets | Where-Object { $_.name -match 'bin.*x64.*\.zip$' } | Select-Object -First 1
  if (-not $ativo) { $ativo = $release.assets | Where-Object { $_.name -match 'x64.*\.zip$' -and $_.name -notmatch 'cuda|arm' } | Select-Object -First 1 }
  if (-not $ativo) { throw 'Nao encontrei o pacote Windows x64 do whisper.cpp na ultima versao publicada. Baixe manualmente em https://github.com/ggml-org/whisper.cpp/releases e descompacte em instalacao-local\ferramentas\whisper.' }
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

Etapa 'Baixando o modelo de transcricao (ggml-small, ~466 MB)...'
$modeloWhisper = Join-Path $modelos 'ggml-small.bin'
if (-not (Test-Path $modeloWhisper)) {
  Invoke-WebRequest -Uri 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin' -OutFile $modeloWhisper
} else {
  Write-Host 'Modelo ja baixado.'
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
Write-Host ' Instalacao concluida! Para usar o sistema:' -ForegroundColor Green
Write-Host '   1. De um duplo clique em iniciar-local.cmd (pasta do projeto);'
Write-Host '   2. Abra http://localhost:3000 no navegador.'
Write-Host ' Tudo roda no seu computador: nenhum dado sai dele.' -ForegroundColor Green
Write-Host '============================================================='
