@echo off
cd /d "%~dp0"
call "%~dp0DEPLOY-FGP.cmd"
exit /b %errorlevel%
