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
    echo [ERROR] tunnel-client executable not found: %TUNNEL_CLIENT_BIN%
    exit /b 1
)
echo [INFO] Starting tunnel profile %TUNNEL_PROFILE% ...
"%TUNNEL_CLIENT_BIN%" run --profile "%TUNNEL_PROFILE%" %*
exit /b %ERRORLEVEL%
:invalid_config
echo [ERROR] Set CONTROL_PLANE_API_KEY and CONTROL_PLANE_TUNNEL_ID in tunnel.local.cmd.
exit /b 1
