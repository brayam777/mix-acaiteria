@echo off
setlocal

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Tentando instalar automaticamente...
  winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  echo.
  echo Se a instalacao terminou, FECHE esta janela e de 2 cliques em iniciar.bat de novo.
  echo Se deu erro, instale o Node.js em https://nodejs.org e tente de novo.
  pause
  exit /b
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 18 ? 0 : 1)" >nul 2>nul
if errorlevel 1 (
  echo O Node.js deste computador e muito antigo ^(precisa da versao 18 ou mais nova^).
  echo Instale a versao LTS em https://nodejs.org e de 2 cliques em iniciar.bat de novo.
  pause
  exit /b 1
)

set "INSTALL_DIR=%LOCALAPPDATA%\AcaiPrintAgent"
set "SOURCE_DIR=%~dp0"

if /i not "%SOURCE_DIR%"=="%INSTALL_DIR%\" (
  echo Instalando o agente em %INSTALL_DIR% ...
  if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
  copy /y "%SOURCE_DIR%agent.js" "%INSTALL_DIR%\" >nul
  copy /y "%SOURCE_DIR%package.json" "%INSTALL_DIR%\" >nul
  copy /y "%SOURCE_DIR%config.json" "%INSTALL_DIR%\" >nul
  copy /y "%SOURCE_DIR%iniciar-oculto.vbs" "%INSTALL_DIR%\" >nul
  copy /y "%~f0" "%INSTALL_DIR%\iniciar.bat" >nul
  if exist "%SOURCE_DIR%testar-impressao.bat" copy /y "%SOURCE_DIR%testar-impressao.bat" "%INSTALL_DIR%\" >nul
)

if not exist "%INSTALL_DIR%\agent.js" (
  echo ERRO: nao achei o agent.js. Extraia o .zip inteiro antes de abrir o iniciar.bat.
  pause
  exit /b 1
)

REM Para qualquer agente que ja esteja rodando (versao antiga, janela aberta...)
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'agent\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>nul

REM Inicia sozinho toda vez que o Windows ligar
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "STARTUP_LINK=%STARTUP_DIR%\Acai-ImpressaoAutomatica.bat"
> "%STARTUP_LINK%" echo @echo off
>> "%STARTUP_LINK%" echo wscript "%%LOCALAPPDATA%%\AcaiPrintAgent\iniciar-oculto.vbs"

REM Liga agora, em segundo plano (sem janela)
wscript "%INSTALL_DIR%\iniciar-oculto.vbs"

echo.
echo Iniciando o agente...
ping -n 9 127.0.0.1 >nul
echo.
echo ===== Ultimas linhas do log =====
if exist "%INSTALL_DIR%\agent.log" (powershell -NoProfile -Command "Get-Content -Tail 12 '%INSTALL_DIR%\agent.log'") else echo (ainda sem log)
echo =================================
echo.
echo PRONTO! O agente esta rodando em SEGUNDO PLANO (sem janela) e volta
echo sozinho toda vez que o computador ligar. Pode fechar esta janela.
echo.
echo Pra conferir: no painel, clique em "Testar impressao".
echo Se algo der errado, de 2 cliques em testar-impressao.bat.
echo.
pause
