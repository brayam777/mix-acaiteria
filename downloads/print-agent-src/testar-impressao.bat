@echo off
setlocal
cd /d "%~dp0"
if exist "%LOCALAPPDATA%\AcaiPrintAgent\agent.js" cd /d "%LOCALAPPDATA%\AcaiPrintAgent"
node agent.js --teste
echo.
echo Se algum item acima aparecer como FALHA, tire uma foto/print dessa tela e mande pro suporte.
pause
