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
git add index.html supervisor.html
git commit -m "Actualizar portal %date% %time%"
if errorlevel 1 (
    echo No hay cambios nuevos para publicar.
) else (
    git push
)

echo.
echo Listo. Sitio: https://supervisionenaccion-stack.github.io/portal-tecnicos-claro-vtr/
echo.
pause
