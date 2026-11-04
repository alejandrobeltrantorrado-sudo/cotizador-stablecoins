// ============================================================================
//  Dashboard de tasas de stablecoins en Colombia (COP ↔ USDT/USDC) vs Buda.
//  Backend propio para Railway. SIN dependencias (http, fs nativos + fetch de Node 18).
//
//  - Captura automática cada N minutos desde CriptoYa (agregador público) y guarda
//    el historial en un archivo JSON persistente (usar un Volume de Railway).
//  - Permite además captura MANUAL de apps sin cotizador público (Plenti, Littio, etc.).
//  - Expone una API para el front y sirve la página.
//
//  ask / totalAsk  = COMPRA (COP -> USDT/USDC)   | menor = más barato = mejor
//  bid / totalBid  = VENTA  (USDT/USDC -> COP)   | mayor = más pesos  = mejor
// ============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data'); // en Railway: monta un Volume aquí
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');   // series de tiempo (capturas automáticas)
const MANUAL_FILE  = path.join(DATA_DIR, 'manual.json');    // cotizaciones manuales (apps sin API)
const CONFIG_FILE  = path.join(DATA_DIR, 'config.json');

// Monedas a seguir y monto de referencia (en unidades de la moneda) para CriptoYa.
const COINS = ['USDT', 'USDC'];
const DEFAULT_CONFIG = { volume: 1000, captureMinutes: 60, hidden: [] };
// Apps que NO tienen cotizador público → se cargan manualmente.
const MANUAL_APPS = ['PLENTI', 'LITTIO', 'WENIA', 'GLOBAL 66', 'VITA WALLET'];
const MAX_SNAPSHOTS_OUT = 2200; // ~90 días a 1/h; recorta el payload del GET (el disco guarda todo)

function ensure() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {} }
function readJSON(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }
function writeJSON(f, obj) { ensure(); fs.writeFileSync(f, JSON.stringify(obj)); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function getConfig() { return Object.assign({}, DEFAULT_CONFIG, readJSON(CONFIG_FILE, {})); }

ensure();
if (!fs.existsSync(HISTORY_FILE)) writeJSON(HISTORY_FILE, []);
if (!fs.existsSync(MANUAL_FILE)) writeJSON(MANUAL_FILE, []);
if (!fs.existsSync(CONFIG_FILE)) writeJSON(CONFIG_FILE, DEFAULT_CONFIG);

// --------------------------------------------------------------------------
//  Captura automática desde CriptoYa
//  Endpoint general: https://criptoya.com/api/{coin}/COP/{volume}
//  Respuesta: { exchangeKey: { ask, totalAsk, bid, totalBid, time }, ... }
// --------------------------------------------------------------------------
let lastCapture = { ts: null, ok: false, detail: '' };

async function fetchCoin(coin, volume) {
  const url = `https://criptoya.com/api/${coin}/COP/${volume}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`${coin}: HTTP ${res.status}`);
  const j = await res.json();
  const out = {};
  for (const [k, v] of Object.entries(j || {})) {
    if (!v || typeof v !== 'object') continue;
    const a = num(v.totalAsk) || num(v.ask);   // compra
    const b = num(v.totalBid) || num(v.bid);   // venta
    if ((a && a > 0) || (b && b > 0)) out[k.toLowerCase()] = { a: a || null, b: b || null };
  }
  return out;
}

async function capture() {
  const cfg = getConfig();
  const snap = { ts: Date.now() };
  let anyOk = false, errs = [];
  for (const coin of COINS) {
    try { snap[coin.toLowerCase()] = await fetchCoin(coin, cfg.volume || 1000); if (Object.keys(snap[coin.toLowerCase()]).length) anyOk = true; }
    catch (e) { snap[coin.toLowerCase()] = {}; errs.push(e.message || String(e)); }
  }
  if (anyOk) {
    const hist = readJSON(HISTORY_FILE, []);
    hist.push(snap);
    writeJSON(HISTORY_FILE, hist);
    lastCapture = { ts: snap.ts, ok: true, detail: `USDT:${Object.keys(snap.usdt || {}).length} USDC:${Object.keys(snap.usdc || {}).length} exch.` };
    console.log(`[capture] ${new Date(snap.ts).toISOString()} ${lastCapture.detail}`);
  } else {
    lastCapture = { ts: Date.now(), ok: false, detail: errs.join(' | ') || 'sin datos' };
    console.log(`[capture] ERROR: ${lastCapture.detail}`);
  }
  return lastCapture;
}

let timer = null;
function scheduleCaptures() {
  if (timer) clearInterval(timer);
  const mins = Math.max(5, Number(getConfig().captureMinutes) || 60);
  timer = setInterval(() => { capture().catch(() => {}); }, mins * 60000);
  console.log(`[schedule] captura automática cada ${mins} min`);
}
// Captura al arrancar (si no hubo una en los últimos 10 min) + programación.
(function boot() {
  const hist = readJSON(HISTORY_FILE, []);
  const last = hist.length ? hist[hist.length - 1].ts : 0;
  if (last) lastCapture = { ts: last, ok: true, detail: 'desde historial' };
  if (Date.now() - last > 10 * 60000) capture().catch(() => {});
  scheduleCaptures();
})();

// --------------------------------------------------------------------------
//  HTTP
// --------------------------------------------------------------------------
function authed(url, req) {
  if (!APP_PASSWORD) return true;
  const key = url.searchParams.get('key') || req.headers['x-app-key'] || '';
  return key === APP_PASSWORD;
}
function sendJSON(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise((r) => { let d = ''; req.on('data', (c) => { d += c; if (d.length > 2e6) req.destroy(); }); req.on('end', () => r(d)); }); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (p === '/health') return sendJSON(res, 200, { ok: true, lastCapture });
    if (p === '/api/needkey') return sendJSON(res, 200, { needKey: !!APP_PASSWORD });

    if (!authed(url, req)) return sendJSON(res, 401, { error: 'clave requerida' });

    if (p === '/api/data' && req.method === 'GET') {
      const hist = readJSON(HISTORY_FILE, []);
      const manual = readJSON(MANUAL_FILE, []);
      const out = hist.length > MAX_SNAPSHOTS_OUT ? hist.slice(-MAX_SNAPSHOTS_OUT) : hist;
      return sendJSON(res, 200, {
        history: out, manual, config: getConfig(), manualApps: MANUAL_APPS,
        lastCapture, generatedAt: Date.now(),
      });
    }

    // Forzar una captura ahora.
    if (p === '/api/capture' && req.method === 'POST') {
      const r = await capture();
      return sendJSON(res, 200, { ok: r.ok, lastCapture: r });
    }

    // Alta manual.
    if (p === '/api/manual' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(await readBody(req) || '{}'); } catch { return sendJSON(res, 400, { error: 'JSON inválido' }); }
      const app = String(b.app || '').trim();
      const coin = String(b.coin || '').toUpperCase();
      const side = String(b.side || '').toLowerCase();
      const rate = num(b.rate);
      if (!app || !COINS.includes(coin) || !['buy', 'sell'].includes(side) || !(rate > 0))
        return sendJSON(res, 400, { error: 'app, coin (USDT/USDC), side (buy/sell) y rate válidos son obligatorios' });
      const fecha = b.fecha || null, hora = b.hora || null;
      const dt = new Date(`${fecha || ''}T${hora || '00:00'}:00`);
      const ts = isNaN(dt.getTime()) ? Date.now() : dt.getTime();
      const manual = readJSON(MANUAL_FILE, []);
      const entry = { id: 'm' + Date.now() + Math.random().toString(36).slice(2, 6), app, coin, side, rate, fecha, hora, ts };
      manual.push(entry);
      writeJSON(MANUAL_FILE, manual);
      return sendJSON(res, 200, { ok: true, entry });
    }

    if (p === '/api/manual/update' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(await readBody(req) || '{}'); } catch { return sendJSON(res, 400, { error: 'JSON inválido' }); }
      if (!b.id) return sendJSON(res, 400, { error: 'id requerido' });
      const manual = readJSON(MANUAL_FILE, []);
      const m = manual.find((x) => x.id === b.id);
      if (!m) return sendJSON(res, 404, { error: 'registro no encontrado' });
      if (b.app != null && String(b.app).trim()) m.app = String(b.app).trim();
      if (b.coin != null && COINS.includes(String(b.coin).toUpperCase())) m.coin = String(b.coin).toUpperCase();
      if (b.side != null && ['buy', 'sell'].includes(String(b.side).toLowerCase())) m.side = String(b.side).toLowerCase();
      if (b.rate != null && num(b.rate) > 0) m.rate = num(b.rate);
      if (b.fecha != null) m.fecha = b.fecha || m.fecha;
      if (b.hora != null) m.hora = b.hora || m.hora;
      const dt = new Date(`${m.fecha || ''}T${m.hora || '00:00'}:00`);
      if (!isNaN(dt.getTime())) m.ts = dt.getTime();
      writeJSON(MANUAL_FILE, manual);
      return sendJSON(res, 200, { ok: true, entry: m });
    }

    if (p === '/api/manual/delete' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(await readBody(req) || '{}'); } catch { return sendJSON(res, 400, { error: 'JSON inválido' }); }
      if (!b.id) return sendJSON(res, 400, { error: 'id requerido' });
      const manual = readJSON(MANUAL_FILE, []);
      const next = manual.filter((x) => x.id !== b.id);
      writeJSON(MANUAL_FILE, next);
      return sendJSON(res, 200, { ok: true, deleted: manual.length - next.length });
    }

    // Importar respaldo de manuales (fusiona por id).
    if (p === '/api/manual/import' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(await readBody(req) || '{}'); } catch { return sendJSON(res, 400, { error: 'JSON inválido' }); }
      const incoming = Array.isArray(b) ? b : (Array.isArray(b.manual) ? b.manual : null);
      if (!incoming) return sendJSON(res, 400, { error: 'se esperaba {manual:[...]}' });
      const cur = readJSON(MANUAL_FILE, []);
      const byId = new Map(cur.map((x) => [x.id, x]));
      let added = 0, updated = 0, skipped = 0;
      for (const raw of incoming) {
        const app = String(raw && raw.app || '').trim();
        const coin = String(raw && raw.coin || '').toUpperCase();
        const side = String(raw && raw.side || '').toLowerCase();
        const rate = num(raw && raw.rate);
        if (!app || !COINS.includes(coin) || !['buy', 'sell'].includes(side) || !(rate > 0)) { skipped++; continue; }
        let ts = num(raw.ts);
        if (!(ts > 0)) { const dt = new Date(`${raw.fecha || ''}T${raw.hora || '00:00'}:00`); ts = isNaN(dt.getTime()) ? Date.now() : dt.getTime(); }
        const id = raw.id || ('m' + ts + Math.random().toString(36).slice(2, 6));
        const entry = { id, app, coin, side, rate, fecha: raw.fecha || null, hora: raw.hora || null, ts };
        if (byId.has(id)) updated++; else added++;
        byId.set(id, entry);
      }
      writeJSON(MANUAL_FILE, [...byId.values()].sort((a, b) => a.ts - b.ts));
      return sendJSON(res, 200, { ok: true, added, updated, skipped, total: byId.size });
    }

    if (p === '/api/config' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(await readBody(req) || '{}'); } catch { return sendJSON(res, 400, { error: 'JSON inválido' }); }
      const cfg = getConfig();
      if (b.volume != null) { const v = num(b.volume); if (v > 0) cfg.volume = v; }
      if (b.captureMinutes != null) { const m = num(b.captureMinutes); if (m >= 5) cfg.captureMinutes = m; }
      if (Array.isArray(b.hidden)) cfg.hidden = [...new Set(b.hidden.map((s) => String(s).toLowerCase().trim()).filter(Boolean))];
      writeJSON(CONFIG_FILE, cfg);
      if (b.captureMinutes != null) scheduleCaptures();
      return sendJSON(res, 200, { ok: true, config: cfg });
    }

    if (req.method === 'GET') {
      let html = null; try { html = fs.readFileSync(path.join(__dirname, 'index.html')); } catch {}
      if (html) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html); }
      res.writeHead(404); return res.end('index.html no encontrado en el servidor');
    }
    res.writeHead(404); return res.end('No encontrado');
  } catch (err) { sendJSON(res, 502, { error: String(err && err.message || err) }); }
});
server.listen(PORT, () => console.log(`Dashboard stablecoins COP en :${PORT} — datos en ${DATA_DIR}${APP_PASSWORD ? ' — con clave' : ''}`));
