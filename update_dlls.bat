@echo off
setlocal
set ROOT=%~dp0
set LIB_ROOT=%ROOT%lib
set VSIX_TARGET=%LIB_ROOT%\Buffaly.VisualStudio.Extension.vsix
set VS_SOLUTION_ROOT=%~1
set VSIX_REL_PATH=artifacts\release\Buffaly.VisualStudio.Extension.vsix
set VSIX_SOURCE=

if not exist "%LIB_ROOT%" mkdir "%LIB_ROOT%"

copy /y "C:\RooTrax\RooTrax.Utilities\Deploy\BasicUtilities.dll" "%LIB_ROOT%\BasicUtilities.dll" >nul
if errorlevel 1 (
  echo Failed to copy BasicUtilities.dll
  exit /b 1
)

if "%VS_SOLUTION_ROOT%"=="" (
  echo Missing Visual Studio solution root argument.
  echo Usage: update_dlls.bat "C:\dev\buffaly.visualstudio"
  exit /b 1
)

if not exist "%VS_SOLUTION_ROOT%\" (
  echo Visual Studio solution root does not exist: "%VS_SOLUTION_ROOT%"
  exit /b 1
)

set VSIX_SOURCE=%VS_SOLUTION_ROOT%\%VSIX_REL_PATH%
if not exist "%VSIX_SOURCE%" (
  echo VSIX not found at expected path:
  echo   "%VSIX_SOURCE%"
  echo Update VSIX_REL_PATH in update_dlls.bat if your output path changed.
  exit /b 1
)

:copy_vsix
copy /y "%VSIX_SOURCE%" "%VSIX_TARGET%" >nul
if errorlevel 1 (
  echo Failed to copy VSIX from "%VSIX_SOURCE%"
  exit /b 1
)
echo Staged VSIX: %VSIX_TARGET%
echo Source VS solution: %VS_SOLUTION_ROOT%

:done
echo Updated DLLs in %LIB_ROOT%
