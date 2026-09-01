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

where node.exe >nul 2>&1
if errorlevel 1 (
  set "FGP_TOOL_WRAPPER=%~dp0..\..\recovery-installers\Run-With-FgpTools.cmd"
  if not exist "!FGP_TOOL_WRAPPER!" set "FGP_TOOL_WRAPPER=%USERPROFILE%\Documents\Codex\recovery-installers\Run-With-FgpTools.cmd"
  if not exist "!FGP_TOOL_WRAPPER!" (
    echo Node.js is not available and the restored FGP tool wrapper was not found.
    echo Install Node.js, then run this deployment again.
    pause
    exit /b 1
  )
  call "!FGP_TOOL_WRAPPER!" pnpm run release:build
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
