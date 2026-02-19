@echo off
setlocal
set ROOT=%~dp0
set LIB_ROOT=%ROOT%lib

if not exist "%LIB_ROOT%" mkdir "%LIB_ROOT%"

copy /y "C:\RooTrax\RooTrax.Utilities\Deploy\BasicUtilities.dll" "%LIB_ROOT%\BasicUtilities.dll" >nul
if errorlevel 1 (
  echo Failed to copy BasicUtilities.dll
  exit /b 1
)

echo Updated DLLs in %LIB_ROOT%
