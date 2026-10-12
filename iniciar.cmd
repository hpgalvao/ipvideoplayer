@echo off
setlocal enableextensions enabledelayedexpansion
title IPTV - Servidor (porta 8787)
cd /d "%~dp0"

echo ============================================
echo   IPTV - Iniciando servidor
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado no PATH.
  echo        Instale em https://nodejs.org e tente novamente.
  goto :fim
)

if not exist ".env" (
  if exist ".env.development" (
    echo [INFO] Criando .env a partir de .env.development
    copy /y ".env.development" ".env" >nul
  ) else if exist ".env.example" (
    echo [INFO] Criando .env a partir de .env.example
    copy /y ".env.example" ".env" >nul
  ) else (
    echo [AVISO] Arquivo .env nao encontrado. Crie um com base em .env.example.
  )
)

if not exist "node_modules" (
  echo [INFO] Instalando dependencias do backend...
  call npm install
  if errorlevel 1 goto :erro
)

if not exist "frontend\node_modules" (
  echo [INFO] Instalando dependencias do frontend...
  call npm install --prefix frontend
  if errorlevel 1 goto :erro
)

if not exist "frontend\dist\index.html" (
  echo [INFO] Compilando o frontend...
  call npm run build
  if errorlevel 1 goto :erro
)

rem Se o servidor ja estiver rodando, mostra o processo e pergunta o que fazer.
netstat -ano | findstr "LISTENING" | findstr ":8787" >nul 2>nul
if not errorlevel 1 (
  echo [INFO] O servidor ja esta rodando na porta 8787.
  echo.
  echo Processos na porta 8787:
  for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":8787"') do (
    tasklist /fi "PID eq %%a" /fo table
  )
  echo.
  set /p "CHOICE=Deseja matar o processo e reiniciar? (S/N): "
  if /i "!CHOICE!"=="S" (
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":8787"') do (
      taskkill /f /pid %%a >nul 2>nul
      echo [INFO] Processo %%a finalizado.
    )
  ) else (
    start "" "http://localhost:8787"
    goto :fim
  )
)

rem Descobre o IPv4 da rede local (interface com gateway) para acesso de celular/outro PC.
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-NetIPConfiguration).Where({$_.IPv4DefaultGateway -ne $null}).ForEach({$_.IPv4Address.IPAddress}) -join ', '"`) do set "LANIPS=%%i"

echo ============================================
echo   Servidor no ar!
echo ============================================
echo   Neste PC ......... http://localhost:8787
if defined LANIPS echo   Na rede (celular)  http://!LANIPS!:8787
echo.
echo   Use o IP da rede Wi-Fi no celular (ex.: 192.168.x.x).
echo   Deixe esta janela aberta (pode minimizar). Feche para encerrar.
echo ============================================
echo.

call npm start
goto :fim

:erro
echo.
echo [ERRO] Falha ao preparar/compilar o projeto. Verifique as mensagens acima.

:fim
echo.
echo Servidor encerrado.
pause
endlocal
