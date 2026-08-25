// Genera el Portal de Tecnicos Claro/VTR (solo local, sin publicar) con el
// avance del mes en curso (Derivaciones/RGU) y el mes anterior completo
// (Calidad), desde la base de datos Sistemas_local.
// Uso: doble clic en "Actualizar_Dashboard.bat", o `node generar_portal.js`.

const fs = require("fs");
const path = require("path");
const sql = require("mssql");
const ExcelJS = require("exceljs");

// ---------- 0. Cargar variables desde .env.local (sin dependencias extra) ----------
function loadEnvLocal() {
  const envPath = path.join(__dirname, ".env.local");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvLocal();

const config = {
  server: process.env.DB_SERVER,
  port: parseInt(process.env.DB_PORT || "1433", 10),
  database: process.env.DB_DATABASE,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: { encrypt: false, trustServerCertificate: true, connectTimeout: 30000, requestTimeout: 900000 },
};

// ---------- 1. Rangos de fecha: mes a la fecha (avance del mes) ----------
// El tecnico necesita ver como van sus indicadores a medida que avanza el
// mes (no solo el dato de un dia aislado), y que al cerrar el mes el numero
// coincida con un reporte mensual tipo Excel. Por eso:
//  - Derivaciones/RGU (MATRIZ_VTR): mes en curso, desde el dia 1 hasta el
//    ultimo dia con carga completa (para no incluir un dia a medio cargar).
//  - Calidad (CALIDAD_VTR): el mes calendario anterior completo, tal como
//    ya se valido con el usuario ("Calidad Agosto" se mide con cierres de
//    julio, porque el indicador de repetido a 30 dias necesita ese tiempo
//    para madurar). Al ya estar cerrado, no hace falta detectar dias
//    parciales.
function toSqlDate(d) {
  return d.toISOString().slice(0, 10);
}
function dateLabel(d) {
  return d.toLocaleDateString("es-CL", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}
function monthLabel(d) {
  return d.toLocaleDateString("es-CL", { month: "long", year: "numeric", timeZone: "UTC" });
}

function previousMonthRange(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  return { start: toSqlDate(start), end: toSqlDate(end), label: monthLabel(start) };
}

// Elige el ultimo dia con volumen "normal" de datos dentro del mes en curso,
// descartando dias recientes que aun esten a medio cargar (ej: el dia de hoy
// solo tiene una fraccion de las filas esperadas). Compara contra la mediana
// de los dias previos en vez de un umbral fijo, para no depender de un
// numero de filas hardcodeado que puede dejar de ser valido si cambia el
// volumen de datos.
function pickLastCompleteDay(rows, monthStartStr) {
  const sorted = [...rows]
    .map((r) => ({ dia: toSqlDate(new Date(r.dia)), cnt: r.cnt }))
    .sort((a, b) => (a.dia < b.dia ? 1 : -1)); // desc
  if (sorted.length === 0) return monthStartStr;

  const referencia = sorted
    .slice(1, 6)
    .map((r) => r.cnt)
    .filter((c) => c > 0)
    .sort((a, b) => a - b);
  const mediana = referencia.length ? referencia[Math.floor(referencia.length / 2)] : 0;
  const umbral = mediana * 0.5;

  for (const r of sorted) {
    if (r.cnt > 0 && r.cnt >= umbral) return r.dia < monthStartStr ? monthStartStr : r.dia;
  }
  return sorted[0].dia < monthStartStr ? monthStartStr : sorted[0].dia;
}

async function monthToDateRangeMatriz(pool, now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const monthStart = new Date(Date.UTC(y, m, 1));
  const monthStartStr = toSqlDate(monthStart);

  const result = await pool.request().query(`
    SELECT CAST(Fecha AS DATE) AS dia, COUNT(*) AS cnt
    FROM MATRIZ_VTR
    WHERE Fecha >= DATEADD(DAY, -12, CAST(GETDATE() AS DATE))
    GROUP BY CAST(Fecha AS DATE)
  `);
  const lastCompleteDay = pickLastCompleteDay(result.recordset, monthStartStr);
  const endExclusive = toSqlDate(new Date(new Date(lastCompleteDay + "T00:00:00.000Z").getTime() + 24 * 60 * 60 * 1000));
  const label = `1 al ${new Date(lastCompleteDay + "T00:00:00.000Z").getUTCDate()} de ${monthLabel(monthStart)}`;
  return { start: monthStartStr, end: endExclusive, label };
}

// ---------- 2. Consultas: SOLO extraccion, sin CTE/JOIN/GROUP BY en el servidor ----------
// Todo el cruce, la deduplicacion de "repetidos" y las agregaciones se hacen
// en JS mas abajo, para no cargar al servidor con consultas analiticas
// pesadas (window functions, self-joins) sobre tablas de mas de un millon
// de filas.

async function fetchSupervisores(pool) {
  const result = await pool.request().query(`
    SELECT RUT_TECNICO, TECNICO, AGENCIA, SUPERVISOR FROM SUPERVISORES_VTR
  `);
  const map = new Map();
  for (const row of result.recordset) {
    map.set(normalizeRut(row.RUT_TECNICO), row);
  }
  return map;
}

// Filas base del mes objetivo (simple filtro por fecha, sin join ni CTE).
async function fetchCalidadBase(pool, startStr, endStr) {
  const result = await pool
    .request()
    .input("start", sql.Date, startStr)
    .input("end", sql.Date, endStr).query(`
    SELECT [Orden de Trabajo], Rut_Tecnico, NOMBRE_TECNICO, Empresa, Fecha_Cierre
    FROM CALIDAD_VTR
    WHERE Fecha_Cierre >= @start AND Fecha_Cierre < @end
  `);
  return result.recordset;
}

// Filas con vinculo a un "repetido" (en toda la tabla, sin filtro de fecha:
// el repetido puede haberse cerrado en cualquier momento). Simple filtro por
// columna no nula, sin CTE ni window functions.
async function fetchCalidadRepetidos(pool) {
  const result = await pool.request().query(`
    SELECT
        [Orden Repetido],
        [Orden de Trabajo] AS PrimerOrden,
        EsRepetido30Dias,
        Fecha_Cierre AS FechaPrimerCierre,
        Fecha_Cierre_Repetido AS FechaRepetido
    FROM CALIDAD_VTR
    WHERE [Orden Repetido] IS NOT NULL
  `);
  return result.recordset;
}

// Filas base de MATRIZ_VTR para Derivaciones (Alta/Migracion), sin join ni GROUP BY.
async function fetchDerivacionesBase(pool, startStr, endStr) {
  const result = await pool
    .request()
    .input("start", sql.Date, startStr)
    .input("end", sql.Date, endStr).query(`
    SELECT [Rut o Bucket] AS Rut_Tecnico, Estado
    FROM MATRIZ_VTR
    WHERE Fecha >= @start AND Fecha < @end
      AND (Tecnico LIKE '%cobr%' OR Tecnico LIKE '%cbr%')
      AND [Orden de Trabajo] IS NOT NULL
      AND ([Tipo de Actividad] = 'Alta' OR [Tipo de Actividad] LIKE 'Migra%')
  `);
  return result.recordset;
}

// Filas base de MATRIZ_VTR para RGU (todas las actividades), sin join ni GROUP BY.
async function fetchRguBase(pool, startStr, endStr) {
  const result = await pool
    .request()
    .input("start", sql.Date, startStr)
    .input("end", sql.Date, endStr).query(`
    SELECT [Rut o Bucket] AS Rut_Tecnico, Estado, RGU, [Area derivacion], [Orden de Trabajo], Fecha
    FROM MATRIZ_VTR
    WHERE Fecha >= @start AND Fecha < @end
      AND (Tecnico LIKE '%cobr%' OR Tecnico LIKE '%cbr%')
      AND [Orden de Trabajo] IS NOT NULL
  `);
  return result.recordset;
}

// ---------- 2b. Calculo local (replica en JS la logica de las consultas originales) ----------

// Replica RepetidoMasCercano + RN1 + PrimerOrdenUnico + RN2: para cada
// PrimerOrden, se queda con el registro "repetido" cuyo cierre esta mas
// cerca en el tiempo del cierre original (deduplicando cuando hay varias
// filas candidatas para el mismo Orden Repetido o el mismo PrimerOrden).
function buildRepetidoPorPrimerOrden(repRows) {
  function diffSeconds(a, b) {
    if (!a || !b) return Infinity;
    return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 1000);
  }
  function pickClosest(rows) {
    let best = null;
    let bestDiff = Infinity;
    for (const r of rows) {
      const d = diffSeconds(r.FechaPrimerCierre, r.FechaRepetido);
      if (d < bestDiff) {
        bestDiff = d;
        best = r;
      }
    }
    return best;
  }

  // RN1: un ganador por cada [Orden Repetido]
  const porOrdenRepetido = new Map();
  for (const r of repRows) {
    const key = r["Orden Repetido"];
    if (!porOrdenRepetido.has(key)) porOrdenRepetido.set(key, []);
    porOrdenRepetido.get(key).push(r);
  }
  const ganadoresRN1 = [];
  for (const rows of porOrdenRepetido.values()) {
    ganadoresRN1.push(pickClosest(rows));
  }

  // RN2: un ganador por cada PrimerOrden (puede haber varios Orden Repetido
  // distintos apuntando al mismo PrimerOrden)
  const porPrimerOrden = new Map();
  for (const r of ganadoresRN1) {
    const key = r.PrimerOrden;
    if (!porPrimerOrden.has(key)) porPrimerOrden.set(key, []);
    porPrimerOrden.get(key).push(r);
  }
  const resultado = new Map();
  for (const [primerOrden, rows] of porPrimerOrden.entries()) {
    resultado.set(primerOrden, pickClosest(rows));
  }
  return resultado;
}

function calcularCalidad(baseRows, repRows, supervisores) {
  const repetidoPorPrimerOrden = buildRepetidoPorPrimerOrden(repRows);

  // SELECT DISTINCT sobre (Orden de Trabajo, Rut_Tecnico, NOMBRE_TECNICO,
  // Empresa, EsRepetido30Dias, SUPERVISOR)
  const vistos = new Set();
  const porTecnico = new Map();
  const porDia = new Map(); // fecha (yyyy-mm-dd) -> { total, rep, porSupervisor: Map, porAgencia: Map }

  function bucketDia(fecha) {
    if (!porDia.has(fecha)) {
      porDia.set(fecha, { total: 0, rep: 0, porSupervisor: new Map(), porAgencia: new Map() });
    }
    return porDia.get(fecha);
  }
  function sumarGrupo(mapa, clave, esRepetido) {
    if (!clave) return;
    if (!mapa.has(clave)) mapa.set(clave, { total: 0, rep: 0 });
    const g = mapa.get(clave);
    g.total += 1;
    g.rep += esRepetido;
  }

  for (const row of baseRows) {
    const match = repetidoPorPrimerOrden.get(row["Orden de Trabajo"]);
    const esRepetido = match && match.EsRepetido30Dias ? 1 : 0;
    const rut = normalizeRut(row.Rut_Tecnico);
    const sup = supervisores.get(rut);
    const supervisor = sup?.SUPERVISOR ?? null;
    const agencia = sup?.AGENCIA ?? null;

    const dedupeKey = [row["Orden de Trabajo"], rut, row.NOMBRE_TECNICO, row.Empresa, esRepetido, supervisor].join(
      "||"
    );
    if (vistos.has(dedupeKey)) continue;
    vistos.add(dedupeKey);

    if (!porTecnico.has(rut)) {
      porTecnico.set(rut, {
        rut: row.Rut_Tecnico,
        nombre: row.NOMBRE_TECNICO,
        supervisor,
        agencia,
        totalOrdenes: 0,
        repetidos30Dias: 0,
      });
    }
    const t = porTecnico.get(rut);
    t.totalOrdenes += 1;
    t.repetidos30Dias += esRepetido;
    if (!t.supervisor && supervisor) t.supervisor = supervisor;
    if (!t.agencia && agencia) t.agencia = agencia;

    const fecha = toSqlDate(new Date(row.Fecha_Cierre));
    const dia = bucketDia(fecha);
    dia.total += 1;
    dia.rep += esRepetido;
    sumarGrupo(dia.porSupervisor, supervisor, esRepetido);
    sumarGrupo(dia.porAgencia, agencia, esRepetido);
  }
  return { porTecnico: [...porTecnico.values()], porDia };
}

// Construye la serie acumulada de % repetidos dia a dia, cortando en el
// ultimo dia que ya tiene los 30 dias necesarios para madurar (no se
// proyecta ni se muestra la cola inmadura, que se veria artificialmente
// baja porque sus repetidos aun no tuvieron tiempo de ocurrir).
function construirEvolutivoCalidad(porDia, now = new Date()) {
  const fechas = [...porDia.keys()].sort();
  if (fechas.length === 0) return { fechas: [], series: {} };

  const limiteMaduro = toSqlDate(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));
  const fechasMaduras = fechas.filter((f) => f <= limiteMaduro);

  function acumularSerie(extraerGrupo) {
    let total = 0;
    let rep = 0;
    return fechasMaduras.map((f) => {
      const dia = porDia.get(f);
      const g = extraerGrupo(dia);
      if (g) {
        total += g.total;
        rep += g.rep;
      }
      return total ? Math.round((rep / total) * 1000) / 10 : null;
    });
  }

  const supervisoresUnicos = new Set();
  const agenciasUnicas = new Set();
  for (const dia of porDia.values()) {
    for (const k of dia.porSupervisor.keys()) supervisoresUnicos.add(k);
    for (const k of dia.porAgencia.keys()) agenciasUnicas.add(k);
  }

  const porSupervisor = {};
  for (const nombre of supervisoresUnicos) {
    porSupervisor[nombre] = acumularSerie((dia) => dia.porSupervisor.get(nombre));
  }
  const porAgencia = {};
  for (const nombre of agenciasUnicas) {
    porAgencia[nombre] = acumularSerie((dia) => dia.porAgencia.get(nombre));
  }

  return {
    fechas: fechasMaduras,
    todos: acumularSerie((dia) => dia),
    porSupervisor,
    porAgencia,
  };
}

// Meta de calidad (maximo % de repetidos aceptado) por ciudad. Segun tabla
// de Produccion VTR-Claro compartida por el usuario.
const META_CALIDAD_POR_CIUDAD = {
  ARICA: 4.76,
  SANTIAGO: 5.62,
  "V REGION": 5.56,
};
const META_CALIDAD_DEFAULT = 5.31; // promedio general de la tabla, para agencias no listadas

function metaCalidadPorAgencia(agencia) {
  if (agencia && META_CALIDAD_POR_CIUDAD[agencia] != null) return META_CALIDAD_POR_CIUDAD[agencia];
  return META_CALIDAD_DEFAULT;
}

// Meta de produccion RGU por dia, por ciudad. Solo Arica difiere (4.3 vs 4).
const META_RGU_DIARIA_POR_CIUDAD = {
  ARICA: 4.3,
  SANTIAGO: 4,
  "V REGION": 4,
};
const META_RGU_DIARIA_DEFAULT = 4;

function metaRguDiariaPorAgencia(agencia) {
  if (agencia && META_RGU_DIARIA_POR_CIUDAD[agencia] != null) return META_RGU_DIARIA_POR_CIUDAD[agencia];
  return META_RGU_DIARIA_DEFAULT;
}

function calcularDerivaciones(baseRows, supervisores) {
  const porTecnico = new Map();
  for (const row of baseRows) {
    const rut = normalizeRut(row.Rut_Tecnico);
    const sup = supervisores.get(rut);
    if (!porTecnico.has(rut)) {
      porTecnico.set(rut, {
        rut: row.Rut_Tecnico,
        tecnico: sup?.TECNICO ?? null,
        supervisor: sup?.SUPERVISOR ?? null,
        agencia: sup?.AGENCIA ?? null,
        qOrdenes: 0,
        qDerivaciones: 0,
      });
    }
    const t = porTecnico.get(rut);
    if (row.Estado === "Completado" || row.Estado === "No Realizada") t.qOrdenes += 1;
    if (row.Estado === "No Realizada") t.qDerivaciones += 1;
  }
  return [...porTecnico.values()];
}

// La meta de produccion se calcula como (meta diaria segun ciudad) x (dias
// distintos en que el tecnico completo al menos un GSA), no por dias
// calendario del mes -- asi un tecnico con menos dias trabajados/activos
// no queda en desventaja frente a uno que curso todo el mes.
function calcularRgu(baseRows, supervisores) {
  const porTecnico = new Map();
  const diasConGsaPorTecnico = new Map();

  for (const row of baseRows) {
    const rut = normalizeRut(row.Rut_Tecnico);
    const sup = supervisores.get(rut);
    if (!porTecnico.has(rut)) {
      porTecnico.set(rut, {
        rut: row.Rut_Tecnico,
        tecnico: sup?.TECNICO ?? null,
        supervisor: sup?.SUPERVISOR ?? null,
        agencia: sup?.AGENCIA ?? null,
        rguTotal: 0,
        rguCompletadaGsa: 0,
      });
      diasConGsaPorTecnico.set(rut, new Set());
    }
    const t = porTecnico.get(rut);
    const rgu = row.RGU || 0;
    const completadaGsa =
      (row["Orden de Trabajo"] != null && row.Estado === "Completado") ||
      (row["Area derivacion"] === "GSA" && row.Estado === "No Realizada");
    t.rguTotal += rgu;
    if (completadaGsa) {
      t.rguCompletadaGsa += rgu;
      diasConGsaPorTecnico.get(rut).add(toSqlDate(new Date(row.Fecha)));
    }
  }

  const resultado = [];
  for (const [rut, t] of porTecnico.entries()) {
    const diasConGsa = diasConGsaPorTecnico.get(rut).size;
    const metaDiaria = metaRguDiariaPorAgencia(t.agencia);
    const metaPeriodo = metaDiaria * diasConGsa;
    resultado.push({
      ...t,
      diasConGsa,
      metaDiaria,
      metaPeriodo,
      pctCumplimiento: metaPeriodo ? (t.rguCompletadaGsa / metaPeriodo) * 100 : 0,
    });
  }
  return resultado;
}

// ---------- 3. idCAT a partir del RUT (no se publica el RUT completo) ----------
function normalizeRut(rut) {
  return String(rut).trim().toUpperCase().replace(/\./g, "").replace(/-/g, "");
}
// Identificador estable por tecnico: ultimos 6 caracteres del RUT (K -> 0).
// Al derivarse directamente del RUT, se mantiene igual mientras el tecnico
// no cambie de RUT, y aparece automaticamente la primera vez que ese RUT
// se ve en los datos -- no requiere un registro persistente aparte.
function idCatFromRut(rut) {
  const norm = normalizeRut(rut);
  let last6 = norm.slice(-6);
  if (last6.endsWith("K")) last6 = last6.slice(0, -1) + "0";
  return last6;
}
function capitalize(word) {
  if (!word) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}
function usuarioFromNombre(nombreCompleto) {
  const tokens = nombreCompleto.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "Tecnico";
  const nombre = tokens[0];
  let apellido;
  if (tokens.length >= 4) apellido = tokens[2];
  else if (tokens.length === 3) apellido = tokens[1];
  else apellido = tokens[tokens.length - 1];
  return `${capitalize(nombre)} ${capitalize(apellido)}`;
}

// ---------- 4. Main ----------
async function main() {
  console.log("==> Conectando a la base de datos...");
  const pool = await new sql.ConnectionPool(config).connect();

  console.log("==> Calculando rangos de fecha (mes a la fecha)...");
  const rangoMatriz = await monthToDateRangeMatriz(pool);
  const rangoCalidad = previousMonthRange();
  console.log(`==> MATRIZ_VTR (Derivaciones/RGU): ${rangoMatriz.label} [${rangoMatriz.start} a ${rangoMatriz.end})`);
  console.log(`==> CALIDAD_VTR (Calidad): ${rangoCalidad.label} [${rangoCalidad.start} a ${rangoCalidad.end})`);

  console.log("==> Extrayendo datos crudos (sin CTE/JOIN/GROUP BY en el servidor)...");
  const [supervisores, calidadBase, calidadRep, derivBase, rguBase] = await Promise.all([
    fetchSupervisores(pool),
    fetchCalidadBase(pool, rangoCalidad.start, rangoCalidad.end),
    fetchCalidadRepetidos(pool),
    fetchDerivacionesBase(pool, rangoMatriz.start, rangoMatriz.end),
    fetchRguBase(pool, rangoMatriz.start, rangoMatriz.end),
  ]);
  await pool.close();
  console.log(
    `==> Filas extraidas: Calidad=${calidadBase.length} (+${calidadRep.length} repetidos hist.) | Derivaciones=${derivBase.length} | RGU=${rguBase.length} | Supervisores=${supervisores.size}`
  );

  console.log("==> Calculando indicadores localmente...");
  const { porTecnico: calidad, porDia: calidadPorDia } = calcularCalidad(calidadBase, calidadRep, supervisores);
  const derivaciones = calcularDerivaciones(derivBase, supervisores);
  const rgu = calcularRgu(rguBase, supervisores);
  const evolutivoCalidad = construirEvolutivoCalidad(calidadPorDia);
  console.log(
    `==> Tecnicos con datos: Calidad=${calidad.length} | Derivaciones=${derivaciones.length} | RGU=${rgu.length} | Evolutivo: ${evolutivoCalidad.fechas.length} dias maduros`
  );

  // byRut: agrupa las 3 fuentes por RUT (clave interna, nunca se publica)
  const byRut = new Map();

  function getOrCreate(rut, nombre, supervisor, agencia) {
    const key = normalizeRut(rut);
    if (!byRut.has(key)) {
      byRut.set(key, {
        rut,
        nombre,
        supervisor: supervisor || null,
        agencia: agencia || null,
        calidad: null,
        derivaciones: null,
        rgu: null,
      });
    }
    const t = byRut.get(key);
    if (!t.supervisor && supervisor) t.supervisor = supervisor;
    if (!t.agencia && agencia) t.agencia = agencia;
    return t;
  }

  for (const row of calidad) {
    const t = getOrCreate(row.rut, row.nombre, row.supervisor, row.agencia);
    t.calidad = {
      totalOrdenes: row.totalOrdenes,
      repetidos30Dias: row.repetidos30Dias,
      pctRepetidos: row.totalOrdenes ? (row.repetidos30Dias / row.totalOrdenes) * 100 : 0,
      metaCalidad: metaCalidadPorAgencia(row.agencia),
    };
  }
  for (const row of derivaciones) {
    const t = getOrCreate(row.rut, row.tecnico, row.supervisor, row.agencia);
    t.derivaciones = {
      qOrdenes: row.qOrdenes,
      qDerivaciones: row.qDerivaciones,
      pctDerivaciones: row.qOrdenes ? (row.qDerivaciones / row.qOrdenes) * 100 : 0,
    };
  }
  for (const row of rgu) {
    const t = getOrCreate(row.rut, row.tecnico, row.supervisor, row.agencia);
    t.rgu = {
      rguTotal: row.rguTotal,
      rguCompletadaGsa: row.rguCompletadaGsa,
      diasConGsa: row.diasConGsa,
      metaDiaria: row.metaDiaria,
      metaPeriodo: row.metaPeriodo,
      pctCumplimiento: row.pctCumplimiento,
    };
  }

  // ---------- 5. idCAT: usuario digital unico (sin clave adicional) ----------
  // idCAT = ultimos 6 caracteres del RUT (K -> 0). Se deriva directamente
  // del RUT, asi que es estable por tecnico y no requiere manejo de
  // colisiones por nombre repetido como antes. Aun asi, dos RUT distintos
  // podrian coincidir por azar en esos 6 caracteres -- se detecta y se
  // avisa en consola si llegara a pasar, porque silenciaria los datos de
  // un tecnico con los de otro.
  const idCatVistos = new Map();
  const credenciales = []; // para el Excel: nunca se embebe en el HTML
  const dataParaHtml = {}; // clave: idCAT

  for (const t of byRut.values()) {
    const usuario = usuarioFromNombre(t.nombre); // solo para mostrar en el Excel
    const idCat = idCatFromRut(t.rut);

    if (idCatVistos.has(idCat)) {
      console.warn(
        `AVISO: idCAT duplicado "${idCat}" entre "${idCatVistos.get(idCat)}" y "${t.nombre}" -- ` +
          `uno de los dos quedara sin acceso propio en el portal. Revisar sus RUT manualmente.`
      );
    }
    idCatVistos.set(idCat, t.nombre);

    credenciales.push({
      idCat,
      usuario,
      nombre: t.nombre,
      agencia: t.agencia || "",
      supervisor: t.supervisor || "",
    });

    dataParaHtml[idCat] = {
      nombre: t.nombre,
      supervisor: t.supervisor,
      agencia: t.agencia,
      calidad: t.calidad,
      derivaciones: t.derivaciones,
      rgu: t.rgu,
    };
  }

  // ---------- 6. Generar index.html a partir de template.html ----------
  const templatePath = path.join(__dirname, "template.html");
  const template = fs.readFileSync(templatePath, "utf-8");
  const dataCompleta = {
    generadoEl: new Date().toLocaleString("es-CL"),
    periodoCalidad: rangoCalidad.label,
    periodoMatriz: rangoMatriz.label,
    tecnicos: dataParaHtml,
  };
  const html = template.replace("__DATA_JSON__", JSON.stringify(dataCompleta));

  const outPath = path.join(__dirname, "index.html");
  fs.writeFileSync(outPath, html, "utf-8");
  console.log(`==> Generado: ${outPath}`);

  // ---------- 6b. Generar supervisor.html (dashboard de equipos, publico, sin RUT) ----------
  const templateSupPath = path.join(__dirname, "template-supervisor.html");
  const templateSup = fs.readFileSync(templateSupPath, "utf-8");
  const dataSupervisor = {
    generadoEl: dataCompleta.generadoEl,
    periodoCalidad: rangoCalidad.label,
    periodoMatriz: rangoMatriz.label,
    tecnicos: [...byRut.values()].map((t) => ({
      nombre: t.nombre,
      agencia: t.agencia,
      supervisor: t.supervisor,
      calidad: t.calidad,
      derivaciones: t.derivaciones,
      rgu: t.rgu,
    })),
    evolutivoCalidad,
  };
  const htmlSup = templateSup.replace("__DATA_SUPERVISOR_JSON__", JSON.stringify(dataSupervisor));
  const outSupPath = path.join(__dirname, "supervisor.html");
  fs.writeFileSync(outSupPath, htmlSup, "utf-8");
  console.log(`==> Generado: ${outSupPath}`);

  // ---------- 7. Generar Excel de credenciales (NO se sube a git) ----------
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Credenciales");
  ws.columns = [
    { header: "ID CAT", key: "idCat", width: 12 },
    { header: "Nombre completo", key: "nombre", width: 34 },
    { header: "Agencia", key: "agencia", width: 14 },
    { header: "Supervisor", key: "supervisor", width: 30 },
  ];
  ws.getRow(1).font = { bold: true };
  credenciales
    .sort((a, b) => a.nombre.localeCompare(b.nombre))
    .forEach((c) => ws.addRow(c));

  const credPath = path.join(__dirname, "Credenciales_Tecnicos_NO_SUBIR.xlsx");
  try {
    await wb.xlsx.writeFile(credPath);
    console.log(`==> Generado: ${credPath}`);
  } catch (err) {
    console.warn(
      `AVISO: no se pudo escribir ${credPath} (¿está abierto en Excel?). ` +
        `El portal (index.html) se genero igual. Detalle: ${err.message}`
    );
  }

  console.log(`\nListo. ${byRut.size} tecnicos. Calidad: ${rangoCalidad.label} | Derivaciones/RGU: ${rangoMatriz.label}.`);
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
