@echo off
cd /d "%~dp0"
py -m http.server 5500
pause
