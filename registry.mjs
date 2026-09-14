// The registry engine — the "global intelligence stratus" scaler. Adding a source is a
// row in sources.json, not code: describe its URL, shape (geojson | records), the geo
// fields, and a label field, and it becomes a live layer. `discover()` harvests new
// sources from open-data catalogs so whole categories onboard at once.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SOURCES = JSON.parse(await readFile(join(HERE, "sources.json"), "utf8"));

const UA = { "User-Agent": "argus-intel/0.1" };
const _cache = new Map();
const at = (o, p) => (p ? p.split(".").reduce((x, k) => (x == null ? x : x[k]), o) : o);

async function ingest(s) {
  const raw = await fetch(s.url, { headers: UA }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
  let recs = at(raw, s.root);
  if (!Array.isArray(recs)) recs = raw.features || (Array.isArray(raw) ? raw : []);
  const out = [];
  for (const r of recs) {
    let lat, lon, label;
    if (s.shape === "geojson") {
      const g = r.geometry;
      if (g?.type === "Point" && g.coordinates) { lon = +g.coordinates[0]; lat = +g.coordinates[1]; }
      label = (r.properties || {})[s.type];
    } else if (s.point) {
      const g = r[s.point];
      if (g?.coordinates) { lon = +g.coordinates[0]; lat = +g.coordinates[1]; }
      else if (g?.latitude) { lat = +g.latitude; lon = +g.longitude; }
      label = r[s.type];
    } else {
      lat = +r[s.lat]; lon = +r[s.lon]; label = r[s.type];
    }
    if (lat && lon && !Number.isNaN(lat) && !Number.isNaN(lon)) {
      out.push({ lat, lon, kind: s.id, label: String(label ?? s.name), src: s.name });
      if (out.length >= (s.cap || 600)) break;
    }
  }
  return out;
}

export async function ingestCached(id) {
  const s = SOURCES.find((x) => x.id === id);
  if (!s) return null;
  const c = _cache.get(id), ttl = s.cadence || 300000;
  if (c && Date.now() - c.t < ttl) return c.v;
  try {
    const items = await ingest(s);
    if (items.length) { const v = { items, ts: Date.now() }; _cache.set(id, { t: Date.now(), v }); return v; }
  } catch { /* keep stale */ }
  return c ? c.v : null;
}

export const registryMeta = () =>
  SOURCES.map((s) => ({ id: s.id, name: s.name, discipline: s.discipline, color: s.color || "#9aa7bd" }));

// Harvest candidate sources from the Socrata open-data catalog (thousands of city/state
// portals). Returns ready-to-paste registry rows for any dataset that carries geo.
export async function discover(q, limit = 40) {
  const url = `https://api.us.socrata.com/api/catalog/v1?q=${encodeURIComponent(q)}&only=dataset&limit=${limit}`;
  const r = await fetch(url, { headers: UA }).then((x) => x.json());
  const out = [];
  for (const x of r.results || []) {
    const res = x.resource || {}, dom = x.metadata?.domain || "";
    const cols = (res.columns_field_name || []).map((c) => c.toLowerCase());
    const lat = cols.find((c) => c === "latitude" || c === "lat");
    const lon = cols.find((c) => c === "longitude" || c === "long" || c === "lon");
    const point = cols.find((c) => c === "location" || c === "point" || c === "geocoded_column");
    if (!((lat && lon) || point)) continue;
    const type = cols.find((c) => c.includes("type") || c.includes("desc") || c.includes("nature") || c.includes("complaint"));
    out.push({
      id: `${dom.split(".")[1] || dom}-${res.id}`.slice(0, 40), name: (res.name || res.id).slice(0, 60),
      domain: dom, shape: "records", url: `https://${dom}/resource/${res.id}.json?$limit=300`,
      ...(point ? { point } : { lat, lon }), type,
    });
  }
  return out;
}
