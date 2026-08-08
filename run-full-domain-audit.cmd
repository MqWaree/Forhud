@echo off
title FGP Full 74-Domain Discord Audit
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-local-discord-audit.ps1" -Concurrency 8 -InputPath "C:\Users\Mohammad\Desktop\New Text Document.txt" -OutputName "discord-discovery-local"
if errorlevel 1 (
  echo.
  echo The full audit stopped with an error. Leave this window open so Codex can inspect the saved logs.
) else (
  echo.
  echo The full 74-domain audit is complete. Codex can now inspect the saved reports.
)
pause
