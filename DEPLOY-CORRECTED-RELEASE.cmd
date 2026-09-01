@echo off
setlocal
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

where node.exe >nul 2>&1
if errorlevel 1 (
  set "FGP_TOOL_WRAPPER=%USERPROFILE%\Documents\Codex\recovery-installers\Run-With-FgpTools.cmd"
  if not exist "%FGP_TOOL_WRAPPER%" (
    echo Node.js is not available and the restored FGP tool wrapper was not found.
    echo Install Node.js, then run this deployment again.
    pause
    exit /b 1
  )
  call "%FGP_TOOL_WRAPPER%" pnpm run release:build
) else (
  call pnpm run release:build
)
if errorlevel 1 (
  echo.
  echo RELEASE BUILD FAILED. Nothing was committed or deployed.
  echo.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-release.ps1"
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
