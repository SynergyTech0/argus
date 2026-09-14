// Global lightning — Blitzortung real-time strike network (free, NO key). Like maritime, the Node
// server holds one persistent WS, keeps recent strikes (last 5 min), and serves a snapshot at
// /api/intel/lightning. Blitzortung frames are a custom LZW-compressed JSON string (text frames),
// decoded below. Rotates across the public ws hosts on drop.

const HOSTS = ["wss://ws1.blitzortung.org", "wss://ws7.blitzortung.org", "wss://ws8.blitzortung.org"];
const MAX_AGE = 5 * 60 * 1000;
const strikes = [];        // { lat, lon, ts }
let ws = null, started = false, idx = 0, lastMsg = 0;

// Blitzortung's public decoder (LZW variant) — turns the frame string into JSON text.
function decode(b) {
  const e = {}, d = ("" + b).split(""); let c = d[0], f = c; const g = [c]; let o = 256;
  for (let i = 1; i < d.length; i++) {
    const cc = d[i].charCodeAt(0);
    const a = cc < 256 ? d[i] : (e[cc] ? e[cc] : f + c);
    g.push(a); c = a.charAt(0); e[o] = f + c; o++; f = a;
  }
  return g.join("");
}
function prune() { const cut = Date.now() - MAX_AGE; while (strikes.length && strikes[0].ts < cut) strikes.shift(); }

function connect() {
  try { ws = new WebSocket(HOSTS[idx % HOSTS.length]); }
  catch { idx++; return void setTimeout(connect, 3000); }
  ws.addEventListener("open", () => ws.send(JSON.stringify({ a: 111 })));
  ws.addEventListener("message", (ev) => {
    lastMsg = Date.now();
    try {
      const j = JSON.parse(decode(ev.data));
      if (j.lat != null && j.lon != null && Math.abs(j.lat) <= 90 && Math.abs(j.lon) <= 180) {
        strikes.push({ lat: j.lat, lon: j.lon, ts: Date.now() });
        if (strikes.length > 8000) strikes.shift();
      }
    } catch { /* frame decode/parse noise */ }
  });
  ws.addEventListener("close", () => { idx++; setTimeout(connect, 3000); });
  ws.addEventListener("error", () => { try { ws.close(); } catch { /* */ } });
}

export function initLightning() {
  if (started) return;
  started = true;
  connect();
  setInterval(prune, 30000);
}

export function lightningSnapshot(cap = 2500) {
  prune();
  const recent = strikes.slice(-cap);
  return { items: recent.map((s) => ({ lat: s.lat, lon: s.lon, kind: "strike", label: "lightning strike" })), rate5m: strikes.length, lastMsg, ts: Date.now() };
}
