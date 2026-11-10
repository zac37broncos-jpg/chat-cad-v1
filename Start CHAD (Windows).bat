@echo off
title CHAD
cd /d "%~dp0"
if /i "%~1"=="--updated" goto start

rem Get the newest CHAD from GitHub before starting (needs Git; skipped if Git is missing).
where git >nul 2>nul
if errorlevel 1 goto start
if not exist ".git" goto start
echo Getting the latest CHAD...
rem The block below is read in full before it runs, so updating this file while it runs is safe.
(
  rem npm can rewrite the lockfile locally; drop that so the update is never blocked.
  git checkout -- package-lock.json >nul 2>nul
  git pull --ff-only origin main
  if errorlevel 1 echo Could not update right now. Starting the version you already have.
  call "%~f0" --updated
  exit /b
)

:start
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org, install it, then run this file again.
  pause
  exit /b 1
)
rem Claude Code powers the AI chat. Install it once if it is missing (no admin rights needed).
where claude >nul 2>nul
if not errorlevel 1 goto claude_ok
if exist "%USERPROFILE%\.local\bin\claude.exe" goto claude_ok
echo Installing Claude Code for the AI chat. This happens only once...
curl -fsSL https://claude.ai/install.cmd -o "%TEMP%\chad-claude-install.cmd"
if errorlevel 1 goto claude_failed
rem Run it in its own cmd so nothing in the installer can close this window.
cmd /d /c ""%TEMP%\chad-claude-install.cmd""
del "%TEMP%\chad-claude-install.cmd" >nul 2>nul
goto claude_ok
:claude_failed
echo Could not download Claude Code right now. CHAD still works; the chat panel shows how to set it up.
:claude_ok

echo Checking for updates to the app's building blocks (first run takes a minute)...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo Install failed. Open an issue on the GitHub page with a screenshot of this window.
  pause
  exit /b 1
)
echo.
echo Starting CHAD. Your browser will open. Keep this window open while you work; close it to stop the app.
call npm run dev -- --open
pause
