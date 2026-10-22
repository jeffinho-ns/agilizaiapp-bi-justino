// BI Seu Justino — cache de borda (Cloudflare Worker + KV)
// -----------------------------------------------------------------------------------------------------------------------------------
// O que faz: guarda no KV um "retrato" das leituras da abertura do painel (as mesmas ~33 leituras do bootstrap do Apps Script) e entrega esse
// retrato em poucas centenas de milissegundos. O retrato é renovado a cada 3 minutos (gatilho cron) e também quando alguém o pede e ele está velho.
// O que NÃO faz: não grava nada, não substitui o Apps Script (login, envios e todas as escritas continuam passando por lá) e só entrega o
// retrato a quem tem um "passe" assinado pelo próprio Apps Script (ação getEdgePass, só Diretoria/dono).
//
// Segredos (Configurações do Worker › Variáveis e segredos):  EDGE_SECRET, ROBOT_EMAIL, ROBOT_PASSWORD
// Variáveis de texto:  APPS_SCRIPT_URL, ALLOWED_ORIGINS (endereços do painel, separados por vírgula)
// Vínculo KV:  SNAP  (um namespace de KV)
// -----------------------------------------------------------------------------------------------------------------------------------

const MAX_AGE_MS = 180000; // acima disso o retrato é considerado velho e uma renovação é disparada

// Mesmas leituras do bootCalls() da tela (sem as de administrador). Se mudar lá, mude aqui.
const CALLS = (function () {
  const c = [];
  ['marketing', 'financeiro', 'rh', 'operacao', 'cmv'].forEach(function (a) { c.push({ action: 'getEntries', payload: { area: a, limit: a === 'marketing' ? 60 : 12 } }) });
  c.push(
    { action: 'getMkPlans', payload: {} }, { action: 'getMeterReadings', payload: { limit: 60 } }, { action: 'getZigRevenue', payload: { limit: 2000 } },
    { action: 'getRevenueOverview', payload: {} }, { action: 'getCmvTeoricoParcial', payload: { limit: 30 } }, { action: 'getZigItemSalesRanking', payload: { days: 30 } },
    { action: 'getBandRanking', payload: {} }, { action: 'getZigBilheteria', payload: { limit: 13 } }, { action: 'getEmployees', payload: {} },
    { action: 'getSectorBase', payload: {} }, { action: 'getReservations', payload: { limit: 120 } }, { action: 'getReservationEntries', payload: { limit: 200 } },
    { action: 'getFreelancerRequests', payload: {} }, { action: 'getMonthClosures', payload: {} }, { action: 'getDuvidas', payload: {} }, { action: 'getDreBase', payload: {} },
    { action: 'getDreFaturamentoHistorico', payload: { force: false } }, { action: 'getContatosEmergencia', payload: {} }, { action: 'getEventoCotacoes', payload: {} },
    { action: 'getEventoTarefas', payload: {} }, { action: 'getDocumentacoes', payload: {} }, { action: 'getAuditoriaOpItens', payload: {} }, { action: 'getEventos', payload: {} },
    { action: 'getMkReunioes', payload: {} }
  );
  ['marketing', 'financeiro', 'rh', 'operacao'].forEach(function (a) { c.push({ action: 'getEntries', payload: { area: a, limit: 2000 } }) });
  return c;
})();

// ---------- utilidades ----------
const enc = new TextEncoder();
function b64urlDecode(str) {
  str = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}
function hex(buf) { return Array.from(new Uint8Array(buf)).map(function (b) { return ('0' + b.toString(16)).slice(-2) }).join('') }
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
function igual(a, b) { // comparação em tempo constante
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
// passe = base64url({"e":email,"x":expiraEmMs}) + "." + hmacSha256Hex(EDGE_SECRET, parteBase64)
async function passeValido(env, token) {
  if (!env.EDGE_SECRET || !token || token.indexOf('.') < 0) return null;
  const partes = token.split('.');
  if (partes.length !== 2) return null;
  const esperado = await hmacHex(env.EDGE_SECRET, partes[0]);
  if (!igual(esperado, partes[1])) return null;
  let dados;
  try { dados = JSON.parse(b64urlDecode(partes[0])) } catch (e) { return null }
  if (!dados || !dados.x || Date.now() > Number(dados.x)) return null;
  return dados;
}
function cors(req, env) {
  const origem = req.headers.get('Origin') || '';
  const lista = String(env.ALLOWED_ORIGINS || '').split(',').map(function (s) { return s.trim() }).filter(Boolean);
  const h = { 'Vary': 'Origin', 'Cache-Control': 'no-store' };
  if (origem && lista.indexOf(origem) >= 0) {
    h['Access-Control-Allow-Origin'] = origem;
    h['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}
function json(obj, status, req, env) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors(req, env)) });
}

// ---------- conversa com o Apps Script ----------
async function appsScript(env, corpo, timeoutMs) {
  const res = await fetch(env.APPS_SCRIPT_URL, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(corpo), redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs || 120000)
  });
  return await res.json();
}
async function tokenRobo(env, forcar) {
  if (!forcar) {
    const guardado = await env.SNAP.get('robo', 'json');
    if (guardado && guardado.token && guardado.exp > Date.now() + 3600000) return guardado.token;
  }
  const r = await appsScript(env, { action: 'login', email: env.ROBOT_EMAIL, password: env.ROBOT_PASSWORD }, 60000);
  if (!r || !r.ok || !r.token) throw new Error('login_do_robo_falhou');
  let exp = Date.now() + 6 * 3600000;
  try { exp = Number(b64urlDecode(r.token.split('.')[0]).split('|')[2]) || exp } catch (e) { }
  await env.SNAP.put('robo', JSON.stringify({ token: r.token, exp: exp }));
  return r.token;
}
let renovando = null; // evita duas renovações ao mesmo tempo dentro da mesma instância
async function renovar(env) {
  if (renovando) return renovando;
  renovando = (async function () {
    try {
      let token = await tokenRobo(env, false);
      let r = await appsScript(env, { action: 'bootstrap', token: token, calls: CALLS }, 150000);
      if (r && r.code === 'unauthorized') { token = await tokenRobo(env, true); r = await appsScript(env, { action: 'bootstrap', token: token, calls: CALLS }, 150000) }
      if (!r || !r.ok || !Array.isArray(r.results)) throw new Error('bootstrap_falhou');
      const bons = r.results.filter(function (it) { return it && it.r && it.r.ok }).map(function (it) { return { action: it.action, payload: it.payload, r: it.r } });
      if (!bons.length) throw new Error('bootstrap_vazio');
      await env.SNAP.put('snapshot', JSON.stringify({ ts: Date.now(), results: bons, parcial: !!r.parcial }));
      return { ok: true, itens: bons.length };
    } finally { renovando = null }
  })();
  return renovando;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req, env) });

    // saúde: sem dados, só a idade do retrato
    if (url.pathname === '/status') {
      const snap = await env.SNAP.get('snapshot', 'json');
      return json({ ok: true, temRetrato: !!snap, idadeSegundos: snap ? Math.round((Date.now() - snap.ts) / 1000) : null }, 200, req, env);
    }

    if (url.pathname === '/snapshot') {
      const auth = req.headers.get('Authorization') || '';
      const passe = await passeValido(env, auth.replace(/^Bearer\s+/i, ''));
      if (!passe) return json({ ok: false, code: 'passe_invalido' }, 401, req, env);
      const snap = await env.SNAP.get('snapshot', 'json');
      if (!snap) { ctx.waitUntil(renovar(env).catch(function () { })); return json({ ok: false, code: 'aquecendo' }, 503, req, env) }
      const idade = Date.now() - snap.ts;
      if (idade > MAX_AGE_MS) ctx.waitUntil(renovar(env).catch(function () { }));
      return json({ ok: true, ts: snap.ts, idadeMs: idade, results: snap.results }, 200, req, env);
    }

    return json({ ok: false, code: 'nao_encontrado' }, 404, req, env);
  },

  // gatilho cron: renova o retrato mesmo sem ninguém abrir o painel
  async scheduled(event, env, ctx) {
    ctx.waitUntil(renovar(env).catch(function (e) { console.log('renovar falhou: ' + (e && e.message)) }));
  }
};
