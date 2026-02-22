@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

if exist "%PS_EXE%" goto run_installer

where pwsh >nul 2>nul
if %ERRORLEVEL%==0 (
  set "PS_EXE=pwsh"
  goto run_installer
)

where powershell >nul 2>nul
if %ERRORLEVEL%==0 (
  set "PS_EXE=powershell"
  goto run_installer
)

echo PowerShell runtime not found. Install PowerShell and run install.ps1 manually.
exit /b 1

:run_installer
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install.ps1" %*
exit /b %ERRORLEVEL%
