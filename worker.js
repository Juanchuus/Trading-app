// Servidor de alarmas para Cloudflare Workers.
// Revisa tus alarmas cada minuto y responde a Telegram al instante.
const BIN = ['https://data-api.binance.vision', 'https://api.binance.com'];
const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
const TFS = ['1m', '5m', '15m', '1h', '4h', '1d'];
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,x-key', 'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS' };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', ...CORS } });
const limpio = s => String(s || '').trim().replace(/^["']|["']$/g, '');

const leer = async env => (await env.ALARMAS.get('estado', 'json')) || { nextId: 1, alarmas: [], fallos: 0 };
const guardar = (env, st) => env.ALARMAS.put('estado', JSON.stringify(st));
const tg = (env, metodo, cuerpo) => fetch(`https://api.telegram.org/bot${limpio(env.BOT_TOKEN)}/${metodo}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo) }).then(r => r.json()).catch(e => ({ ok: false, description: String(e) }));
const decir = (env, texto, chat) => tg(env, 'sendMessage', { chat_id: chat || limpio(env.CHAT_ID), text: texto });

const signo = x => (x.dir === 'gt' ? '\u2265' : '\u2264');
const texto = x => (x.tipo === 'precio' ? `${x.sym} precio ${signo(x)} ${x.val}` : `${x.sym} RSI 14 (${x.tf}) ${signo(x)} ${x.val}`) + (x.rep ? ' \u00B7 constante' : ' \u00B7 una vez');

function valida(x) {
  if (!x || typeof x !== 'object') return null;
  const o = { tipo: x.tipo, sym: x.sym, dir: x.dir, val: Number(x.val), rep: Boolean(x.rep) };
  if (!['precio', 'rsi'].includes(o.tipo) || !SYMS.includes(o.sym) || !['gt', 'lt'].includes(o.dir) || !Number.isFinite(o.val)) return null;
  if (o.tipo === 'rsi') { if (!TFS.includes(x.tf) || o.val < 0 || o.val > 100) return null; o.tf = x.tf; }
  else if (o.val <= 0) return null;
  return o;
}
function desdePayload(p) {
  const a = p.split('_'), rep = a[a.length - 1] === 'c', num = s => parseFloat(String(s).replace('d', '.'));
  if (a[0] === 'p' && a.length === (rep ? 5 : 4)) return valida({ tipo: 'precio', sym: a[1], dir: a[2], val: num(a[3]), rep });
  if (a[0] === 'r' && a.length === (rep ? 6 : 5)) return valida({ tipo: 'rsi', sym: a[1], dir: a[2], val: num(a[3]), tf: a[4], rep });
  return null;
}
function agregar(st, x) { if (st.alarmas.length >= 30) return null; x.id = st.nextId++; st.alarmas.push(x); return x; }

// Comandos de Telegram. Devuelve [respuesta, huboCambios]
function comando(st, t) {
  if (t.startsWith('/start')) {
    const p = t.split(/\s+/)[1];
    if (!p) return ['Hola \uD83D\uDC4B Crea alarmas desde la app. Comandos: /alarmas, /borrar N, /ayuda', false];
    if (p === 'ping') return [`\uD83C\uDFD3 Conectado \u2705\nAlarmas activas: ${st.alarmas.length}`, false];
    if (p.startsWith('b_')) {
      const i = st.alarmas.findIndex(a => a.id === parseInt(p.slice(2)));
      if (i < 0) return ['No encontr\u00E9 esa alarma (quiz\u00E1 ya se dispar\u00F3 o se borr\u00F3).', false];
      const [y] = st.alarmas.splice(i, 1); return ['\uD83D\uDDD1 Borrada: ' + texto(y), true];
    }
    const x = desdePayload(p);
    if (!x) return ['No entend\u00ED esa alarma.', false];
    if (!agregar(st, x)) return ['M\u00E1ximo 30 alarmas activas.', false];
    return ['\u2705 Alarma creada: ' + texto(x), true];
  }
  if (t.startsWith('/alarmas')) return [st.alarmas.length ? st.alarmas.map((x, i) => `${i + 1}. ${texto(x)}`).join('\n') : 'No tienes alarmas activas.', false];
  if (t.startsWith('/borrar')) {
    const n = t.split(/\s+/)[1];
    if (n === 'todas') { st.alarmas = []; return ['Alarmas borradas.', true]; }
    const i = parseInt(n) - 1;
    if (st.alarmas[i]) { const [x] = st.alarmas.splice(i, 1); return ['\uD83D\uDDD1 Borrada: ' + texto(x), true]; }
    return ['Usa /borrar N o /borrar todas.', false];
  }
  if (t.startsWith('/ayuda')) return ['Comandos:\n/alarmas \u2013 ver tus alarmas\n/borrar N \u2013 borrar la alarma N\n/borrar todas \u2013 borrar todas\nLas alarmas se crean desde la app (campana).', false];
  return [null, false];
}

async function webhook(req, env) {
  if (req.headers.get('x-telegram-bot-api-secret-token') !== limpio(env.ACCESS_KEY)) return new Response('no autorizado', { status: 403 });
  const u = await req.json().catch(() => null), m = u && u.message;
  if (!m) return new Response('ok');
  if (String(m.chat.id) !== limpio(env.CHAT_ID)) {
    await decir(env, `ID de este chat: ${m.chat.id}\nSi eres el due\u00F1o del bot, guarda este n\u00FAmero como CHAT_ID.`, m.chat.id);
    return new Response('ok');
  }
  const st = await leer(env), [resp, cambio] = comando(st, (m.text || '').trim());
  if (cambio) await guardar(env, st);
  if (resp) await decir(env, resp);
  return new Response('ok');
}

async function api(req, env, url) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.headers.get('x-key') !== limpio(env.ACCESS_KEY)) return json({ error: 'clave incorrecta' }, 401);
  const st = await leer(env), ruta = url.pathname;
  if (ruta === '/api/alarmas' && req.method === 'GET') return json({ alarmas: st.alarmas });
  if (ruta === '/api/alarmas' && req.method === 'POST') {
    const x = valida(await req.json().catch(() => null));
    if (!x) return json({ error: 'alarma inv\u00E1lida' }, 400);
    if (!agregar(st, x)) return json({ error: 'm\u00E1ximo 30 alarmas' }, 400);
    await guardar(env, st); await decir(env, '\u2705 Alarma creada: ' + texto(x));
    return json({ ok: true, alarma: x });
  }
  const d = ruta.match(/^\/api\/alarmas\/(\d+)$/);
  if (d && req.method === 'DELETE') {
    const i = st.alarmas.findIndex(a => a.id === parseInt(d[1]));
    if (i < 0) return json({ error: 'no existe' }, 404);
    const [y] = st.alarmas.splice(i, 1); await guardar(env, st); await decir(env, '\uD83D\uDDD1 Borrada: ' + texto(y));
    return json({ ok: true });
  }
  if (ruta === '/api/ping') { await decir(env, `\uD83C\uDFD3 Conectado \u2705\nAlarmas activas: ${st.alarmas.length}`); return json({ ok: true, n: st.alarmas.length }); }
  return json({ error: 'no encontrado' }, 404);
}

async function bin(ruta) {
  let ultimo = 'sin respuesta';
  for (const h of BIN) { try { const r = await fetch(h + ruta); if (r.ok) return await r.json(); ultimo = h.replace('https://', '') + ' ' + r.status; } catch (e) { ultimo = String(e.message || e); } }
  throw new Error(ultimo);
}
function rsi14(c) {
  let g = 0, l = 0, ag = 0, al = 0, r = null;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], u = Math.max(d, 0), w = Math.max(-d, 0);
    if (i <= 14) { g += u; l += w; if (i === 14) { ag = g / 14; al = l / 14; } } else { ag = (ag * 13 + u) / 14; al = (al * 13 + w) / 14; }
    if (i >= 14) r = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return r;
}

async function revisar(env) {
  const st = await leer(env);
  if (!st.alarmas.length) return;
  const cache = {}, quedan = []; let cambio = false, fallo = null;
  for (const x of st.alarmas) {
    try {
      const k = x.tipo === 'precio' ? 'p' + x.sym : 'r' + x.sym + x.tf;
      if (!(k in cache)) cache[k] = x.tipo === 'precio' ? parseFloat((await bin('/api/v3/ticker/price?symbol=' + x.sym)).price) : rsi14((await bin(`/api/v3/klines?symbol=${x.sym}&interval=${x.tf}&limit=500`)).map(a => +a[4]));
      const v = cache[k];
      if (!Number.isFinite(v)) throw new Error('dato inv\u00E1lido');
      const hit = x.dir === 'gt' ? v >= x.val : v <= x.val, dato = `\uD83D\uDD14 ${texto(x)}\nValor actual: ${v.toFixed(x.tipo === 'rsi' ? 1 : (v >= 100 ? 2 : 5))}`;
      if (x.rep) {
        if (hit && !x.esp) { await decir(env, dato); x.esp = true; cambio = true; }
        else if (!hit && x.esp) { x.esp = false; cambio = true; }
        quedan.push(x);
      } else if (hit) { await decir(env, dato); cambio = true; } else quedan.push(x);
    } catch (e) { fallo = String(e.message || e); quedan.push(x); }
  }
  st.alarmas = quedan;
  if (fallo) {
    if ((st.fallos || 0) < 10) {
      st.fallos = (st.fallos || 0) + 1; cambio = true;
      if (st.fallos === 10) await decir(env, '\u26A0\uFE0F Llevo 10 minutos sin poder leer los precios (' + fallo + '). Tus alarmas siguen guardadas.');
    }
  } else if (st.fallos) { st.fallos = 0; cambio = true; }
  if (cambio) await guardar(env, st);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/telegram' && req.method === 'POST') return await webhook(req, env);
      if (url.pathname.startsWith('/api/')) return await api(req, env, url);
      return new Response('Servidor de alarmas activo \u2705', { status: 200 });
    } catch (e) { return json({ error: String(e.message || e) }, 500); }
  },
  async scheduled(evento, env) { await revisar(env); }
};
