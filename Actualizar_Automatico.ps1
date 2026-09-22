# Actualizacion automatica diaria del portal (la corre el Programador de
# tareas de Windows, tarea "Portal Tecnicos - Actualizacion diaria", 08:00).
# Mismo flujo que Actualizar_Dashboard.bat, pero sin pausas y con controles:
#   1. generar_portal.js  -> consulta la BD y genera los HTML (todo local)
#   2. validar_portal.js  -> si algo no cuadra, NO se publica nada
#   3. commit + push de index.html y supervisor.html (reintenta)
#   4. espera a que el sitio publico muestre la version nueva
#   5. notificacion de Windows con el resultado (exito o error)
# Cada corrida deja su detalle en logs\actualizacion_AAAA-MM-DD.log

$ErrorActionPreference = "Continue"
Set-Location -LiteralPath $PSScriptRoot

$SitioUrl = "https://supervisionenaccion-stack.github.io/portal-tecnicos-claro-vtr/"
$Node = "C:\Program Files\nodejs\node.exe"
$Git = "C:\Program Files\Git\cmd\git.exe"

$LogDir = Join-Path $PSScriptRoot "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir ("actualizacion_" + (Get-Date -Format "yyyy-MM-dd") + ".log")

function Log($texto) {
  $linea = "[" + (Get-Date -Format "HH:mm:ss") + "] " + $texto
  Add-Content -LiteralPath $LogFile -Value $linea -Encoding UTF8
}

function Notificar($titulo, $mensaje) {
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    $esc = { param($s) [System.Security.SecurityElement]::Escape($s) }
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml("<toast duration=`"long`" activationType=`"protocol`" launch=`"$SitioUrl`"><visual><binding template=`"ToastGeneric`"><text>$(& $esc $titulo)</text><text>$(& $esc $mensaje)</text></binding></visual></toast>")
    $appId = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
  } catch {
    Log ("No se pudo mostrar la notificacion: " + $_.Exception.Message)
  }
}

function Correr($exe, [string[]]$argumentos) {
  $salida = & $exe @argumentos 2>&1 | ForEach-Object { "$_" }
  foreach ($l in $salida) { Log ("    " + $l) }
  return @{ Codigo = $LASTEXITCODE; Salida = ($salida -join "`n") }
}

function Fallar($paso, $detalle) {
  Log ("ERROR en " + $paso + ": " + $detalle)
  Notificar "Portal NO actualizado" ("Fallo en " + $paso + ". El sitio sigue con la version anterior. Detalle en logs\" + (Split-Path $LogFile -Leaf))
  exit 1
}

Log "===== Inicio actualizacion automatica ====="

# 1. Generar (procesa todo en este equipo)
Log "1/4 Generando portal desde la base de datos..."
$r = Correr $Node @("generar_portal.js")
if ($r.Codigo -ne 0) { Fallar "la generacion (base de datos)" "generar_portal.js termino con error" }

# 2. Validar antes de publicar
Log "2/4 Validando los archivos generados..."
$r = Correr $Node @("validar_portal.js")
if ($r.Codigo -ne 0) {
  # Se descartan los HTML generados para no dejar una version mala lista para subir.
  Correr $Git @("checkout", "--", "index.html", "supervisor.html") | Out-Null
  Fallar "la validacion" (($r.Salida -split "`n" | Select-Object -Skip 1) -join " ")
}
$resumen = ($r.Salida -split "`n" | Where-Object { $_ -like "VALIDACION OK*" }) -replace "^VALIDACION OK: ", ""
$hashLocal = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $PSScriptRoot "index.html")).Hash

# 3. Publicar
Log "3/4 Publicando en GitHub..."
Correr $Git @("add", "index.html", "supervisor.html") | Out-Null
$r = Correr $Git @("diff", "--cached", "--quiet")
if ($r.Codigo -eq 0) {
  Log "No hay cambios nuevos respecto de lo ya publicado."
  Notificar "Portal sin cambios" "Los datos de hoy son iguales a los ya publicados. $resumen"
  exit 0
}
$r = Correr $Git @("commit", "-m", ("Actualizar portal (automatico) " + (Get-Date -Format "dd-MM-yyyy HH:mm")))
if ($r.Codigo -ne 0) { Fallar "el commit" "git commit fallo" }

$subido = $false
foreach ($intento in 1..3) {
  $r = Correr $Git @("push")
  if ($r.Codigo -eq 0) { $subido = $true; break }
  Log ("Push fallo (intento " + $intento + "), reintentando en 30 s...")
  Start-Sleep -Seconds 30
}
if (-not $subido) { Fallar "la subida a GitHub" "el commit quedo local pero no se pudo subir (revisar internet / credencial)" }

# 4. Confirmar que el sitio publico ya muestra la version nueva
Log "4/4 Esperando que el sitio publico se actualice..."
$enLinea = $false
foreach ($i in 1..20) {
  Start-Sleep -Seconds 30
  try {
    # Se compara el archivo publicado byte a byte (hash) con el generado aqui.
    $resp = Invoke-WebRequest -UseBasicParsing -Uri ($SitioUrl + "index.html?nc=" + [guid]::NewGuid()) -Headers @{ "Cache-Control" = "no-cache" } -TimeoutSec 30
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hashEnLinea = ([BitConverter]::ToString($sha.ComputeHash($resp.RawContentStream.ToArray()))).Replace("-", "")
    if ($hashEnLinea -eq $hashLocal) { $enLinea = $true; break }
  } catch {
    Log ("Consulta al sitio fallo: " + $_.Exception.Message)
  }
}
if (-not $enLinea) {
  Fallar "la confirmacion en linea" "se subio a GitHub pero el sitio no mostro la version nueva en 10 minutos (GitHub Pages puede estar demorado)"
}

Log ("OK: publicado y visible en linea. " + $resumen)
Notificar "Portal actualizado y publicado" $resumen
exit 0
