@echo off
setlocal
set "FGP_PROJECT=C:\Users\Mohammad\Documents\Codex\2026-08-02\referenced-chatgpt-conversation-this-is-an"
cd /d "%FGP_PROJECT%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%FGP_PROJECT%\run-local-discord-audit.ps1" -InputPath "tests\fixtures\remaining-testable-discord-sites.txt" -OutputName "discord-discovery-targeted"
set "FGP_AUDIT_EXIT=%ERRORLEVEL%"
echo.
if not "%FGP_AUDIT_EXIT%"=="0" (
  echo The targeted audit stopped with an error. Leave this window open so Codex can inspect the saved log.
) else (
  echo The targeted audit completed. Codex is monitoring the report.
)
pause
exit /b %FGP_AUDIT_EXIT%
