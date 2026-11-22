#!/usr/bin/env node
/*
 * sync_asispro.js — Lee la asistencia de AsisPro (SOLO LECTURA) y genera tareo.json
 * para que "Mi tareo" se actualice solo.
 *
 * Requiere Node 18 o superior. No usa librerías externas.
 *
 * Variables de entorno:
 *   ASIS_USER, ASIS_PASS        Cuenta de AsisPro (usa una cuenta de solo lectura)
 *   ASIS_SISTEMA                Valor del campo "sistema" del login (por defecto: asisprod)
 *   ASIS_SEDES                  JSON, ej: [{"id":149,"nombre":"LIMA"}]
 *                               id = número de sede en AsisPro; nombre = como se verá en Mi tareo
 *   DIA_INICIO_PERIODO          Día en que empieza el periodo (por defecto 21: del 21 al 20)
 *   SALIDA                      Archivo de salida (por defecto tareo.json)
 *   ASIS_API                    Base de la API (por defecto https://server.lavoroassistance.pe/api)
 *   ASIS_CAMPO_USUARIO/CLAVE/SISTEMA  Nombres de los campos del login (usuario / clave / sistema)
 *   CHUNK_DIAS                  Días por consulta (por defecto 7)
 *
 * Uso:
 *   node sync_asispro.js                       # periodo actual
 *   node sync_asispro.js --desde 2026-11-21 --hasta 2026-12-20
 *   node sync_asispro.js --archivo respuesta.json   # prueba sin red (convierte un JSON guardado)
 */
'use strict';
const fs = require('fs');

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const CFG = {
  api: env('ASIS_API', 'https://server.lavoroassistance.pe/api').replace(/\/$/, ''),
  user: env('ASIS_USER', ''), pass: env('ASIS_PASS', ''),
  sistema: env('ASIS_SISTEMA', 'asisprod'),
  fUser: env('ASIS_CAMPO_USUARIO', 'usuario'), fPass: env('ASIS_CAMPO_CLAVE', 'clave'), fSis: env('ASIS_CAMPO_SISTEMA', 'sistema'),
  sedes: JSON.parse(env('ASIS_SEDES', '[{"id":149,"nombre":"LIMA"}]')),
  out: env('SALIDA', 'tareo.json'),
  diaCorte: +env('DIA_INICIO_PERIODO', '21'),
  chunk: Math.max(1, +env('CHUNK_DIAS', '7')),
};
const arg = n => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : null; };

/* ---------- Fechas (UTC, sin sorpresas de zona horaria) ---------- */
const p2 = n => String(n).padStart(2, '0');
const isoD = d => `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
const parseD = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const addD = (d, n) => new Date(d.getTime() + n * 864e5);
const WD = ['DOMINGO', 'LUNES', 'MARTES', 'MIÉRCOLES', 'JUEVES', 'VIERNES', 'SÁBADO'];
function periodoActual() {
  const t = new Date(Date.now() - 5 * 36e5); // hora de Lima
  let y = t.getUTCFullYear(), m = t.getUTCMonth();
  if (t.getUTCDate() < CFG.diaCorte) m -= 1;
  const ini = new Date(Date.UTC(y, m, CFG.diaCorte));
  const fin = new Date(Date.UTC(y, m + 1, CFG.diaCorte - 1));
  return [isoD(ini), isoD(fin)];
}

/* ---------- Mismo formato que usa Mi tareo ---------- */
const clean = x => String(x).replace(/[<>&"]/g, '').trim();
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
function meta(raw) {
  if (!raw) return { raw, g: 'X', cat: 'X', st: '', nt: '' };
  const u = raw.toUpperCase(), t = u.match(/^(\d{1,2})[:.](\d{2})/);
  if (t) {
    const cm = u.match(/-(DL|FEL)$/), pr = u.match(/\(([^)]*)\)/), night = /^\d{1,2}[:.]\d{2}\s*N/.test(u);
    return { raw, g: 'work', cat: cm ? cm[1] : 'A', st: t[1].padStart(2, '0') + ':' + t[2], nt: night ? (pr ? pr[1] : '') : null };
  }
  const m = { D: 'D', DESCANSO: 'D', F: 'F', FALTA: 'F', FE: 'FE', FERIADO: 'FE', VAC: 'VAC', VACACIONES: 'VAC', DM: 'DM', LSG: 'LIC', SUSP: 'LIC' }[u];
  return m ? { raw, g: m, cat: m === 'LIC' ? u : m, st: '', nt: '' } : { raw, g: 'O', cat: raw, st: '', nt: '' };
}
function fmtName(s) {
  const p = clean(s).replace(/\s+/g, ' ').split(',').map(x => x.trim().toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()));
  return p.length >= 3 ? p[0] + ' ' + p[1] + ', ' + p.slice(2).join(' ') : p.join(', ');
}
const num = v => { v = parseFloat(v); return isFinite(v) ? v : 0; };
const hhmm = v => { const m = String(v || '').match(/^(\d{1,2}):(\d{2})/); return m ? p2(m[1]) + ':' + m[2] : ''; };
const mins = h => { const [a, b] = h.split(':').map(Number); return a * 60 + b; };

/* Horas nocturnas (22:00–06:00) del turno: se escriben como "(N.NN-N)" igual que el Excel */
function nocturnas(r, ini, fin) {
  const hn = num(r.horasNocturnas); if (hn > 0) return hn;
  if (!ini || !fin) return 0;
  const a = mins(ini); let b = mins(fin); if (b <= a) b += 1440;
  const ov = (x, y) => Math.max(0, Math.min(b, y) - Math.max(a, x));
  return Math.round(((ov(-120, 360) + ov(1320, 1800)) / 60) * 100) / 100;
}

const DESCONOCIDAS = new Set(), SIN_TURNO = new Set();
function codigo(r) {
  const d = norm(r.desAsistencia);
  if (!d) return '';
  const lab = /LABORAD/.test(d);
  const trab = suf => {
    const ini = hhmm(r.turnoIngreso), fin = hhmm(r.turnoSalida);
    if (!ini) { SIN_TURNO.add(r.desAsistencia); return ''; }
    const n = nocturnas(r, ini, fin);
    return n > 0 ? `${ini}N (${n.toFixed(2)}-N)-${suf}` : `${ini}-${suf}`;
  };
  if (/DESC.*MED|^DM\b/.test(d)) return 'DM';
  if (/FERIAD/.test(d)) return lab ? trab('FEL') : 'FE';
  if (/DESCANSO/.test(d)) return lab ? trab('DL') : 'D';
  if (/VACAC/.test(d)) return 'VAC';
  if (/FALTA|INASIST/.test(d)) return 'F';
  if (/SUSPENS/.test(d)) return 'SUSP';
  if (/LICENCIA/.test(d)) return /SIN GOCE|\bLSG\b/.test(d) ? 'LSG' : clean(r.desAsistencia);
  if (/ASISTENCIA|TRABAJ|PRESENTE|LABORAD|TARDANZA/.test(d)) return trab('A');
  DESCONOCIDAS.add(r.desAsistencia);
  return clean(r.desAsistencia);
}

/* ---------- Filas de AsisPro -> una sede de Mi tareo ---------- */
function construirSede(nombre, filas, desde, hasta) {
  const dias = [];
  for (let d = parseD(desde); isoD(d) <= hasta; d = addD(d, 1)) dias.push({ d: isoD(d), w: WD[d.getUTCDay()] });
  const pos = new Map(dias.map((x, i) => [x.d, i]));
  const codes = [], ix = new Map();
  const ci = raw => { if (!ix.has(raw)) { ix.set(raw, codes.length); codes.push(meta(raw)); } return ix.get(raw); };
  ci(''); // "sin dato" siempre en la posición 0

  const personas = new Map();
  for (const r of filas) {
    const i = pos.get(String(r.fecha || '').slice(0, 10));
    if (i === undefined) continue;
    const id = String(r.persona_id || r.dni || r.trabajador);
    const p = personas.get(id) || { n: fmtName(r.trabajador || ''), dni: String(r.dni || '').replace(/\D/g, ''), r: new Array(dias.length).fill(null) };
    const prev = p.r[i];
    // Si hay dos filas el mismo día, gana la modificada más reciente
    if (!prev || String(r.fechaMod || '') >= String(prev.fechaMod || '')) p.r[i] = r;
    personas.set(id, p);
  }

  const people = [];
  for (const p of personas.values()) {
    const s = p.r.map(r => ci(r ? codigo(r) : ''));
    if (s.every(k => codes[k].g === 'X')) continue;
    const o = { n: p.n, i: '' };
    if (p.dni.length >= 6) o.c = [p.dni];
    o.s = s;
    if (p.r.some(r => r && (r.totalhoras != null || r.horasExtra25 != null || r.horasExtra35 != null || r.horasExtra100 != null))) {
      o.h = p.r.map(r => (r ? num(r.totalhoras) : 0));
      o.x = p.r.map(r => (r ? Math.round((num(r.horasExtra25) + num(r.horasExtra35) + num(r.horasExtra100)) * 100) / 100 : 0));
    }
    people.push(o);
  }
  people.sort((a, b) => a.n.localeCompare(b.n, 'es'));
  return { name: nombre, days: dias, codes, people };
}

/* ---------- Conexión a AsisPro (solo login + lectura) ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function http(url, opt, intentos = 3) {
  let err;
  for (let k = 1; k <= intentos; k++) {
    try {
      const r = await fetch(url, { ...opt, signal: AbortSignal.timeout(45000) });
      if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
      return r;
    } catch (e) { err = e; if (k < intentos) await sleep(1500 * k); }
  }
  throw err;
}
async function login() {
  if (!CFG.user || !CFG.pass) throw new Error('Faltan ASIS_USER y ASIS_PASS.');
  const fd = new FormData();
  fd.append(CFG.fUser, CFG.user); fd.append(CFG.fPass, CFG.pass); fd.append(CFG.fSis, CFG.sistema);
  const r = await http(CFG.api + '/login', { method: 'POST', body: fd, headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`El login falló (HTTP ${r.status}). Revisa usuario, clave y los nombres de campo del login.`);
  const j = await r.json();
  if (!j.token) throw new Error('El login respondió sin token.');
  return j.token;
}
async function traerSede(token, id, desde, hasta) {
  const filas = [];
  for (let a = parseD(desde); isoD(a) <= hasta; a = addD(a, CFG.chunk)) {
    const b = addD(a, CFG.chunk - 1), fin = isoD(b) > hasta ? hasta : isoD(b);
    const url = `${CFG.api}/assistance/show/${id}/${isoD(a)}/${fin}?sys=ASISPROD&url=%27/assistance%27`;
    const r = await http(url, { headers: { Accept: 'application/json', Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error(`Sede ${id}, ${isoD(a)} a ${fin}: HTTP ${r.status}`);
    const j = await r.json();
    const arr = Array.isArray(j) ? j : (j.data || j.asistencias || []);
    if (!Array.isArray(arr)) throw new Error('La respuesta de AsisPro no trae una lista de asistencias.');
    filas.push(...arr);
  }
  return filas;
}

/* ---------- Principal ---------- */
(async () => {
  let [desde, hasta] = periodoActual();
  if (arg('desde')) desde = arg('desde');
  if (arg('hasta')) hasta = arg('hasta');
  const sedes = [];

  if (arg('archivo')) {
    const filas = JSON.parse(fs.readFileSync(arg('archivo'), 'utf8'));
    const fechas = filas.map(r => String(r.fecha).slice(0, 10)).sort();
    if (!arg('desde') && fechas.length) desde = fechas[0];
    if (!arg('hasta') && fechas.length) hasta = fechas[fechas.length - 1];
    sedes.push(construirSede(CFG.sedes[0].nombre, filas, desde, hasta));
  } else {
    const token = await login();
    for (const s of CFG.sedes) {
      const filas = await traerSede(token, s.id, desde, hasta);
      if (!filas.length) throw new Error(`AsisPro no devolvió datos para la sede ${s.id} (${s.nombre}); no se toca ${CFG.out}.`);
      const sd = construirSede(s.nombre, filas, desde, hasta);
      if (!sd.people.length) throw new Error(`La sede ${s.nombre} quedó sin personas; no se toca ${CFG.out}.`);
      sedes.push(sd);
      console.log(`${s.nombre}: ${filas.length} registros, ${sd.people.length} personas, ${desde} a ${hasta}`);
    }
  }

  if (DESCONOCIDAS.size) console.warn('Condiciones que no reconozco (aparecen como "Otro" en Mi tareo):', [...DESCONOCIDAS].join(' | '));
  if (SIN_TURNO.size) console.warn('Días de trabajo sin hora de turno (quedan como "sin dato"):', [...SIN_TURNO].join(' | '));

  const nuevo = JSON.stringify(sedes);
  let previo = '';
  try { previo = JSON.stringify(JSON.parse(fs.readFileSync(CFG.out, 'utf8')).sedes); } catch (e) {}
  if (previo === nuevo) { console.log('Sin cambios: ' + CFG.out + ' queda igual.'); return; }
  fs.writeFileSync(CFG.out, JSON.stringify({ generado: new Date().toISOString(), fuente: 'AsisPro', sedes }));
  console.log('Actualizado: ' + CFG.out);
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
