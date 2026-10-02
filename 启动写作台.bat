@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"

rem ---- Hand off to a windowless host; double-click the .vbs to avoid even a flash. ----
if "%HEXO_TOOL_BACKGROUND%"=="1" goto run
if not exist "%~dpn0.vbs" (
  echo [x] Missing the .vbs launcher. Keep the application folder together.
  exit /b 1
)
start "" "%SystemRoot%\System32\wscript.exe" //nologo "%~dpn0.vbs" "%~1" >nul 2>&1 <nul
exit /b 0

:run
rem ---- Use the installed Node first; bundled Windows Node is the fallback. ----
set "NODE_EXE=node"
where node >nul 2>nul
if errorlevel 1 (
  if not exist "%~dp0node\node.exe" (
    echo [x] No node\node.exe in this folder, and no Node.js in PATH.
    echo     Install from https://nodejs.org/ or restore the node\ folder.
    echo.
    exit /b 1
  )
  set "NODE_EXE=%~dp0node\node.exe"
  set "PATH=%~dp0node;%PATH%"
)

if not exist "%~dp0src\server.js" (
  echo [x] Missing src\server.js. Keep the application folder together.
  exit /b 1
)

echo [*] Node      : "%NODE_EXE%"
echo [*] Blog and port: saved settings, or command-line / environment overrides.
echo [*] Stop the server using the Close Service button on the page.
echo.

rem ---- The server resolves settings and opens the browser only when ready. ----
"%NODE_EXE%" "%~dp0src\server.js" "%~1" --open
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo [*] Server stopped.
exit /b %EXIT_CODE%
