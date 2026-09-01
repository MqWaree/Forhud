@echo off
setlocal EnableExtensions EnableDelayedExpansion
title FGP - Deploy Corrected Release
cd /d "%~dp0"

echo ========================================
echo       FGP CORRECTED RELEASE DEPLOY
echo ========================================
echo.
echo This will deploy the tested release to forhud.shop.
echo The database is backed up before any replacement.
echo Failed health checks automatically restore the previous release.
echo A fresh archive is built and the matching source is committed and
echo pushed to GitHub before the VPS is changed.
echo.
echo You may be asked for the VPS root password twice.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0invoke-fgp-deployment.ps1"
set "FGP_DEPLOY_EXIT=%ERRORLEVEL%"

echo.
if "%FGP_DEPLOY_EXIT%"=="0" (
  echo ========================================
  echo       DEPLOYMENT COMPLETED SUCCESSFULLY
  echo ========================================
  echo Send Codex: done
) else (
  echo ========================================
  echo       DEPLOYMENT FAILED OR ROLLED BACK
  echo ========================================
  echo Leave this window open and send Codex a screenshot.
)
echo.
pause
exit /b %FGP_DEPLOY_EXIT%
