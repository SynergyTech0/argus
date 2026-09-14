// Argus — server-side proxy + fleet-health feed.
//
// Borrowed straight from Bilawal Sidhu's gods-eye-view architecture: the browser
// never holds a credential or talks to a third-party API directly. Everything that
// needs a key, or that would leak the fleet's shape to a CDN, is brokered here. The
// only things the browser loads cross-origin are the (keyless) Cesium CDN and OSM
// tiles. Any future keyed feed (TomTom, a private metrics endpoint, Google 3D Tiles)
// gets added as one more /api/* route, and the key stays in this process's env.
//
// First live layer: fleet-host reachability. Geo is resolved once via ip-api and
// cached; reachability (TCP connect to 443) is re-measured on every poll, so the
// globe shows live up/down + latency, not a static map.

import './loadenv.mjs';   // MUST be first — populates process.env before any module reads it
import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { INTEL, intelEyewitness } from './intel.mjs';
import { verifyItems } from './verify.mjs';
import { initMaritime, maritimeSnapshot, hormuzSnapshot } from './maritime.mjs';
import { initLightning, lightningSnapshot } from './lightning.mjs';
import { ingestCached, registryMeta, discover } from './registry.mjs';

const PORT = Number(process.env.GEV_PORT || 8790);
const HERE = dirname(fileURLToPath(import.meta.url));

// The fleet is CONFIG-DRIVEN — drop your own hosts in `fleet.json` (gitignored); `fleet.example.json`
// ships as a template. No infrastructure is hardcoded, so this runs against any estate.
function loadFleet() {
  for (const f of ['fleet.json', 'fleet.example.json']) {
    try { return JSON.parse(readFileSync(join(HERE, f), 'utf8')); } catch { /* try next */ }
  }
  return [];
}
const FLEET = loadFleet();

const geoCache = new Map(); // host -> {lat, lon, city, country}

function tcpProbe(host, port, timeout = 3500) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = new net.Socket();
    let done = false;
    const finish = (up) => {
      if (done) return; done = true;
      try { sock.destroy(); } catch {}
      resolve({ up, ms: Date.now() - t0 });
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

// Broker the one external API we use (ip-api, free http tier). Cached per host so we
// geolocate each box once, not every poll.
function geolocate(host) {
  if (geoCache.has(host)) return Promise.resolve(geoCache.get(host));
  return new Promise((resolve) => {
    const req = http.get(`http://ip-api.com/json/${encodeURIComponent(host)}?fields=status,lat,lon,city,country`, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          const geo = j.status === 'success'
            ? { lat: j.lat, lon: j.lon, city: j.city, country: j.country }
            : { lat: null, lon: null, city: null, country: null };
          geoCache.set(host, geo);
          resolve(geo);
        } catch { resolve({ lat: null, lon: null, city: null, country: null }); }
      });
    });
    req.on('error', () => resolve({ lat: null, lon: null, city: null, country: null }));
    req.setTimeout(4000, () => { req.destroy(); resolve({ lat: null, lon: null, city: null, country: null }); });
  });
}

// Small JSON GET helper (localhost mesh + any future http feed).
function getJson(url, timeout = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeout, () => { req.destroy(); resolve(null); });
  });
}

// This PC's own geolocation — the hub the local mesh agents orbit. ip-api with no IP
// geolocates the caller (i.e. this box's public egress). Cached like the fleet geo.
let selfGeo = null;
async function geolocateSelf() {
  if (selfGeo) return selfGeo;
  const g = await getJson('http://ip-api.com/json/?fields=status,lat,lon,city,country', 4000);
  selfGeo = g && g.status === 'success'
    ? { lat: g.lat, lon: g.lon, city: g.city, country: g.country }
    : { lat: 0, lon: 0, city: null, country: null }; // fallback if geolocation fails
  return selfGeo;
}

function postJson(url, body, timeout = 9000) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } }); });
    req.on("error", () => resolve(null));
    req.setTimeout(timeout, () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

// Geolocate many IPs in one shot via ip-api's batch endpoint (up to 100/call),
// cached so repeat polls don't re-fetch. Reuses the same geoCache as the fleet.
async function geolocateBatch(ips) {
  const need = ips.filter((ip) => !geoCache.has(ip));
  for (let i = 0; i < need.length; i += 90) {
    const chunk = need.slice(i, i + 90);
    const res = await postJson("http://ip-api.com/batch",
      JSON.stringify(chunk.map((q) => ({ query: q, fields: "status,lat,lon,city,country,query" }))));
    if (Array.isArray(res)) {
      for (const r of res) {
        if (r && r.query) {
          geoCache.set(r.query, r.status === "success"
            ? { lat: r.lat, lon: r.lon, city: r.city, country: r.country } : { lat: null, lon: null });
        }
      }
    }
  }
  const out = {};
  for (const ip of ips) out[ip] = geoCache.get(ip) || { lat: null, lon: null };
  return out;
}

// The internet-threat layer: top corroborated attackers from your threat feed (threats.json), geolocated.
async function threats() {
  let t = { actors: [], campaigns: [], totals: {}, generated_at: null };
  try { t = JSON.parse(await readFile(join(HERE, "threats.json"))); } catch { /* no export yet */ }
  const actors = (t.actors || []).slice(0, 45);
  const geo = await geolocateBatch(actors.map((a) => a.ip));
  const enriched = actors.map((a) => ({ ...a, ...geo[a.ip] })).filter((a) => a.lat != null);
  return { actors: enriched, campaigns: t.campaigns || [], totals: t.totals || {}, generated_at: t.generated_at };
}

// The live mesh: a hub (this box) with its live agents orbiting it. Agents run locally,
// so they have no geography of their own — they hang off the local hub. Services
// (the bus, the connector) are the hub, not orbiters.
async function meshAgents() {
  const [anchor, graph] = await Promise.all([
    geolocateSelf(),
    getJson('http://127.0.0.1:8795/graph', 2500),
  ]);
  const up = !!graph;
  const nodes = (graph && graph.nodes) || [];
  const agents = nodes
    .filter((n) => n.live && n.kind !== 'service' && n.kind !== 'human')
    .map((n) => ({
      name: n.name, kind: n.kind, status: n.status,
      working_on: n.working_on || n.title || '',
    }));
  return { anchor: { name: 'hub', ...anchor }, up, term: graph && graph.term, agents };
}

async function fleetHealth() {
  const out = await Promise.all(FLEET.map(async (h) => {
    const [geo, probe] = await Promise.all([geolocate(h.host), tcpProbe(h.host, h.port)]);
    return { ...h, ...geo, up: probe.up, ms: probe.ms, checkedAt: new Date().toISOString() };
  }));
  return out;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/api/fleet/health') {
      const data = await fleetHealth();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ hosts: data, ts: Date.now() }));
      return;
    }
    if (req.url === '/api/mesh/agents') {
      const data = await meshAgents();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ...data, ts: Date.now() }));
      return;
    }
    if (req.url === '/api/threats') {
      const data = await threats();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ...data, ts: Date.now() }));
      return;
    }
    if (req.url.startsWith('/api/intel/')) {
      const name = req.url.split('/')[3].split('?')[0];
      const fn = INTEL[name];
      // maritime + hormuz are live WS streams held server-side, not REST engines or registry sources
      const data = name === 'maritime' ? maritimeSnapshot()
        : name === 'hormuz' ? hormuzSnapshot()
        : name === 'lightning' ? lightningSnapshot()
        : (fn ? await fn() : await ingestCached(name));
      if (data || fn || registryMeta().some((s) => s.id === name)) {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(data || { items: [] }));
        return;
      }
    }
    if (req.url === '/api/registry') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ sources: registryMeta(), ts: Date.now() }));
      return;
    }
    if (req.url.startsWith('/api/discover')) {
      const q = new URL(req.url, 'http://x').searchParams.get('q') || 'calls for service';
      try {
        const candidates = await discover(q);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ query: q, count: candidates.length, candidates, ts: Date.now() }));
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ query: q, candidates: [], error: String(e) }));
      }
      return;
    }
    if (req.url === '/api/mapconfig') {
      // A Cesium Ion token is unavoidably client-visible — the browser streams terrain and
      // 3D-building tiles straight from Ion, so it cannot be brokered the way a keyed feed is.
      // Serving it from env keeps it out of the committed page. No token => the globe stays on
      // the smooth ellipsoid and nothing else changes.
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        ionToken: process.env.CESIUM_ION_TOKEN || null,
        terrain: !!process.env.CESIUM_ION_TOKEN,
        buildings: !!process.env.CESIUM_ION_TOKEN,
      }));
      return;
    }
    if (req.url === '/api/eyewitness') {
      // ⚡ Leading-edge citizen/diaspora footage from crisis-zone Telegram aggregators.
      // Always UNVERIFIED — a labeled feed, never merged into the confirmed-news wire.
      const data = await intelEyewitness();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data || { items: [], channels: 0 }));
      return;
    }
    if (req.url === '/api/eyewitness_tr') {
      // English translations + "why it matters" + recycled/AI flags, keyed by post url.
      // Written by the translation task (fills the English cache the wire + verifier read).
      try {
        const tr = await readFile(join(HERE, 'eyewitness_tr.json'));
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(tr);
      } catch {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"items":{}}');
      }
      return;
    }
    if (req.url === '/api/verify') {
      // Verification gates → a transparent confidence tier per eyewitness item. Provenance +
      // corroboration compute here; location/recycled/ai are read from caches written by the
      // verify task / keyed detectors (absent = "unchecked", never faked). Human still approves.
      const data = await intelEyewitness();
      const items = (data?.items || []);
      const readCache = async (f) => { try { return JSON.parse(await readFile(join(HERE, f))).items || {}; } catch { return {}; } };
      const [tr, vision, reverse, ai] = await Promise.all([
        readCache('eyewitness_tr.json'), readCache('verify_vision.json'),
        readCache('verify_reverse.json'), readCache('verify_ai.json'),
      ]);
      // fold the English translation onto each item so corroboration matches across languages
      const enriched = items.map((it) => ({ ...it, enText: tr[it.url]?.en || it.text }));
      const verified = verifyItems(enriched, { vision, reverse, ai });
      const tiers = verified.reduce((a, v) => (a[v.verification.tier] = (a[v.verification.tier] || 0) + 1, a), {});
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ items: verified, tiers, ts: Date.now() }));
      return;
    }
    if (req.url === '/api/news') {
      // The breaking-news wire, now GLOBAL: US CAD dispatch + GDELT world news + major
      // disasters, ranked severity-then-recency. Foreign items carry region:'intl' so the
      // newsroom knows to translate them.
      const [ps, hum, dis] = await Promise.all([INTEL.publicsafety(), INTEL.humint(), INTEL.disasters()]);
      const cad = (ps?.items || []).filter((x) => x.kind === 'dispatch' && x.news)
        .map((x) => ({ ...x, region: 'US' }));
      const world = (hum?.items || []).map((x) => ({
        lat: x.lat, lon: x.lon, kind: 'news', label: x.label, city: x.country, url: x.url,
        domain: x.domain, cat: 'world-news', sev: 2, news: true, region: 'intl',
      }));
      const disasters = (dis?.items || [])
        .filter((x) => (x.kind === 'quake' && (x.sev || 0) >= 5) || x.kind === 'gdacs')
        .map((x) => ({ lat: x.lat, lon: x.lon, kind: 'disaster', label: x.label, city: x.cat || 'disaster',
          cat: 'disaster', sev: (x.sev || 0) >= 6 ? 3 : 2, time: x.time, news: true, region: 'global' }));
      const wire = [...cad, ...world, ...disasters]
        .sort((a, b) => (b.sev - a.sev) || String(b.time || '').localeCompare(String(a.time || '')))
        .slice(0, 80);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ wire, total: wire.length, regions: { us: cad.length, intl: world.length, global: disasters.length }, ts: Date.now() }));
      return;
    }
    if (req.url === '/api/newsroom') {
      // LLM-written stories from the wire (produced by the newsroom writer task).
      try {
        const nr = await readFile(join(HERE, 'newsroom.json'));
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(nr);
      } catch {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"stories":[]}');
      }
      return;
    }
    if (req.url === '/' || req.url === '/index.html') {
      const html = await readFile(join(HERE, 'public', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('server error');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[argus] proxy + globe on http://127.0.0.1:${PORT}`);
  initMaritime();   // opens the aisstream WS if GEV_AISSTREAM_KEY is set; no-op otherwise
  initLightning();  // opens the Blitzortung WS (keyless)
});
