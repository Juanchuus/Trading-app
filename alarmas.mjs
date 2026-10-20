// Revisa tus alarmas y te avisa por Telegram. Se ejecuta cada pocos minutos con GitHub Actions.
import fs from 'node:fs';
// Se limpian espacios, saltos de línea, comillas y un "bot" sobrante que a veces se cuelan al pegar los secretos
const TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim().replace(/^["']|["']$/g, '').replace(/^bot/i, '').trim();
const CHAT = String(process.env.TELEGRAM_CHAT_ID || '').trim().replace(/^["']|["']$/g, '');
if (!TOKEN || !CHAT) { console.error('Faltan los secretos TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID'); process.exit(1); }
const FILE = 'alertas.json';
let st = { offset: 0, alarmas: [] };
try { st = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
st.nextId = st.nextId || 1;
(st.alarmas || []).forEach(x => { if (!x.id) x.id = st.nextId++; });
const tg = (m, b) => fetch(`https://api.telegram.org/bot${TOKEN}/${m}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json()).catch(e => ({ ok: false, description: String(e.message || e) }));
const say = async t => { const r = await tg('sendMessage', { chat_id: CHAT, text: t }); if (!r.ok) console.error('sendMessage falló:', r.error_code, r.description); return r; };
const HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];
async function api(p) { for (const h of HOSTS) { try { const r = await fetch(h + p); if (r.ok) return await r.json(); } catch {} } throw new Error('Binance no responde'); }
const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'], TFS = ['1m', '5m', '15m', '1h', '4h', '1d'];
const num = s => parseFloat(String(s).replace('d', '.'));
function parse(p) {
  const a = p.split('_');
  const rep = a[a.length - 1] === 'c'; // al final, "c" = alarma constante
  if (a[0] === 'p' && a.length === (rep ? 5 : 4)) return { tipo: 'precio', sym: a[1], dir: a[2], val: num(a[3]), rep };
  if (a[0] === 'r' && a.length === (rep ? 6 : 5)) return { tipo: 'rsi', sym: a[1], dir: a[2], val: num(a[3]), tf: a[4], rep };
  return null;
}
const valido = x => x && SYMS.includes(x.sym) && ['gt', 'lt'].includes(x.dir) && Number.isFinite(x.val) && (x.tipo === 'precio' || (TFS.includes(x.tf) && x.val >= 0 && x.val <= 100));
const txt = x => (x.tipo === 'precio' ? `${x.sym} precio ${x.dir === 'gt' ? '≥' : '≤'} ${x.val}` : `${x.sym} RSI 14 (${x.tf}) ${x.dir === 'gt' ? '≥' : '≤'} ${x.val}`) + (x.rep ? ' · constante' : ' · una vez');

// 1) Comandos que llegaron al bot
console.log('token: longitud', TOKEN.length, '· formato', /^\d+:[A-Za-z0-9_-]{30,}$/.test(TOKEN) ? 'correcto' : 'INCORRECTO (debe verse como números:letras)');
const me = await tg('getMe', {});
console.log(me.ok ? 'Conectado como @' + me.result.username : 'getMe falló: ' + me.error_code + ' ' + me.description);
const wh = await tg('getWebhookInfo', {});
console.log('webhook activo:', Boolean(wh.result && wh.result.url), '· mensajes pendientes en Telegram:', wh.result ? wh.result.pending_update_count : '?');
const up = await tg('getUpdates', { offset: (st.offset || 0) + 1, timeout: 0, allowed_updates: ['message'] });
if (!up.ok) console.error('getUpdates falló:', up.error_code, up.description);
else console.log('getUpdates ok · mensajes nuevos:', (up.result || []).length, '· alarmas guardadas:', st.alarmas.length);
for (const u of up.result || []) {
  st.offset = u.update_id;
  const m = u.message;
  if (!m || String(m.chat.id) !== CHAT) { // solo te hace caso a ti
    if (m) {
      console.log('mensaje de un chat distinto al configurado en TELEGRAM_CHAT_ID');
      await tg('sendMessage', { chat_id: m.chat.id, text: `ID de este chat: ${m.chat.id}\nSi eres el dueño del bot, guarda este número en el secreto TELEGRAM_CHAT_ID.` });
    }
    continue;
  }
  const t = (m.text || '').trim();
  if (t.startsWith('/start')) {
    const p = t.split(/\s+/)[1];
    if (!p) { await say('Hola 👋 Crea alarmas desde la app. Comandos: /alarmas y /borrar N (o /borrar todas).'); continue; }
    if (p === 'ping') { await say(`🏓 Conectado ✅\nAlarmas activas: ${st.alarmas.length}\nSe revisan cada pocos minutos.`); continue; }
    if (p.startsWith('b_')) {
      const i = st.alarmas.findIndex(a => a.id === parseInt(p.slice(2)));
      if (i < 0) await say('No encontré esa alarma (quizá ya se disparó o se borró).');
      else { const [y] = st.alarmas.splice(i, 1); await say('🗑 Borrada: ' + txt(y)); }
      continue;
    }
    const x = parse(p);
    if (!valido(x)) { await say('No entendí esa alarma.'); continue; }
    if (st.alarmas.length >= 30) { await say('Máximo 30 alarmas activas.'); continue; }
    x.id = st.nextId++;
    st.alarmas.push(x);
    await say('✅ Alarma creada: ' + txt(x) + '\nSe revisa cada pocos minutos.');
  } else if (t.startsWith('/ayuda')) {
    await say('Comandos:\n/alarmas – ver tus alarmas\n/borrar N – borrar la alarma N\n/borrar todas – borrar todas\nLas alarmas se crean desde la app (campana).');
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
    const dato = `🔔 ${txt(x)}\nValor actual: ${v.toFixed(x.tipo === 'rsi' ? 1 : (v >= 100 ? 2 : 5))}`;
    if (x.rep) {
      // Constante: avisa cuando se cumple y vuelve a armarse cuando la condición deja de cumplirse
      if (hit && !x.esp) { await say(dato); x.esp = true; }
      else if (!hit) x.esp = false;
      keep.push(x);
    } else if (hit) await say(dato);
    else keep.push(x);
  } catch (e) { console.error(e.message); keep.push(x); }
}
st.alarmas = keep;
fs.writeFileSync(FILE, JSON.stringify(st, null, 1));
