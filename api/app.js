const crypto = require("crypto");

// ===== Settings (can be overridden with Vercel env variables) =====
const BRAND = process.env.BRAND_NAME || "My Business";
const BTC = (process.env.BTC_ADDRESS || "15LXQpFN8pFXv8LQ9nC7ZUqfC7Ycoedwvt").trim();
const MIN_USD = +process.env.MIN_USD || 5;
const CONFS = Math.max(1, +process.env.BTC_CONFIRMATIONS || 1);
const EXPIRY_MS = 30 * 60 * 1000;
// ==================================================================

const U = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const T = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const PW = process.env.ADMIN_PASSWORD || "";
const SEC = process.env.SESSION_SECRET || PW;

async function db(cmd) {
  const r = await fetch(U, { method: "POST", headers: { Authorization: "Bearer " + T }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
const sign = (v) => crypto.createHmac("sha256", SEC).update(v).digest("hex");
const eq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rid = () => crypto.randomBytes(6).toString("hex");

function authed(req) {
  const m = /(?:^|; )adm=([^;]+)/.exec(req.headers.cookie || "");
  if (!m || !PW) return false;
  const p = m[1].split(".");
  return p.length === 2 && Date.now() < +p[0] && eq(p[1], sign(p[0]));
}
const send = (res, code, type, body) => { res.statusCode = code; res.setHeader("Content-Type", type); res.setHeader("Cache-Control", "no-store"); res.end(body); };
const json = (res, code, o) => send(res, code, "application/json", JSON.stringify(o));
const html = (res, s, code) => send(res, code || 200, "text/html; charset=utf-8", s);

async function btcUsd() {
  try { const j = await (await fetch("https://mempool.space/api/v1/prices", { signal: AbortSignal.timeout(5000) })).json(); if (j.USD) return +j.USD; } catch (e) {}
  const c = await (await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd", { signal: AbortSignal.timeout(5000) })).json();
  return +c.bitcoin.usd;
}
async function esplora(p) {
  for (const h of ["https://mempool.space/api", "https://blockstream.info/api"]) {
    try { const r = await fetch(h + p, { signal: AbortSignal.timeout(6000) }); if (r.ok) return await r.json(); } catch (e) {}
  }
  throw new Error("explorer unavailable");
}
async function pstatus(r) {
  try {
    const [txs, tip] = await Promise.all([esplora("/address/" + BTC + "/txs"), esplora("/blocks/tip/height")]);
    let seen = null;
    for (const tx of txs) {
      if (!tx.vout.some((o) => o.scriptpubkey_address === BTC && o.value === r.sats)) continue;
      const used = await db(["GET", "tx:" + tx.txid]);
      if (used && used !== r.id) continue;
      if (tx.status.confirmed) {
        if (tx.status.block_time * 1000 < r.t - 3600000) continue;
        if (tip - tx.status.block_height + 1 >= CONFS) return { s: "PAID", txid: tx.txid };
      }
      seen = tx.txid;
    }
    return seen ? { s: "SEEN", txid: seen } : { s: "PENDING" };
  } catch (e) { return { s: "UNKNOWN" }; }
}
async function checkOne(r) {
  if (r.st !== "pending") return r;
  const p = await pstatus(r);
  if (p.s === "UNKNOWN") return r;
  if (p.s === "PAID") {
    const ok = (await db(["SETNX", "tx:" + p.txid, r.id])) || (await db(["GET", "tx:" + p.txid])) === r.id;
    if (ok) { r.st = "paid"; r.txid = p.txid; r.pt = Date.now(); await db(["HSET", "inv", r.id, JSON.stringify(r)]); return r; }
  }
  if (p.s === "SEEN" && !r.seen) { r.seen = true; r.txid = p.txid; await db(["HSET", "inv", r.id, JSON.stringify(r)]); }
  if (!r.seen && Date.now() > r.exp) { r.st = "expired"; await db(["HSET", "inv", r.id, JSON.stringify(r)]); }
  return r;
}
const hgetall = async (k) => { const a = await db(["HGETALL", k]) || [], o = []; for (let i = 1; i < a.length; i += 2) { try { o.push(JSON.parse(a[i])); } catch (e) {} } return o; };

const CSS = `:root{--bg:#0e1116;--card:#171c24;--ink:#eef1f5;--mu:#8b96a5;--ln:#2a313c;--ac:#f7931a}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}main{max-width:460px;margin:0 auto;padding:20px 16px 60px}.wide{max-width:900px}h1{font-size:1.4rem;margin:.2em 0}h2{font-size:1.1rem}.card{background:var(--card);border:1px solid var(--ln);border-radius:14px;padding:18px;margin:14px 0}.mu{color:var(--mu);font-size:.92rem}input,button{font:inherit;border-radius:10px;border:1px solid var(--ln);padding:12px;width:100%;margin:6px 0;background:#0b0e13;color:var(--ink)}button{background:var(--ac);color:#111;font-weight:700;border:0;cursor:pointer}button.s{background:#262d38;color:var(--ink)}button:disabled{opacity:.5}.warn{background:#2a2110;border:1px solid #5b4514;color:#f3d28a;border-radius:10px;padding:10px;font-size:.88rem;margin:12px 0}.er{color:#ff7b72}.adr{word-break:break-all;font-family:monospace;background:#0b0e13;border:1px solid var(--ln);border-radius:10px;padding:10px;margin:8px 0;font-size:.9rem}.qr{background:#fff;padding:12px;border-radius:12px;display:flex;justify-content:center;margin:12px 0}.big{font-size:2.2rem;font-weight:800;text-align:center}table{width:100%;border-collapse:collapse;font-size:.88rem}td,th{text-align:left;padding:8px 6px;border-bottom:1px solid var(--ln)}.ok{color:#3ddc84}[hidden]{display:none!important}`;
const page = (title, body, script) => '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + "</title><style>" + CSS + "</style></head><body>" + body + (script || "") + "</body></html>";

function payPage(l) {
  const body = '<main><div class="mu">' + esc(BRAND) + '</div><h1>Pay ' + esc(l.name) + "</h1>" +
    (l.desc ? '<p class="mu">' + esc(l.desc) + "</p>" : "") +
    '<div class="warn">Bitcoin payments are final and cannot be reversed. Pay only if you know and trust the recipient and you understand what you are paying for.</div>' +
    '<section id="s1" class="card"><label class="mu">Amount (USD)</label><input id="amt" type="number" inputmode="decimal" min="' + MIN_USD + '" step="0.01" placeholder="Amount in USD"' + (l.usd ? ' value="' + l.usd + '" readonly' : "") + '><div class="mu">Minimum $' + MIN_USD + '</div><button id="go">Continue</button><p class="er" id="er" hidden></p></section>' +
    '<section id="s2" class="card" hidden><div class="big" id="top"></div><p class="mu" id="sats" style="text-align:center"></p><div class="qr"><div id="qr"></div></div><div class="adr" id="adr"></div><button class="s" id="cp">Copy address</button><button class="s" id="cp2">Copy BTC amount</button><p class="mu">Send <b>exactly</b> the BTC amount shown, to this address, from any Bitcoin wallet. Time left: <b id="cd">30:00</b></p><p id="stt" class="mu"></p></section>' +
    '<section id="s3" class="card" hidden><h1 class="ok">Payment received</h1><p class="mu" id="done"></p></section></main>';
  const js = '<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script><script>' +
    "var SLUG=" + JSON.stringify(l.slug) + ";" + `
var $=function(i){return document.getElementById(i)},iid,exp,addr,btc,tm,pl;
function show(s){['s1','s2','s3'].forEach(function(x){$(x).hidden=x!==s})}
$('go').onclick=function(){var er=$('er');er.hidden=true;var usd=parseFloat($('amt').value);var b=$('go');b.disabled=true;
fetch('/api/invoice',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:SLUG,usd:usd})})
.then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'Error');return j})})
.then(function(j){iid=j.id;exp=j.exp;addr=j.addr;btc=j.btc;$('top').textContent='$'+usd.toFixed(2);$('sats').textContent=j.btc+' BTC (1 BTC = $'+Math.round(j.price).toLocaleString()+')';$('adr').textContent=j.addr;
$('qr').innerHTML='';if(window.QRCode)new QRCode($('qr'),{text:j.uri,width:220,height:220});
$('stt').textContent='Waiting for your payment...';show('s2');tick();tm=setInterval(tick,1000);pl=setInterval(poll,5000)})
.catch(function(e){er.textContent=e.message;er.hidden=false}).then(function(){b.disabled=false})};
function tick(){var s=Math.max(0,Math.round((exp-Date.now())/1000));$('cd').textContent=String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')}
function poll(){fetch('/api/check?id='+iid).then(function(r){return r.json()}).then(function(j){
if(j.st==='paid'){clearInterval(tm);clearInterval(pl);$('done').textContent='We received $'+Number(j.usd).toFixed(2)+'. Thank you.';show('s3')}
else if(j.st==='expired'){clearInterval(tm);clearInterval(pl);$('stt').textContent='This request expired. Reload the page to start again.'}
else if(j.seen)$('stt').textContent='Payment detected. Waiting for network confirmation...'}).catch(function(){})}
function cpy(t,b,o){navigator.clipboard.writeText(t).then(function(){b.textContent='Copied';setTimeout(function(){b.textContent=o},1500)})}
$('cp').onclick=function(){cpy(addr,this,'Copy address')};$('cp2').onclick=function(){cpy(btc,this,'Copy BTC amount')};
` + "</script>";
  return page("Pay " + l.name, body, js);
}

const loginPage = () => page("Admin", '<main><h1>' + esc(BRAND) + ' admin</h1><div class="card"><input id="pw" type="password" placeholder="Password"><button id="b">Log in</button><p class="er" id="er" hidden></p></div></main>',
  `<script>document.getElementById('b').onclick=function(){fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})}).then(function(r){if(r.ok)location.reload();else{var e=document.getElementById('er');e.textContent='Wrong password';e.hidden=false}})}</script>`);

const adminPage = () => page("Dashboard", '<main class="wide"><h1>' + esc(BRAND) + ' dashboard</h1>' +
  '<div class="card"><h2>Create payment link</h2><input id="n" placeholder="Name (who/what is being paid, e.g. Logo design - Acme)"><input id="d" placeholder="Description shown to payer (what the payment is for)"><input id="f" type="number" step="0.01" placeholder="Fixed amount in USD (optional)"><button id="mk">Create link</button><p class="er" id="er" hidden></p></div>' +
  '<div class="card"><h2>Links</h2><div id="links" class="mu">Loading...</div></div>' +
  '<div class="card"><h2>Invoices</h2><div style="overflow-x:auto"><table><thead><tr><th>Time</th><th>Link</th><th>USD</th><th>BTC</th><th>Status</th></tr></thead><tbody id="inv"></tbody></table></div></div>' +
  '<button class="s" id="lo">Log out</button></main>',
  `<script>
var $=function(i){return document.getElementById(i)};
function el(t,x){var e=document.createElement(t);if(x!=null)e.textContent=x;return e}
function api(m,u,b){return fetch(u,{method:m,headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined}).then(function(r){return r.json().then(function(j){if(!r.ok){var e=new Error(j.error||'Error');e.status=r.status;throw e}return j})})}
function load(){api('GET','/api/dash').then(function(d){
var L=$('links');L.innerHTML='';if(!d.links.length)L.textContent='No links yet.';
d.links.forEach(function(l){var u=location.origin+'/p/'+l.slug,w=el('div');w.style.cssText='border-bottom:1px solid #2a313c;padding:8px 0';
w.appendChild(el('b',l.name+(l.usd?' ($'+l.usd+')':'')));w.appendChild(el('div',u,'mu')).style.wordBreak='break-all';
var b=el('button','Copy link');b.className='s';b.onclick=function(){navigator.clipboard.writeText(u);b.textContent='Copied'};w.appendChild(b);
var x=el('button','Delete');x.className='s';x.onclick=function(){if(confirm('Delete this link?'))api('POST','/api/links/delete',{slug:l.slug}).then(load)};w.appendChild(x);L.appendChild(w)});
var B=$('inv');B.innerHTML='';d.inv.forEach(function(i){var r=el('tr');[new Date(i.t).toLocaleString(),i.name,'$'+i.usd.toFixed(2),i.btc,i.st==='pending'&&i.seen?'detected':i.st].forEach(function(v){r.appendChild(el('td',v))});B.appendChild(r)})
}).catch(function(e){if(e.status===401)location.reload()})}
$('mk').onclick=function(){var er=$('er');er.hidden=true;api('POST','/api/links',{name:$('n').value,desc:$('d').value,usd:$('f').value}).then(function(){$('n').value='';$('d').value='';$('f').value='';load()}).catch(function(e){er.textContent=e.message;er.hidden=false})};
$('lo').onclick=function(){api('POST','/api/logout').then(function(){location.reload()})};
load();setInterval(load,15000);
</script>`);

module.exports = async (req, res) => {
  try {
    let path = req.query && req.query.path != null ? String(Array.isArray(req.query.path) ? req.query.path.join("/") : req.query.path) : new URL(req.url, "http://x").pathname;
    path = "/" + path.replace(/^\/+|\/+$/g, "");
    const q = new URL(req.url, "http://x").searchParams;
    let body = req.body; if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } } body = body || {};

    const miss = [!U && "KV_REST_API_URL", !T && "KV_REST_API_TOKEN", !PW && "ADMIN_PASSWORD"].filter(Boolean);
    if (miss.length) return html(res, page("Setup", '<main><h1>Setup needed</h1><p class="mu">Add these environment variables in Vercel, then redeploy:</p><div class="adr">' + esc(miss.join(", ")) + "</div></main>"), 500);

    if (path === "/") { res.statusCode = 302; res.setHeader("Location", "/admin"); return res.end(); }
    if (path === "/admin") return html(res, authed(req) ? adminPage() : loginPage());

    if (path === "/api/login" && req.method === "POST") {
      if (!eq(body.password || "", PW)) return json(res, 401, { error: "Wrong password" });
      const e = Date.now() + 7 * 864e5;
      res.setHeader("Set-Cookie", "adm=" + e + "." + sign(String(e)) + "; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800");
      return json(res, 200, { ok: 1 });
    }
    if (path === "/api/logout") { res.setHeader("Set-Cookie", "adm=; HttpOnly; Secure; Path=/; Max-Age=0"); return json(res, 200, { ok: 1 }); }

    if (path.startsWith("/api/dash") || path.startsWith("/api/links")) {
      if (!authed(req)) return json(res, 401, { error: "Login required" });
      if (path === "/api/dash") {
        const links = (await hgetall("links")).sort((a, b) => b.t - a.t);
        let inv = (await hgetall("inv")).sort((a, b) => b.t - a.t).slice(0, 100);
        inv = await Promise.all(inv.map((r, i) => (i < 5 && r.st === "pending" ? checkOne(r).catch(() => r) : r)));
        return json(res, 200, { links, inv });
      }
      if (path === "/api/links" && req.method === "POST") {
        const name = String(body.name || "").trim().slice(0, 80), desc = String(body.desc || "").trim().slice(0, 200), usd = +body.usd || 0;
        if (!name) return json(res, 400, { error: "Name is required" });
        if (usd && usd < MIN_USD) return json(res, 400, { error: "Minimum amount is $" + MIN_USD });
        const l = { slug: rid(), name, desc, usd, t: Date.now() };
        await db(["HSET", "links", l.slug, JSON.stringify(l)]);
        return json(res, 200, l);
      }
      if (path === "/api/links/delete" && req.method === "POST") { await db(["HDEL", "links", String(body.slug || "")]); return json(res, 200, { ok: 1 }); }
    }

    const pm = /^\/p\/([a-z0-9]+)$/.exec(path);
    if (pm) {
      const x = await db(["HGET", "links", pm[1]]);
      if (!x) return html(res, page("Not found", '<main><h1>Link not found</h1><p class="mu">This payment link does not exist or was removed.</p></main>'), 404);
      return html(res, payPage(JSON.parse(x)));
    }

    if (path === "/api/invoice" && req.method === "POST") {
      const x = await db(["HGET", "links", String(body.slug || "")]);
      if (!x) return json(res, 404, { error: "Link not found" });
      const l = JSON.parse(x), usd = l.usd || Math.round((+body.usd || 0) * 100) / 100;
      if (!(usd >= MIN_USD)) return json(res, 400, { error: "Minimum amount is $" + MIN_USD });
      if (usd > 100000) return json(res, 400, { error: "Amount too large" });
      const price = await btcUsd();
      const sats = Math.round((usd / price) * 1e8) + 1 + crypto.randomInt(99); // tiny offset makes each invoice amount unique
      const btc = (sats / 1e8).toFixed(8), now = Date.now();
      const r = { id: rid(), slug: l.slug, name: l.name, usd, sats, btc, price, t: now, exp: now + EXPIRY_MS, st: "pending" };
      await db(["HSET", "inv", r.id, JSON.stringify(r)]);
      return json(res, 200, { id: r.id, addr: BTC, btc, price, exp: r.exp, uri: "bitcoin:" + BTC + "?amount=" + btc });
    }

    if (path === "/api/check") {
      const x = await db(["HGET", "inv", String(q.get("id") || "")]);
      if (!x) return json(res, 404, { error: "Not found" });
      const r = await checkOne(JSON.parse(x));
      return json(res, 200, { st: r.st, usd: r.usd, seen: !!r.seen });
    }

    return html(res, page("Not found", '<main><h1>Page not found</h1></main>'), 404);
  } catch (e) {
    return json(res, 500, { error: "Server error: " + e.message });
  }
};
