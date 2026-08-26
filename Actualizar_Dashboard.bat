@echo off
setlocal
cd /d "%~dp0"

echo ==^> Generando datos y portal...
node generar_portal.js
if errorlevel 1 (
    echo.
    echo ERROR: fallo la generacion del portal. No se publicara nada.
    pause
    exit /b 1
)

echo.
echo ==^> Publicando en GitHub (supervisionenaccion-stack)...
gh auth switch --hostname github.com --user supervisionenaccion-stack
if errorlevel 1 (
    echo.
    echo ERROR: no se pudo cambiar a la cuenta de GitHub supervisionenaccion-stack.
    echo El portal se genero pero NO se publico. Corre "gh auth login" para esa
    echo cuenta y volve a intentar.
    pause
    exit /b 1
)

git add index.html supervisor.html
git commit -m "Actualizar portal %date% %time%"
if errorlevel 1 (
    echo No hay cambios nuevos para publicar.
    echo.
    echo Listo, no habia nada nuevo. Sitio: https://supervisionenaccion-stack.github.io/portal-tecnicos-claro-vtr/
    echo.
    pause
    exit /b 0
)

git push
if errorlevel 1 (
    echo.
    echo El primer intento de subir a GitHub fallo, reintentando en 5 segundos...
    timeout /t 5 /nobreak >nul
    git push
)
if errorlevel 1 (
    echo.
    echo ==============================================================
    echo ERROR: el commit se creo LOCALMENTE pero NO se pudo subir a
    echo GitHub despues de dos intentos. El sitio publico sigue
    echo mostrando datos viejos.
    echo Revisa tu conexion a internet y volve a correr este archivo.
    echo ==============================================================
    echo.
    pause
    exit /b 1
)

echo.
echo Listo y publicado. Sitio: https://supervisionenaccion-stack.github.io/portal-tecnicos-claro-vtr/
echo.
pause
