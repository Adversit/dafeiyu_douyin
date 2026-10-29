@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto missing_node
where npm.cmd >nul 2>nul
if errorlevel 1 goto missing_node
call npm.cmd --version >nul 2>nul
if errorlevel 1 goto missing_node
node "%~dp0scripts\launch.js"
set "launch_exit=%ERRORLEVEL%"
if not "%launch_exit%"=="0" pause
exit /b %launch_exit%

:missing_node
echo Please install Node.js 20.19+, 22.12+, or 24+ with npm.
echo Reopen this launcher after installation. No comments were sent.
pause
exit /b 1
