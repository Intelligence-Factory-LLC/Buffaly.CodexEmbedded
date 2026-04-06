@echo off
setlocal
set REPO_ROOT=C:\dev\Buffaly.CodexEmbedded
set WEB_PROJECT=.\Buffaly.CodexEmbedded.Web\Buffaly.CodexEmbedded.Web.csproj
set LAUNCH_PROFILE=https

if not exist "%REPO_ROOT%" (
  echo Repo folder not found: %REPO_ROOT%
  exit /b 1
)

cd /d "%REPO_ROOT%"
echo [Buffaly Codex Embedded] Building latest source...
"C:\Program Files\dotnet\dotnet.exe" build "%WEB_PROJECT%" -c Debug
if errorlevel 1 (
  echo Build failed. Not launching.
  pause
  exit /b 1
)

echo [Buffaly Codex Embedded] Launching with Visual Studio-equivalent profile: %LAUNCH_PROFILE%
echo Expected URLs: https://localhost:7239 and http://localhost:5225
start "Buffaly Codex Embedded (Source)" "C:\Program Files\dotnet\dotnet.exe" run --no-build --launch-profile %LAUNCH_PROFILE% --project "%WEB_PROJECT%"
endlocal
