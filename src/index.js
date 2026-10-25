// Lumi AI — the small server between the website chat and Claude.
// It keeps the API key, adds Lumi's rules and the catalog, and limits how much anyone can use it.
import { RULES } from './rules.js';

const MODEL = 'claude-haiku-5-5';
const MAX_TURNS = 12;          // messages kept from the conversation
const MAX_CHARS = 800;         // per visitor message
const MAX_REPLY_TOKENS = 800;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0] || '',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, key: !!env.ANTHROPIC_API_KEY, catalog: !!(await env.LUMI.get('catalog')) }, 200, cors);
    if (url.pathname !== '/chat' || request.method !== 'POST') return json({ error: 'not_found' }, 404, cors);
    if (!allowed.includes(origin)) return json({ error: 'forbidden' }, 403, cors);

    // Limits: per visitor per day, and for the whole site per day (a hard ceiling on spending).
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const day = new Date().toISOString().slice(0, 10);
    const perIp = Number(env.PER_IP_DAILY || 40);
    const perDay = Number(env.SITE_DAILY || 1500);
    const ipKey = `n:${day}:${await hash(ip)}`;
    const dayKey = `n:${day}:all`;
    const [ipCount, dayCount] = await Promise.all([env.LUMI.get(ipKey), env.LUMI.get(dayKey)]);
    if (Number(dayCount || 0) >= perDay) return json({ reply: limitMsg('site') }, 200, cors);
    if (Number(ipCount || 0) >= perIp) return json({ reply: limitMsg('ip') }, 200, cors);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400, cors); }
    const messages = sanitize(body.messages);
    if (!messages.length || messages[messages.length - 1].role !== 'user') return json({ error: 'bad_request' }, 400, cors);
    const page = typeof body.page === 'string' ? body.page.slice(0, 200) : '';

    const catalog = (await env.LUMI.get('catalog')) || (await buildCatalog(env));
    const system = [
      { type: 'text', text: RULES },
      { type: 'text', text: 'CATALOGO (aggiornato ogni notte dal negozio):\n' + catalog, cache_control: { type: 'ephemeral' } },
    ];
    if (page) system.push({ type: 'text', text: `Il visitatore sta guardando questa pagina: ${page}` });

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: env.MODEL || MODEL, max_tokens: MAX_REPLY_TOKENS, system, messages }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      console.log('anthropic error', res.status, detail);
      let type = '';
      try { type = JSON.parse(detail).error.type; } catch {}
      return json({ reply: limitMsg('error'), code: res.status, type }, 200, cors);
    }
    const data = await res.json();
    const reply = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();

    ctx.waitUntil(Promise.all([
      env.LUMI.put(ipKey, String(Number(ipCount || 0) + 1), { expirationTtl: 172800 }),
      env.LUMI.put(dayKey, String(Number(dayCount || 0) + 1), { expirationTtl: 172800 }),
      // Questions only (no IP, no replies), kept 30 days for the weekly review.
      env.LUMI.put(`q:${Date.now()}`, messages[messages.length - 1].content.slice(0, 300), { expirationTtl: 2592000 }),
    ]));
    return json({ reply }, 200, cors);
  },

  // Every night: rebuild the catalog from the public product list of the shop.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(buildCatalog(env));
  },
};

async function buildCatalog(env) {
  const shop = env.SHOP_URL || 'https://www.iluminari3d.com';
  const lines = [];
  for (let page = 1; page <= 10; page++) {
    const r = await fetch(`${shop}/products.json?limit=250&page=${page}`, { headers: { 'User-Agent': 'LumiAI/1.0' } });
    if (!r.ok) break;
    const { products = [] } = await r.json();
    if (!products.length) break;
    for (const p of products) {
      const prices = p.variants.map((v) => Number(v.price)).filter((n) => !isNaN(n));
      const min = Math.min(...prices), max = Math.max(...prices);
      const price = min === max ? euro(min) : `da ${euro(min)} a ${euro(max)}`;
      const available = p.variants.some((v) => v.available);
      const opts = (p.options || []).filter((o) => o.name !== 'Title').map((o) => `${o.name}: ${o.values.slice(0, 12).join(', ')}`).join(' | ');
      const desc = text(p.body_html).slice(0, 380);
      lines.push(`- ${p.title} | ${price}${available ? '' : ' | ESAURITO'} | ${shop}/products/${p.handle}${p.product_type ? ' | tipo: ' + p.product_type : ''}${opts ? ' | opzioni: ' + opts : ''}${desc ? ' | ' + desc : ''}`);
    }
  }
  const catalog = lines.join('\n');
  if (catalog) await env.LUMI.put('catalog', catalog);
  return catalog;
}

function sanitize(list) {
  if (!Array.isArray(list)) return [];
  const out = list
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_TURNS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, m.role === 'user' ? MAX_CHARS : 2000) }));
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

function limitMsg(kind) {
  if (kind === 'error') return 'Ops, mi si è fulminato un filo! Riprova tra poco, oppure scrivici su WhatsApp al 339 464 5623: ti risponde una persona.';
  return 'Per oggi ho chiacchierato tantissimo e devo ricaricarmi! Per qualsiasi domanda scrivici su WhatsApp al 339 464 5623: ti risponde una persona.';
}

function text(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, ' ').trim();
}
function euro(n) { return n.toFixed(2).replace('.', ',') + ' €'; }
async function hash(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}
