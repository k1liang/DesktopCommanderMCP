@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Remote Desktop Commander - Local Fork

cd /d "%~dp0"
set "REPO_DIR=%CD%"
set "LOCAL_INDEX=%REPO_DIR%\dist\index.js"
set "GLOBAL_INDEX=%APPDATA%\npm\node_modules\@wonderwhy-er\desktop-commander\dist\index.js"

echo ============================================================
echo Remote Desktop Commander - Local Fork
echo Repository: %REPO_DIR%
echo ============================================================
echo.

where node >nul 2>nul || (
    echo [ERROR] node.exe was not found in PATH.
    pause
    exit /b 1
)

where npm >nul 2>nul || (
    echo [ERROR] npm was not found in PATH.
    pause
    exit /b 1
)

echo [1/3] Stopping previous Desktop Commander remote node process...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$paths = @('%LOCAL_INDEX%', '%GLOBAL_INDEX%');" ^
  "$targets = Get-CimInstance Win32_Process | Where-Object {" ^
  "  $cmd = $_.CommandLine;" ^
  "  if ($_.Name -ne 'node.exe' -or -not $cmd -or $cmd -notmatch '(?i)(?:^|\s)remote(?:\s|$)') { return $false }" ^
  "  foreach ($path in $paths) {" ^
  "    if ($path -and $cmd.IndexOf($path, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }" ^
  "  }" ^
  "  return $false" ^
  "};" ^
  "foreach ($p in $targets) {" ^
  "  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; Write-Host ('  stopped PID ' + $p.ProcessId) } catch {}" ^
  "}"

if errorlevel 1 (
    echo [ERROR] Failed while stopping the previous process.
    pause
    exit /b 1
)

echo.
echo [2/3] Building local fork...
if not exist "%REPO_DIR%\node_modules" (
    echo node_modules not found - running npm install...
    call npm install
    if errorlevel 1 goto :fail
)

call npm run build
if errorlevel 1 goto :fail

if not exist "%LOCAL_INDEX%" (
    echo [ERROR] Build completed but dist\index.js was not found:
    echo   %LOCAL_INDEX%
    pause
    exit /b 1
)

echo.
echo [3/3] Starting local fork in remote mode...
echo   node "%LOCAL_INDEX%" remote
echo.
node "%LOCAL_INDEX%" remote
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo Remote Desktop Commander exited with code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%

:fail
echo.
echo [ERROR] Build failed.
pause
exit /b 1
