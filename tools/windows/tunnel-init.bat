@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "REPO_DIR=%%~fI"
set "CONFIG=%SCRIPT_DIR%tunnel.local.cmd"
if not exist "%CONFIG%" (
    echo [ERROR] Missing %CONFIG%
    echo Copy tunnel.local.cmd.example to tunnel.local.cmd and set credentials.
    exit /b 1
)
call "%CONFIG%"
if errorlevel 1 exit /b 1
if not defined CONTROL_PLANE_API_KEY goto :invalid_config
if not defined CONTROL_PLANE_TUNNEL_ID goto :invalid_config
if "%CONTROL_PLANE_API_KEY%"=="PASTE_YOUR_RUNTIME_API_KEY_HERE" goto :invalid_config
if "%CONTROL_PLANE_TUNNEL_ID%"=="PASTE_YOUR_TUNNEL_ID_HERE" goto :invalid_config
if not defined TUNNEL_CLIENT_BIN (
    echo [ERROR] Set TUNNEL_CLIENT_BIN in tunnel.local.cmd.
    exit /b 1
)
if not defined TUNNEL_PROFILE set "TUNNEL_PROFILE=desktop-commander"
if not exist "%TUNNEL_CLIENT_BIN%" (
    echo [ERROR] Full tunnel-client executable not found: %TUNNEL_CLIENT_BIN%
    exit /b 1
)
where node >nul 2>nul || (echo [ERROR] node not found in PATH. & exit /b 1)
if not exist "%REPO_DIR%\dist\index.js" (
    echo [ERROR] dist\index.js missing. From repository root run npm install and npm run build.
    exit /b 1
)
set "MCP_ENTRY=%REPO_DIR:\=/%/dist/index.js"
echo [INFO] Initializing tunnel profile %TUNNEL_PROFILE% ...
"%TUNNEL_CLIENT_BIN%" init --sample sample_mcp_stdio_local --profile "%TUNNEL_PROFILE%" --tunnel-id "%CONTROL_PLANE_TUNNEL_ID%" --mcp-command "node %MCP_ENTRY%" %*
if errorlevel 1 exit /b 1
echo [INFO] Running tunnel doctor...
"%TUNNEL_CLIENT_BIN%" doctor --profile "%TUNNEL_PROFILE%" --explain
exit /b %ERRORLEVEL%
:invalid_config
echo [ERROR] Set CONTROL_PLANE_API_KEY and CONTROL_PLANE_TUNNEL_ID in tunnel.local.cmd.
exit /b 1
