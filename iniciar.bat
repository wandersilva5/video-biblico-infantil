@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
chcp 65001 >nul
title Historinhas Biblicas - Controlador

rem =====================================================================
rem  Historinhas Biblicas Infantis - inicializacao
rem  Verifica/sobe os 3 servidores e encerra todos ao fechar esta janela.
rem   1) llama-server  -> http://127.0.0.1:8091   (roteiro)
rem   2) ComfyUI       -> http://127.0.0.1:8188   (imagens)
rem   3) servidor web  -> http://localhost:PORTA  (interface React)
rem
rem  A interface (web/) e React com rotas por hash (#/ e #/aula/:slug),
rem  sem build: react/htm vendored em web/vendor/. O servidor web e
rem  reiniciado sempre que este script roda, para servir o frontend
rem  e o backend atualizados.
rem =====================================================================

set "LLAMA_EXE=E:\llama.cpp\llama-server.exe"
set "LLAMA_MODEL=E:\llama.cpp\models\Qwen3.5-9B-Q4_K_M.gguf"
set "LLAMA_PORT=8091"
set "COMFY_DIR=D:\ComfyUI_windows_portable"
set "COMFY_BAT=%COMFY_DIR%\run_nvidia_gpu.bat"
set "COMFY_PORT=8188"
set "PORTA=5173"

rem ---- Le a porta salva em .config.json (se existir) ----
if exist ".config.json" (
  for /f %%a in ('powershell -NoProfile -Command "(Get-Content '.config.json' -Raw | ConvertFrom-Json).PORTA"') do if not "%%a"=="" set "PORTA=%%a"
)

rem ---- Arquivos auxiliares ficam no projeto (evita acentos do %TEMP%) ----
set "PIDS_FILE=%~dp0.servidores_%PORTA%.pids"
set "LOG_FILE=%~dp0.iniciar.log"
if exist "%PIDS_FILE%" del /q "%PIDS_FILE%" >nul 2>nul
echo. > "%LOG_FILE%"

cls
echo ================================================================
echo   Historinhas Biblicas Infantis  -  status dos servidores
echo ================================================================
echo.
echo   llama-server  . porta %LLAMA_PORT%   (gera os roteiros)
echo   ComfyUI       . porta %COMFY_PORT%   (gera as imagens)
echo   servidor web  . porta %PORTA%        (interface)
echo.
echo   Iniciando servidores... mantenha esta janela aberta.
echo   Feche esta janela para encerrar todos os servidores.
echo.

call :verificar_http "http://127.0.0.1:%LLAMA_PORT%/v1/models" LLAMA_OK
if "!LLAMA_OK!"=="1" (
  echo   [1/3] llama-server ........ JA EM EXECUCAO
  echo   [1/3] llama-server ........ JA EM EXECUCAO >> "%LOG_FILE%"
) else (
  echo   [1/3] llama-server ........ iniciando ^(carga do modelo ~5-8 min^)...
  echo   [1/3] llama-server ........ iniciando... >> "%LOG_FILE%"
  start "llama-server" /min "%LLAMA_EXE%" -m "%LLAMA_MODEL%" --port %LLAMA_PORT% -c 8192 --n-gpu-layers 20 --no-webui --reasoning off
  call :aguardar_http "http://127.0.0.1:%LLAMA_PORT%/v1/models" LLAMA_OK 720 "llama-server"
  if "!LLAMA_OK!"=="1" (
    echo         [OK] llama-server pronto.
    echo         [OK] llama-server pronto. >> "%LOG_FILE%"
  ) else (
    echo         [ERRO] llama-server nao subiu em 12 min. Veja a janela minimizada.
    echo         [ERRO] llama-server nao subiu em 12 min. >> "%LOG_FILE%"
  )
)
call :registrar_pid "%LLAMA_PORT%"

call :verificar_http "http://127.0.0.1:%COMFY_PORT%/" COMFY_OK
if "!COMFY_OK!"=="1" (
  echo   [2/3] ComfyUI ............. JA EM EXECUCAO
  echo   [2/3] ComfyUI ............. JA EM EXECUCAO >> "%LOG_FILE%"
) else (
  echo   [2/3] ComfyUI ............. iniciando ^(1-3 min^)...
  echo   [2/3] ComfyUI ............. iniciando... >> "%LOG_FILE%"
  start "ComfyUI" /min cmd /d "%COMFY_DIR%" /c "%COMFY_BAT%"
  call :aguardar_http "http://127.0.0.1:%COMFY_PORT%/" COMFY_OK 240 "ComfyUI"
  if "!COMFY_OK!"=="1" (
    echo         [OK] ComfyUI pronto.
    echo         [OK] ComfyUI pronto. >> "%LOG_FILE%"
  ) else (
    echo         [ERRO] ComfyUI nao subiu em 4 min. Veja a janela minimizada.
    echo         [ERRO] ComfyUI nao subiu em 4 min. >> "%LOG_FILE%"
  )
)
call :registrar_pid "%COMFY_PORT%"

rem ---- Servidor web: SEMPRE reinicia (garante frontend/backend atualizados) ----
echo   [3/3] servidor web ........ reiniciando...
echo   [3/3] servidor web ........ reiniciando... >> "%LOG_FILE%"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r ":%PORTA% " ^| findstr "LISTENING"') do taskkill /F /PID %%p >nul 2>nul
timeout /t 1 /nobreak >nul 2>nul
start "servidor-historinhas" /min cmd /c "set PORTA=%PORTA%&& node scripts\servidor.mjs"
call :aguardar_http "http://127.0.0.1:%PORTA%/" WEB_OK 30 "servidor web"
if "!WEB_OK!"=="1" (
  echo         [OK] servidor web pronto ^(interface React^).
  echo         [OK] servidor web pronto. >> "%LOG_FILE%"
) else (
  echo         [ERRO] servidor web nao subiu em 30s. Veja a janela minimizada.
  echo         [ERRO] servidor web nao subiu em 30s. >> "%LOG_FILE%"
)
call :registrar_pid "%PORTA%"

rem ---- Resumo ----
echo.
echo ================================================================
if "!LLAMA_OK!"=="1" ( echo   llama-server  : OK ) else ( echo   llama-server  : PROBLEMA )
if "!COMFY_OK!"=="1" ( echo   ComfyUI      : OK ) else ( echo   ComfyUI      : PROBLEMA )
if "!WEB_OK!"=="1"   ( echo   servidor web : OK ) else ( echo   servidor web : PROBLEMA )
echo.
if "!LLAMA_OK!"=="1" if "!COMFY_OK!"=="1" if "!WEB_OK!"=="1" (
  echo   Tudo pronto. Abrindo a interface em http://localhost:%PORTA%
  rem  ?v= quebra cache do navegador (garante o frontend React novo)
  start "" "http://localhost:%PORTA%/?v=%RANDOM%%RANDOM%"
) else (
  echo   Alguns servidores falharam. Verifique as janelas minimizadas
  echo   e o arquivo .iniciar.log para mais detalhes.
  echo   Fechar esta janela encerra os servidores que estao de pe.
)
echo ================================================================
echo.

rem ---- Watchdog: monitora esta janela; ao fecha-la, encerra tudo ----
for /f %%p in ('powershell -NoProfile -Command "(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq $PID }).ParentProcessId"') do set "PAI_PID=%%p"
if defined PAI_PID (
  start "watchdog-historinhas" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$pai=!PAI_PID!;while(Get-Process -Id $pai -ErrorAction SilentlyContinue){Start-Sleep -Seconds 2};$arq='!PIDS_FILE!';if(Test-Path $arq){Get-Content $arq|ForEach-Object{if($_ -match '^\d+$'){Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue}};Remove-Item $arq -Force -ErrorAction SilentlyContinue}"
)

echo  Pressione qualquer tecla para ENCERRAR todos os servidores...
echo  (ou feche esta janela pelo X - os servidores tambem serao encerrados)
pause >nul

rem ---- Encerramento manual ----
if exist "%PIDS_FILE%" (
  echo Encerrando servidores...
  for /f %%p in ("%PIDS_FILE%") do taskkill /F /PID %%p >nul 2>nul
  del /q "%PIDS_FILE%" >nul 2>nul
)
exit /b 0

rem =====================================================================
rem  Sub-rotinas
rem =====================================================================

:verificar_http
powershell -NoProfile -Command "try{$r=Invoke-WebRequest -Uri '%~1' -UseBasicParsing -TimeoutSec 2; exit 0}catch{exit 1}" >nul 2>nul
if errorlevel 1 ( set "%~2=0" ) else ( set "%~2=1" )
exit /b 0

:aguardar_http
rem %1 = URL  %2 = var de saida  %3 = timeout (s)  %4 = rotulo
set /a _rest=%~3
:aguardar_loop
call :verificar_http "%~1" %2
if "!%~2!"=="1" exit /b 0
set /a _rest-=1
if !_rest! leq 0 exit /b 0
if !_rest! gtr 0 if !_rest! lss 600 if !_rest! lss 60 (
  echo         ^(aguardando %~4... %_rest%s restantes^)
  if %_rest%==1 echo         ^(aguardando %~4... %_rest%s restante^)
)
timeout /t 1 /nobreak >nul 2>nul || ping -n 2 127.0.0.1 >nul
goto :aguardar_loop

:registrar_pid
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r ":%1 " ^| findstr "LISTENING"') do (
  if not "%%p"=="" echo %%p >> "%PIDS_FILE%"
  exit /b 0
)
exit /b 0
