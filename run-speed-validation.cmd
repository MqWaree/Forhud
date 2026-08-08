@echo off
title FGP Scanner Speed Validation
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-local-discord-audit.ps1" -Concurrency 8 -InputPath "C:\Users\Mohammad\Desktop\New Text Document.txt" -OutputName "discord-discovery-speed-after"
if errorlevel 1 (
  echo.
  echo The speed validation stopped with an error. Leave this window open so Codex can inspect the saved logs.
) else (
  echo.
  echo Speed validation complete. Ask Codex to compare the new result with the previous 96.7 percent run.
)
pause
