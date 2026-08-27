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
rem gh auth switch es solo por prolijidad (para que "gh" en general apunte a
rem la cuenta correcta si se usa a mano); el push en si NO depende de esto,
rem porque este repo tiene su propia credencial guardada localmente
rem (ver .git/config y .git/credentials-local). Por eso no se corta el
rem script si el switch falla -- antes eso hacia que el .bat abortara aunque
rem el push hubiera funcionado igual.
gh auth switch --hostname github.com --user supervisionenaccion-stack >nul 2>&1

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
