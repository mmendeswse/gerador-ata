@echo off
rem Instala o modo 100%% local (Whisper + Ollama), sem depender de servico de IA.
rem Este .cmd apenas chama o script PowerShell ao lado, liberando a execucao
rem somente para este processo (nao altera a politica de seguranca do Windows).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar-ia-local.ps1"
echo.
pause
