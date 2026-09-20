# Executado pelo instalador .exe (sem janela): escreve o arquivo .env apontando
# para o runtime embutido (Node, whisper.cpp e modelo), sem nenhum download.
# A parte de redação (Ollama) é instalada depois, por instalar-ia-local.ps1.

$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $raiz 'runtime'
$whisperCli = Join-Path $runtime 'whisper\whisper-cli.exe'
$whisperModelo = Join-Path $runtime 'modelos\ggml-small.bin'
if (-not (Test-Path $whisperCli) -or -not (Test-Path $whisperModelo)) { exit 0 } # instalação sem runtime embutido

$threads = [Math]::Max(2, [Environment]::ProcessorCount - 2)
$valores = [ordered]@{
  AI_PROVIDER            = 'local'
  WHISPER_CLI            = $whisperCli
  WHISPER_MODEL          = $whisperModelo
  WHISPER_THREADS        = "$threads"
  OLLAMA_MODEL           = 'llama3.1:8b'
  MAX_AUDIO_MB           = '12'
  REQUEST_BUDGET_SECONDS = '1500'
}

$envArquivo = Join-Path $raiz '.env'
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
