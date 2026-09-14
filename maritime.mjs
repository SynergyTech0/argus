// Maritime AIS — global live ship tracking via aisstream.io (free key, websocket). The Node server
// holds persistent WS connections (browser never sees the key), keeps the latest position per
// vessel (by MMSI), prunes stale tracks, and serves capped snapshots — same {items:[…]} shape the
// other intel layers use. Node 22 ships a global WebSocket, so no dependency.
//
// TWO subscriptions (aisstream allows 3): one WHOLE-GLOBE feed, and one dedicated to the STRAIT OF
// HORMUZ so that chokepoint is always fully + freshly covered instead of diluted by the global cap
// and the firehose's message-dropping under load. ~a fifth of the world's seaborne oil transits it.

const KEY = process.env.GEV_AISSTREAM_KEY || null;
const ENDPOINT = "wss://stream.aisstream.io/v0/stream";
const STALE_MS = 20 * 60 * 1000;   // drop a vessel not heard from in 20 min
// aisstream bbox = pairs of [lat, lon] corners.
const GLOBAL_BBOX = [[-90, -180], [90, 180]];
const HORMUZ_BBOX = [[27.2, 54.0], [24.3, 58.2]];   // Persian Gulf entrance ↔ Gulf of Oman
const GLOBAL = new Map();
const HORMUZ = new Map();
const stats = { globalConnects: 0, hormuzConnects: 0, lastMsg: 0 };
let started = false;

function upsert(map, m) {
  if (m.MessageType !== "PositionReport") return;
  const md = m.MetaData || {}, pr = (m.Message && m.Message.PositionReport) || {};
  const mmsi = md.MMSI, lat = pr.Latitude ?? pr.latitude ?? md.latitude ?? md.Latitude, lon = pr.Longitude ?? pr.longitude ?? md.longitude ?? md.Longitude;
  if (!mmsi || lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
  map.set(mmsi, { mmsi, lat, lon, cog: pr.Cog, sog: pr.Sog, heading: pr.TrueHeading, name: (md.ShipName || "").trim(), ts: Date.now() });
}

function connect(bbox, map, tag) {
  if (!KEY) return;
  let ws;
  try { ws = new WebSocket(ENDPOINT); ws.binaryType = "arraybuffer"; }
  catch { return void setTimeout(() => connect(bbox, map, tag), 5000); }
  const dec = new TextDecoder();
  ws.addEventListener("open", () => {
    stats[tag + "Connects"]++;
    ws.send(JSON.stringify({ APIKey: KEY, BoundingBoxes: [bbox], FilterMessageTypes: ["PositionReport"] }));
  });
  ws.addEventListener("message", (ev) => {
    stats.lastMsg = Date.now();
    // aisstream sends BINARY frames of UTF-8 JSON — decode the ArrayBuffer, never .toString() a Blob.
    let txt; try { txt = typeof ev.data === "string" ? ev.data : dec.decode(ev.data); } catch { return; }
    let m; try { m = JSON.parse(txt); } catch { return; }
    upsert(map, m);
  });
  ws.addEventListener("close", () => setTimeout(() => connect(bbox, map, tag), 5000));
  ws.addEventListener("error", () => { try { ws.close(); } catch { /* */ } });
}

export function initMaritime() {
  if (started || !KEY) return;
  started = true;
  connect(GLOBAL_BBOX, GLOBAL, "global");
  connect(HORMUZ_BBOX, HORMUZ, "hormuz");
  setInterval(() => {
    const cut = Date.now() - STALE_MS;
    for (const map of [GLOBAL, HORMUZ]) for (const [k, v] of map) if (v.ts < cut) map.delete(k);
  }, 60000);
}

function snap(map, cap) {
  return [...map.values()].sort((a, b) => b.ts - a.ts).slice(0, cap)
    .map((v) => ({ lat: v.lat, lon: v.lon, kind: "ship", mmsi: v.mmsi, label: v.name || String(v.mmsi), sog: v.sog, cog: v.cog, heading: v.heading }));
}

export function maritimeSnapshot(cap = 3000) {
  if (!KEY) return null;
  return { items: snap(GLOBAL, cap), tracked: GLOBAL.size, lastMsg: stats.lastMsg, ts: Date.now() };
}

// Dedicated Strait-of-Hormuz snapshot — every vessel in the chokepoint, moving flagged.
export function hormuzSnapshot(cap = 1000) {
  if (!KEY) return null;
  const items = snap(HORMUZ, cap).map((v) => ({ ...v, kind: "hship" }));   // distinct amber render
  const underway = items.filter((v) => (v.sog || 0) > 1).length;
  return { items, tracked: HORMUZ.size, underway, region: "Strait of Hormuz", lastMsg: stats.lastMsg, ts: Date.now() };
}
