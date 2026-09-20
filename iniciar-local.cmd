@echo off
rem Inicia o Gerador de Ata e Momento Aberto no seu computador (modo local).
cd /d "%~dp0"
start "" http://localhost:3000
npm start
