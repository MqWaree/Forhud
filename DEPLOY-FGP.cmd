@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Deploy FGP to forhud.shop
cd /d "%~dp0"

echo ========================================
echo          FGP SAFE DEPLOYMENT
echo ========================================
echo.
echo You will be asked for the VPS root password.
echo Release: corrected scanner reliability deployment
echo The deployment automatically backs up the database,
echo checks the live services, and rolls back on failure.
echo A fresh release archive will be built first.
echo Release source changes will be committed and pushed to GitHub
echo before the VPS is changed. Diverged branches are refused safely.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0invoke-fgp-deployment.ps1"
set "FGP_DEPLOY_EXIT=%ERRORLEVEL%"

echo.
if not "%FGP_DEPLOY_EXIT%"=="0" (
  echo DEPLOYMENT DID NOT COMPLETE.
  echo Leave this window open and send Codex a screenshot.
) else (
  echo DEPLOYMENT COMPLETED SUCCESSFULLY.
  echo Tell Codex: done
)
echo.
pause
exit /b %FGP_DEPLOY_EXIT%
