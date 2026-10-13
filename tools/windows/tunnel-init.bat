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
if not defined DC_RESILIENT_MCP_HOST set "DC_RESILIENT_MCP_HOST=127.0.0.1"
if not defined DC_RESILIENT_MCP_PORT set "DC_RESILIENT_MCP_PORT=8765"
if not exist "%TUNNEL_CLIENT_BIN%" (
    echo [ERROR] Full tunnel-client executable not found: %TUNNEL_CLIENT_BIN%
    exit /b 1
)
where node >nul 2>nul || (echo [ERROR] node not found in PATH. & exit /b 1)
where npm >nul 2>nul || (echo [ERROR] npm not found in PATH. & exit /b 1)
pushd "%REPO_DIR%"
if errorlevel 1 exit /b 1
echo [INFO] Installing Desktop Commander dependencies...
call npm install
if errorlevel 1 (
    popd
    exit /b 1
)
echo [INFO] Building Desktop Commander...
call npm run build
if errorlevel 1 (
    popd
    exit /b 1
)
popd
set "MCP_PROXY_URL=http://%DC_RESILIENT_MCP_HOST%:%DC_RESILIENT_MCP_PORT%/mcp"
echo [INFO] Initializing tunnel profile %TUNNEL_PROFILE% for resilient HTTP MCP proxy...
"%TUNNEL_CLIENT_BIN%" init --force --sample sample_mcp_remote_no_auth --profile "%TUNNEL_PROFILE%" --tunnel-id "%CONTROL_PLANE_TUNNEL_ID%" --mcp-server-url "%MCP_PROXY_URL%" --health-listen-addr "127.0.0.1:0" %*
if errorlevel 1 exit /b 1
echo [INFO] Running tunnel doctor through resilient MCP proxy...
set "TUNNEL_RESILIENT_PROXY=1"
set "TUNNEL_SUPERVISOR_ONESHOT=1"
node "%REPO_DIR%\tools\tunnel-supervisor.mjs" "%TUNNEL_CLIENT_BIN%" doctor --profile "%TUNNEL_PROFILE%" --explain
exit /b %ERRORLEVEL%
:invalid_config
echo [ERROR] Set CONTROL_PLANE_API_KEY and CONTROL_PLANE_TUNNEL_ID in tunnel.local.cmd.
exit /b 1
