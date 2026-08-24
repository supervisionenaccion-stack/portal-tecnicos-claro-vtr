# Portal de Técnicos — Claro/VTR

Cada técnico entra solo con su **ID CAT** (últimos 6 caracteres de su RUT,
K → 0) y ve sus propios indicadores: Calidad (repetidos 30 días),
Derivaciones (Alta/Migración) y Producción RGU. Es un sitio estático local,
sin servidor ni publicación externa.

## Estructura

```
portal-tecnicos/
├── index.html                          ← pagina generada, con el avance del mes en curso
├── template.html                       ← plantilla HTML/CSS/JS (no se edita a mano el index.html)
├── generar_portal.js                   ← consulta la BD y regenera index.html + credenciales
├── Actualizar_Dashboard.bat            ← DOBLE CLIC: corre generar_portal.js
├── Credenciales_Tecnicos_NO_SUBIR.xlsx ← ID CAT de cada tecnico (SOLO local, no se sube)
├── .env.local                          ← credenciales de la base de datos (SOLO local, no se sube)
└── .gitignore
```

## Actualizar

Doble clic en `Actualizar_Dashboard.bat`. Tarda unos minutos porque consulta
la base de datos `Sistemas_local` en vivo.

El técnico necesita ver **cómo van sus indicadores a medida que avanza el
mes**, no el dato de un solo día aislado, así que cada fuente usa un rango
distinto:

- **Derivaciones y RGU** (`MATRIZ_VTR`): mes en curso, desde el día 1 hasta
  el último día con carga completa (el script compara el volumen de filas
  contra los días previos para no incluir un día a medio cargar si se corre
  muy temprano). El número crece día a día hasta cerrar el mes.
- **Calidad** (`CALIDAD_VTR`): el mes calendario **anterior**, completo —
  igual que el reporte mensual ya validado. El indicador de repetido a 30
  días necesita ese tiempo para madurar, así que no se puede mostrar en
  "avance" dentro del mes en curso sin quedar artificialmente bajo.

Ambas fechas quedan indicadas al pie de la página.

## Repartir los accesos a los técnicos

Cada corrida genera `Credenciales_Tecnicos_NO_SUBIR.xlsx` con el ID CAT de
cada técnico (nunca se sube a git — está en `.gitignore`). Es solo para que
se lo repartas a cada técnico; no hay clave adicional, el ID CAT es el
único dato de acceso.

El ID CAT se deriva directamente del RUT, así que es estable mientras el
técnico no cambie de RUT y no requiere manejo de duplicados por nombre como
antes. Aun así, dos RUT distintos podrían coincidir por azar en esos 6
caracteres (con los ~100 técnicos actuales no ha pasado nunca) — si
ocurriera, el script lo advierte en la consola porque uno de los dos
quedaría viendo los datos del otro.

## Privacidad

El RUT completo de los técnicos nunca se embebe en `index.html`: solo se
usa en memoria, al generar el sitio, para calcular el ID CAT y para agrupar
los datos internamente. El objeto que se escribe en el HTML usa el ID CAT
como clave, no el RUT completo.

## Criterios de filtrado (heredados de las consultas Power Query originales)

- **Calidad**: `CALIDAD_VTR`, filtrado por `Fecha_Cierre`, con la lógica de
  vinculación de "orden repetido" más cercano en el tiempo (repetido dentro
  de 30 días), cruzado con `SUPERVISORES_VTR`.
- **Derivaciones**: `MATRIZ_VTR`, técnicos con "cobr"/"cbr" en el campo
  Técnico, con Orden de Trabajo, Tipo de Actividad en {Alta, Migración}.
  Q Órdenes = Estado Completado o No Realizada; Q Derivaciones = Estado No
  Realizada.
- **RGU**: mismo filtro base que Derivaciones pero sin restringir Tipo de
  Actividad. `Completada_GSA` = Orden de Trabajo no nula y Completado, o
  Área derivación = GSA y No Realizada.

## Metas de negocio (ajustar en `generar_portal.js`/`template.html` si cambian)

Tomadas de la tabla "Producción VTR-Claro" que el usuario compartió
(22-ago-2026):

- **Meta Calidad por ciudad** (`META_CALIDAD_POR_CIUDAD` en
  `generar_portal.js`): % máximo de repetidos a 30 días — Arica 4.76%,
  Santiago 5.62%, V Región 5.56%. Estado binario: cumple (✅) o foco
  prioritario (🔴), sin nivel intermedio de atención.
- **Meta RGU diaria por ciudad** (`META_RGU_DIARIA_POR_CIUDAD` en
  `generar_portal.js`): Arica 4.3, Santiago 4, V Región 4. La meta del
  período de cada técnico = meta diaria × cantidad de días distintos en que
  ese técnico completó al menos un GSA (no días calendario del mes — así un
  técnico con menos días trabajados/activos no queda en desventaja). %
  Cumplimiento = RGU Completada GSA ÷ meta del período.
- **Meta Derivaciones** (`META_DERIVACIONES` en `template.html`): oficial,
  no superar 35%.
