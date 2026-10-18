// Revisa tus alarmas y te avisa por Telegram. Se ejecuta cada pocos minutos con GitHub Actions.
import fs from 'node:fs';
const TOKEN = process.env.TELEGRAM_BOT_TOKEN, CHAT = String(process.env.TELEGRAM_CHAT_ID || '');
if (!TOKEN || !CHAT) { console.error('Faltan los secretos TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID'); process.exit(1); }
const FILE = 'alertas.json';
let st = { offset: 0, alarmas: [] };
try { st = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
const tg = (m, b) => fetch(`https://api.telegram.org/bot${TOKEN}/${m}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
const say = t => tg('sendMessage', { chat_id: CHAT, text: t });
const HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];
async function api(p) { for (const h of HOSTS) { try { const r = await fetch(h + p); if (r.ok) return await r.json(); } catch {} } throw new Error('Binance no responde'); }
const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'], TFS = ['1m', '5m', '15m', '1h', '4h', '1d'];
const num = s => parseFloat(String(s).replace('d', '.'));
function parse(p) {
  const a = p.split('_');
  if (a[0] === 'p' && a.length === 4) return { tipo: 'precio', sym: a[1], dir: a[2], val: num(a[3]) };
  if (a[0] === 'r' && a.length === 5) return { tipo: 'rsi', sym: a[1], dir: a[2], val: num(a[3]), tf: a[4] };
  return null;
}
const valido = x => x && SYMS.includes(x.sym) && ['gt', 'lt'].includes(x.dir) && Number.isFinite(x.val) && (x.tipo === 'precio' || (TFS.includes(x.tf) && x.val >= 0 && x.val <= 100));
const txt = x => x.tipo === 'precio' ? `${x.sym} precio ${x.dir === 'gt' ? '≥' : '≤'} ${x.val}` : `${x.sym} RSI 14 (${x.tf}) ${x.dir === 'gt' ? '≥' : '≤'} ${x.val}`;

// 1) Comandos que llegaron al bot
const up = await tg('getUpdates', { offset: (st.offset || 0) + 1, timeout: 0, allowed_updates: ['message'] });
for (const u of up.result || []) {
  st.offset = u.update_id;
  const m = u.message;
  if (!m || String(m.chat.id) !== CHAT) continue; // solo te hace caso a ti
  const t = (m.text || '').trim();
  if (t.startsWith('/start')) {
    const p = t.split(/\s+/)[1];
    if (!p) { await say('Hola 👋 Crea alarmas desde la app. Comandos: /alarmas y /borrar N (o /borrar todas).'); continue; }
    const x = parse(p);
    if (!valido(x)) { await say('No entendí esa alarma.'); continue; }
    if (st.alarmas.length >= 30) { await say('Máximo 30 alarmas activas.'); continue; }
    st.alarmas.push(x);
    await say('✅ Alarma creada: ' + txt(x) + '\nSe revisa cada pocos minutos.');
  } else if (t.startsWith('/alarmas')) {
    await say(st.alarmas.length ? st.alarmas.map((x, i) => `${i + 1}. ${txt(x)}`).join('\n') : 'No tienes alarmas activas.');
  } else if (t.startsWith('/borrar')) {
    const n = t.split(/\s+/)[1];
    if (n === 'todas') { st.alarmas = []; await say('Alarmas borradas.'); }
    else {
      const i = parseInt(n) - 1;
      if (st.alarmas[i]) { const [x] = st.alarmas.splice(i, 1); await say('🗑 Borrada: ' + txt(x)); }
      else await say('Usa /borrar N o /borrar todas.');
    }
  }
}

// 2) Revisar las alarmas contra el mercado
function rsi14(c) {
  let g = 0, l = 0, ag = 0, al = 0, r = null;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], u = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= 14) { g += u; l += dn; if (i === 14) { ag = g / 14; al = l / 14; } }
    else { ag = (ag * 13 + u) / 14; al = (al * 13 + dn) / 14; }
    if (i >= 14) r = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return r;
}
const keep = [];
for (const x of st.alarmas) {
  try {
    let v;
    if (x.tipo === 'precio') v = parseFloat((await api('/api/v3/ticker/price?symbol=' + x.sym)).price);
    else { const k = await api(`/api/v3/klines?symbol=${x.sym}&interval=${x.tf}&limit=500`); v = rsi14(k.map(a => +a[4])); }
    const hit = x.dir === 'gt' ? v >= x.val : v <= x.val;
    if (hit) await say(`🔔 ${txt(x)}\nValor actual: ${v.toFixed(x.tipo === 'rsi' ? 1 : (v >= 100 ? 2 : 5))}`);
    else keep.push(x);
  } catch (e) { console.error(e.message); keep.push(x); }
}
st.alarmas = keep;
fs.writeFileSync(FILE, JSON.stringify(st, null, 1));
