// Intel ingestion engines for the Argus globe. Each brokers a live open-source
// feed server-side (browser never touches the upstreams), normalises to geo entities,
// and TTL-caches so we respect rate limits and stay responsive. All no-auth today.
//
//   disasters  USGS quakes + NASA EONET (fires/storms/volcanoes/floods) + GDACS alerts
//   flights    OpenSky (civil, US bbox) + adsb.lol military  (ADS-B = emitted signal)
//   satellites GEOINT — CelesTrak TLEs, brokered; the frontend propagates via satellite.js
//   sigint     RF emitters — geolocated radio stations (+ military ADS-B lives in flights)
//   humint     GDELT global news (conflict/protest/disaster), placed by source country

import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFile);

const UA = { "User-Agent": "argus-intel/0.1" };
const _ttl = new Map();

// Some feeds (OpenMHz) sit behind Cloudflare, which fingerprints Node's TLS handshake and
// 403s it even with a browser UA. curl's handshake passes, so proxy those through curl.
const CURL = process.platform === "win32" ? "C:\\Windows\\System32\\curl.exe" : "curl";
async function curlJson(url, ua) {
  const { stdout } = await execFileP(CURL, ["-s", "-m", "14", "-A", ua, url], { maxBuffer: 12 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function cached(key, ms, fn) {
  const c = _ttl.get(key);
  if (c && Date.now() - c.t < ms) return c.v;
  try {
    const v = await fn();
    if (v != null) { _ttl.set(key, { t: Date.now(), v }); return v; }
  } catch { /* fall through to stale */ }
  return c ? c.v : null;
}
async function fjson(url) { const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error(r.status); return r.json(); }
async function ftext(url) { const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error(r.status); return r.text(); }

export async function intelDisasters() {
  return cached("disasters", 300000, async () => {
    const out = [];
    try {
      const q = await fjson("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson");
      for (const f of q.features || []) {
        const c = f.geometry?.coordinates, p = f.properties || {};
        if (c && p.mag >= 2.5) out.push({ lat: c[1], lon: c[0], kind: "quake", sev: p.mag, label: `M${p.mag} · ${p.place || ""}`, time: p.time });
      }
    } catch { /* */ }
    try {
      const e = await fjson("https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=250");
      for (const ev of e.events || []) {
        const g = ev.geometry?.[ev.geometry.length - 1];
        if (g?.type === "Point" && g.coordinates) out.push({ lat: g.coordinates[1], lon: g.coordinates[0], kind: "eonet", cat: ev.categories?.[0]?.title || "event", label: ev.title });
      }
    } catch { /* */ }
    try {
      const since = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
      const em = await fjson(`https://www.seismicportal.eu/fdsnws/event/1/query?limit=250&format=json&start=${since}&minmag=3.5`);
      for (const f of em.features || []) {
        const c = f.geometry?.coordinates, p = f.properties || {};
        if (c) out.push({ lat: c[1], lon: c[0], kind: "quake", sev: p.mag, label: `M${p.mag} · ${p.flynn_region || ""}`, time: p.time });
      }
    } catch { /* */ }
    try {
      const gd = await fjson("https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?alertlevel=Orange;Red");
      for (const f of gd.features || []) {
        const c = f.geometry?.coordinates, p = f.properties || {};
        if (c) out.push({ lat: c[1], lon: c[0], kind: "gdacs", sev: p.alertlevel, label: `${p.eventtype || ""} · ${(p.name || p.htmldescription || "").toString().slice(0, 70)}` });
      }
    } catch { /* */ }
    return out.length ? { items: out, ts: Date.now() } : null;
  });
}

export async function intelFlights() {
  return cached("flights", 20000, async () => {
    const out = [];
    try {
      const s = await fjson("https://opensky-network.org/api/states/all");  // global
      for (const a of (s.states || []).slice(0, 800)) {
        if (a[5] != null && a[6] != null && !a[8]) out.push({ lat: a[6], lon: a[5], kind: "flight", callsign: (a[1] || "").trim(), alt: a[7], heading: a[10] || 0, vel: a[9], origin: a[2], mil: false });
      }
    } catch { /* */ }
    try {
      const m = await fjson("https://api.adsb.lol/v2/mil");
      for (const a of (m.ac || []).slice(0, 400)) {
        if (a.lat && a.lon) out.push({ lat: a.lat, lon: a.lon, kind: "flight", callsign: (a.flight || a.r || "").trim(), alt: a.alt_baro, heading: a.track || 0, mil: true, type: a.t });
      }
    } catch { /* */ }
    return out.length ? { items: out, ts: Date.now() } : null;
  });
}

export async function intelSatellites() {
  return cached("sats", 3600000, async () => {
    const out = [];
    for (const g of ["stations", "visual", "gps-ops"]) {
      try {
        const t = await ftext(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=tle`);
        const L = t.split("\n").map((x) => x.replace(/\r/g, "").trimEnd());
        for (let i = 0; i + 2 < L.length; i += 3) {
          if (L[i + 1]?.startsWith("1 ") && L[i + 2]?.startsWith("2 ")) out.push({ name: L[i].trim(), tle1: L[i + 1], tle2: L[i + 2], group: g });
        }
      } catch { /* */ }
    }
    return out.length ? { sats: out.slice(0, 140), ts: Date.now() } : null;
  });
}

export async function intelSigint() {
  return cached("sigint", 21600000, async () => {
    const out = [];
    try {
      const r = await fjson("https://de1.api.radio-browser.info/json/stations/search?limit=300&hidebroken=true&has_geo_info=true&order=votes&reverse=true");
      for (const s of r || []) {
        if (s.geo_lat && s.geo_long) out.push({ lat: s.geo_lat, lon: s.geo_long, kind: "radio", label: s.name, country: s.countrycode, codec: s.codec, bitrate: s.bitrate });
      }
    } catch { /* */ }
    return out.length ? { items: out, ts: Date.now() } : null;
  });
}

// Rough centroids for GDELT source-country names → where news is breaking.
const CC = {
  "United States": [39, -98], "United Kingdom": [54, -2], "France": [46, 2], "Germany": [51, 10],
  "Russia": [61, 90], "China": [35, 105], "India": [22, 79], "Ukraine": [49, 32], "Israel": [31, 35],
  "Iran": [32, 53], "Japan": [36, 138], "Brazil": [-10, -52], "Canada": [58, -100], "Australia": [-25, 134],
  "Mexico": [23, -102], "Turkey": [39, 35], "Pakistan": [30, 70], "Nigeria": [9, 8], "Egypt": [26, 30],
  "South Korea": [36, 128], "Italy": [42, 12], "Spain": [40, -4], "Poland": [52, 19], "Syria": [35, 38],
  "Iraq": [33, 44], "Afghanistan": [33, 65], "Saudi Arabia": [24, 45], "South Africa": [-29, 24],
  "Indonesia": [-2, 118], "Philippines": [13, 122], "Venezuela": [8, -66], "Yemen": [15, 48],
  "Sudan": [15, 30], "Ethiopia": [8, 39], "Colombia": [4, -73], "Argentina": [-34, -64], "Taiwan": [24, 121],
  "North Korea": [40, 127], "Myanmar": [22, 96], "Lebanon": [34, 36], "Libya": [27, 17],
  "Netherlands": [52, 5], "Belgium": [50.6, 4.5], "Sweden": [62, 15], "Norway": [61, 9],
  "Denmark": [56, 10], "Finland": [64, 26], "Ireland": [53, -8], "Switzerland": [47, 8],
  "Austria": [47.5, 14], "Portugal": [39.5, -8], "Greece": [39, 22], "Czech Republic": [49.8, 15.5],
  "Hungary": [47, 19.5], "Romania": [46, 25], "Bulgaria": [42.7, 25], "Serbia": [44, 21],
  "Croatia": [45.1, 15.2], "Georgia": [42, 43.5], "Kazakhstan": [48, 67], "Thailand": [15, 101],
  "Vietnam": [16, 108], "Malaysia": [4, 102], "Singapore": [1.35, 103.8], "Bangladesh": [24, 90],
  "Sri Lanka": [7.9, 80.8], "Nepal": [28, 84], "Kenya": [0.2, 37.9], "Tanzania": [-6, 35],
  "Uganda": [1.3, 32.3], "Ghana": [7.9, -1], "Morocco": [32, -6], "Algeria": [28, 3],
  "Tunisia": [34, 9], "Somalia": [6, 46], "Congo": [-1, 24], "Angola": [-11.2, 17.9],
  "Zimbabwe": [-19, 29.9], "Peru": [-9.2, -75], "Chile": [-30, -71], "Ecuador": [-1.5, -78.2],
  "Cuba": [22, -79.5], "Haiti": [19, -72.3], "Dominican Republic": [19, -70.2], "Jordan": [31, 36.2],
  "United Arab Emirates": [24, 54], "Qatar": [25.3, 51.2], "Kuwait": [29.3, 47.5], "Oman": [21, 57],
  "New Zealand": [-42, 174], "Cambodia": [12.5, 105], "Azerbaijan": [40.4, 47.6], "Uzbekistan": [41.4, 64.6],
};
export async function intelHumint() {
  return cached("humint", 900000, async () => {
    const out = [];
    try {
      const url = "https://api.gdeltproject.org/api/v2/doc/doc?query=" +
        encodeURIComponent("(conflict OR protest OR attack OR strike OR disaster OR earthquake)") +
        "&mode=artlist&format=json&maxrecords=90&timespan=1d&sort=datedesc";
      const d = await fjson(url);
      for (const a of d.articles || []) {
        const g = CC[a.sourcecountry];
        if (g) out.push({ lat: g[0] + (Math.random() - 0.5) * 5, lon: g[1] + (Math.random() - 0.5) * 5, kind: "news", label: (a.title || "").slice(0, 100), url: a.url, country: a.sourcecountry, domain: a.domain });
      }
    } catch { /* */ }
    return out.length ? { items: out, ts: Date.now() } : null;
  });
}

// IMINT — global camera feeds. No-auth city/DOT traffic cams now (real stills, geolocated);
// Windy Webcams (global) lights up when WINDY_WEBCAMS_KEY is set (brokered here, never client).
// Curated Gulf / Strait-of-Hormuz live cams — the region is a dead zone for the crowd-sourced
// feeds (Windy 0, SkylineWebcams just a few Dubai cams), and the strait itself is open water with
// no fixed public cam. These are stable, intentionally-PUBLIC broadcast streams (never Insecam /
// private cameras). `stream` = a watch-live URL rather than a still image; they can go offline.
const GULF_CAMS = [
  { lat: 25.087, lon: 55.146, label: "Dubai Marina — Princess Tower", stream: "https://www.skylinewebcams.com/en/webcam/united-arab-emirates/dubai/dubai/dubai-marina.html" },
  { lat: 25.101, lon: 55.117, label: "Palm Jumeirah, Dubai", stream: "https://www.skylinewebcams.com/en/webcam/united-arab-emirates/dubai/dubai/fairmont-the-palm.html" },
  { lat: 25.20, lon: 55.27, label: "Dubai skyline panorama", stream: "https://www.skylinewebcams.com/en/webcam/united-arab-emirates/dubai/dubai/dubai.html" },
  { lat: 26.20, lon: 56.25, label: "Strait of Hormuz — Musandam coast (live ship transits)", stream: "https://www.youtube.com/watch?v=CqE_LPUdz-k" },
];

export async function intelCameras() {
  return cached("cameras", 480000, async () => {   // 8 min — under Windy's 10-min image-token expiry; caps free-tier API burn
    const out = GULF_CAMS.map((c) => ({ lat: c.lat, lon: c.lon, kind: "cam", label: c.label, stream: c.stream, src: "Gulf/curated" }));
    try {
      const t = await fjson("https://api.tfl.gov.uk/Place/Type/JamCam");
      for (const c of (t || []).slice(0, 250)) {
        const img = (c.additionalProperties || []).find((p) => p.key === "imageUrl")?.value;
        if (c.lat && c.lon) out.push({ lat: c.lat, lon: c.lon, kind: "cam", label: c.commonName || "TfL cam", img, src: "TfL London" });
      }
    } catch { /* */ }
    for (const [d, DD] of [["d3", "D03"], ["d4", "D04"], ["d7", "D07"], ["d11", "D11"], ["d12", "D12"]]) {
      try {
        const j = await fjson(`https://cwwp2.dot.ca.gov/data/${d}/cctv/cctvStatus${DD}.json`);
        for (const rec of j.data || []) {
          const c = rec.cctv || {}, loc = c.location || {};
          const lat = parseFloat(loc.latitude), lon = parseFloat(loc.longitude);
          const im = c.imageData?.static?.currentImageURL;
          if (lat && lon && im) out.push({ lat, lon, kind: "cam", label: loc.locationName || "Caltrans cam", img: im, src: "Caltrans" });
        }
      } catch { /* */ }
    }
    const wk = process.env.WINDY_WEBCAMS_KEY;
    if (wk) {
      // Query several regions so we get global coverage AND dense Middle-East coverage
      // (a plain global limit under-samples the region). nearby = lat,lon,radius_km.
      // Windy v3 caps the `nearby` radius at 250 km (a bigger radius 400s and drops the region — the
      // bug that broke every query). Broad coverage = the global feed + dense 250 km hotspot points.
      // ☠️ VERIFIED 2026-09-14: Windy has ~70k cams worldwide but ZERO in the Persian Gulf / Strait
      // of Hormuz (Dubai/Abu Dhabi/Muscat all return 0) — a free-sensor dead zone, same as AIS there.
      // Free-tier caps: limit <= 50 per call, nearby radius <= 250 km. Cover breadth with several
      // 250 km points × up to 3 pages (offset) each — cheap paging beats one big rejected request.
      const POINTS = [
        ["global", ""], ["europe", "nearby=50,15,250&"], ["europe-s", "nearby=41,15,250&"],
        ["namerica", "nearby=40,-95,250&"], ["us-w", "nearby=37,-120,250&"],
        ["easia", "nearby=35,135,250&"], ["seasia", "nearby=13,100,250&"], ["sasia", "nearby=20,78,250&"],
      ];
      const seen = new Set();
      for (const [reg, q] of POINTS) {
        for (const offset of [0, 50, 100]) {
          let w;
          try { w = await (await fetch(`https://api.windy.com/webcams/api/v3/webcams?${q}limit=50&offset=${offset}&include=location,images`, { headers: { "x-windy-api-key": wk } })).json(); }
          catch { break; }
          const cams = w.webcams || [];
          if (!cams.length) break;   // no more pages for this point
          for (const c of cams) {
            const id = c.webcamId || c.id;
            if (c.location && !seen.has(id)) {
              seen.add(id);
              out.push({ lat: c.location.latitude, lon: c.location.longitude, kind: "cam", label: c.title, img: c.images?.current?.preview, src: "Windy/" + reg });
            }
          }
        }
      }
    }
    return out.length ? { items: out, ts: Date.now() } : null;
  });
}

// Public safety — live 911/CAD dispatch (precise geo, US metros) + police radio (OpenMHz).
const BUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const ST = {
  AL: [32.8, -86.8], AK: [64, -152], AZ: [34.3, -111.7], AR: [34.9, -92.4], CA: [37.2, -119.4],
  CO: [39, -105.5], CT: [41.6, -72.7], DE: [39, -75.5], DC: [38.9, -77], FL: [28.6, -82.4],
  GA: [32.6, -83.4], HI: [20.3, -156.4], ID: [44.4, -114.6], IL: [40, -89.2], IN: [39.9, -86.3],
  IA: [42, -93.5], KS: [38.5, -98.4], KY: [37.5, -85.3], LA: [31, -92], ME: [45.4, -69.2],
  MD: [39, -76.8], MA: [42.3, -71.8], MI: [44.3, -85.4], MN: [46.3, -94.3], MS: [32.7, -89.7],
  MO: [38.4, -92.5], MT: [47, -109.6], NE: [41.5, -99.8], NV: [39.3, -116.6], NH: [43.7, -71.6],
  NJ: [40.1, -74.7], NM: [34.4, -106.1], NY: [42.9, -75.5], NC: [35.5, -79.4], ND: [47.5, -100.3],
  OH: [40.3, -82.8], OK: [35.6, -97.5], OR: [44, -120.6], PA: [40.9, -77.8], RI: [41.7, -71.5],
  SC: [33.9, -80.9], SD: [44.4, -100.2], TN: [35.9, -86.4], TX: [31.5, -99.3], UT: [39.3, -111.7],
  VT: [44.1, -72.7], VA: [37.5, -78.9], WA: [47.4, -120.5], WV: [38.6, -80.6], WI: [44.6, -89.9], WY: [43, -107.6],
};
async function fjsonUA(url, ua) { const r = await fetch(url, { headers: { "User-Agent": ua } }); if (!r.ok) throw new Error(r.status); return r.json(); }

// Turn a raw CAD incident label into a newsworthiness signal — the core of driving a
// news cycle from public-safety data (CAD fires before any reporter hears it).
// sev 3 = breaking, 2 = notable, 1 = routine (filtered out of the wire).
const NEWS_RULES = [
  [/shoot|shots fired|gun|homicide|stabb|weapon|assault w|active (threat|shooter)|officer down|ofcr down/i, "violence", 3],
  [/structure fire|building fire|smoke in|explos|hazmat|gas leak|mass casualt|collapse|bomb/i, "fire/hazard", 3],
  [/fatal|deceased|\bdoa\b|death|drown|not breathing|cardiac|unconscious|overdose|\bod\b/i, "medical-critical", 3],
  [/aircraft|plane|train|derail|rescue|entrapment|swift water|cliff|missing (child|person)|amber/i, "rescue/major", 3],
  [/robbery|burglary|pursuit|chase|barricad|hostage|carjack|kidnap|riot|protest/i, "crime", 2],
  [/vehicle fire|outside fire|brush fire|wildland|rollover|major (collision|accident)|pin(ned)? in|extricat/i, "fire/crash", 2],
  [/collision|accident|crash|mva/i, "traffic", 1],
];
export function classifyIncident(label) {
  const s = String(label || "");
  for (const [re, cat, sev] of NEWS_RULES) if (re.test(s)) return { cat, sev, news: sev >= 2 };
  return { cat: "routine", sev: 1, news: false };
}

// Live 911/CAD open-data registry — append a row per city (validated: current data + geo).
// point = a Socrata Point field ({coordinates:[lon,lat]}); else lat/lon = direct field names.
const CITY_CAD = [
  { city: "San Francisco", host: "data.sfgov.org", id: "nuek-vuh3", type: "call_type", order: "received_dttm", point: "case_location" },
  { city: "Seattle PD", host: "data.seattle.gov", id: "33kz-ixgy", type: "call_type", order: "cad_event_original_time_queued", lat: "dispatch_latitude", lon: "dispatch_longitude" },
  { city: "Seattle Fire", host: "cos-data.seattle.gov", id: "kzjm-xkqj", type: "type", order: "datetime", lat: "latitude", lon: "longitude" },
  { city: "Montgomery County MD", host: "data.montgomerycountymd.gov", id: "98cc-bc7d", type: "initial_type", order: "start_time", lat: "latitude", lon: "longitude" },
  { city: "New Orleans", host: "data.nola.gov", id: "es9j-6y5d", type: "typetext", order: "timecreate", point: "location" },
  { city: "Cincinnati", host: "data.cincinnati-oh.gov", id: "gexm-h6bt", type: "incident_type_desc", order: "create_time_incident", lat: "latitude_x", lon: "longitude_x" },
];
async function cadCity(c) {
  const rows = await fjson(`https://${c.host}/resource/${c.id}.json?$limit=120&$order=${c.order}%20DESC`);
  const out = [];
  for (const r of rows) {
    let lat, lon;
    if (c.point) { const g = r[c.point]; if (g?.coordinates) { lon = +g.coordinates[0]; lat = +g.coordinates[1]; } else if (g?.latitude) { lat = +g.latitude; lon = +g.longitude; } }
    else { lat = +r[c.lat]; lon = +r[c.lon]; }
    if (!lat || !lon || Number.isNaN(lat) || Number.isNaN(lon)) continue;
    const label = r[c.type] || "incident";
    out.push({ lat, lon, kind: "dispatch", label, city: c.city, pri: r.priority, time: r[c.order], ...classifyIncident(label) });
  }
  return out;
}
export async function intelPublicSafety() {
  return cached("publicsafety", 60000, async () => {
    let out = [];
    const cities = await Promise.all(CITY_CAD.map((c) => cadCity(c).catch(() => [])));
    for (const arr of cities) out = out.concat(arr);
    try {
      const j = await curlJson("https://api.openmhz.com/systems", BUA);
      for (const sy of j.systems || []) {
        if (!sy.active) continue;
        const c = ST[(sy.state || "").toUpperCase()]; if (!c) continue;
        out.push({ lat: c[0] + (Math.random() - 0.5) * 3, lon: c[1] + (Math.random() - 0.5) * 3, kind: "scanner", label: sy.name, city: sy.city, state: sy.state, listeners: sy.clientCount, listen: `https://openmhz.com/system/${sy.shortName}` });
      }
    } catch { /* */ }
    return out.length ? { items: out, ts: Date.now() } : null;
  });
}

// ☢️ Radiation — Safecast global sensor network (crowd-sourced, geolocated). MASINT.
export async function intelRadiation() {
  return cached("radiation", 1800000, async () => {
    const out = [];
    try {
      const m = await fjson("https://api.safecast.org/measurements.json?per_page=600&order=captured_at+desc");
      for (const r of m || []) {
        const lat = +r.latitude, lon = +r.longitude, v = +r.value;
        if (lat && lon && !Number.isNaN(v)) out.push({ lat, lon, kind: "radiation", label: `${v} ${r.unit || "cpm"}`, sev: v, unit: r.unit, time: r.captured_at });
      }
    } catch { /* */ }
    return out.length ? { items: out, ts: Date.now() } : null;
  });
}
// 🚀 Rocket launches — Launch Library 2, upcoming launches at their pads. Space GEOINT.
export async function intelLaunches() {
  return cached("launches", 3600000, async () => {
    const out = [];
    try {
      const d = await fjson("https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=40");
      for (const r of d.results || []) {
        const p = r.pad || {}, lat = +p.latitude, lon = +p.longitude;
        if (lat && lon) out.push({ lat, lon, kind: "launch", label: r.name, pad: p.name, net: r.net, status: r.status?.abbrev, time: r.net });
      }
    } catch { /* */ }
    return out.length ? { items: out, ts: Date.now() } : null;
  });
}
// 🌋 Volcanoes — GDACS volcanic-activity events, global.
export async function intelVolcanoes() {
  return cached("volcanoes", 1800000, async () => {
    const out = [];
    try {
      const d = await fjson("https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=VO");
      for (const f of d.features || []) {
        const c = f.geometry?.coordinates, p = f.properties || {};
        if (c) out.push({ lat: c[1], lon: c[0], kind: "volcano", label: p.name || "Volcano", sev: p.alertlevel, desc: p.htmldescription });
      }
    } catch { /* */ }
    return out.length ? { items: out, ts: Date.now() } : null;
  });
}
// ☀️ Space weather — NOAA OVATION auroral oval (the live geo footprint of geomagnetic activity).
export async function intelSpacewx() {
  return cached("spacewx", 900000, async () => {
    const out = [];
    try {
      const d = await fjson("https://services.swpc.noaa.gov/json/ovation_aurora_latest.json");
      for (const row of d.coordinates || []) {
        const lon0 = row[0], lat = row[1], pct = row[2];
        if (pct >= 8) out.push({ lat, lon: lon0 > 180 ? lon0 - 360 : lon0, kind: "aurora", label: `aurora ${pct}%`, sev: pct });
      }
    } catch { /* */ }
    return out.length ? { items: out, ts: Date.now() } : null;
  });
}

// ⚡ EYEWITNESS — citizen/diaspora footage surfacing from inside crisis zones, via the FREE
// public Telegram web preview (t.me/s/<channel>). This is the leading edge of the news cycle:
// clips break on these aggregator/broadcaster channels minutes before global networks carry
// them. ALWAYS UNVERIFIED — viral war/protest video is heavily recycled and increasingly
// AI-generated, so this feeds a clearly-labeled wire, never the confirmed-news layer. Public
// broadcast channels only (no individuals' personal channels — no de-anonymisation).
// Channel usernames are probe-verified live (2026-09-13); an unresolved handle serves an
// empty preview, so only handles that returned real recent posts are listed here.
const TG_CHANNELS = [
  { u: "bbcpersian",              label: "BBC Persian",       region: "Iran",      lang: "fa", lat: 35.70, lon: 51.42 },
  { u: "radiofarda",              label: "Radio Farda",       region: "Iran",      lang: "fa", lat: 35.70, lon: 51.42 },
  { u: "manototv",                label: "Manoto TV",         region: "Iran",      lang: "fa", lat: 35.70, lon: 51.42 },
  { u: "entekhab_ir",             label: "Entekhab",          region: "Iran",      lang: "fa", lat: 35.70, lon: 51.42 },
  { u: "QudsNen",                 label: "Quds News Network", region: "Gaza",      lang: "ar", lat: 31.50, lon: 34.47 },
  { u: "PalpostN",                label: "Palestine Post",    region: "Palestine", lang: "ar", lat: 31.95, lon: 35.23 },
  { u: "EnabBaladi",              label: "Enab Baladi",       region: "Syria",     lang: "ar", lat: 33.51, lon: 36.29 },
  { u: "DeepStateUA",             label: "DeepState UA",      region: "Ukraine",   lang: "uk", lat: 50.45, lon: 30.52 },
  { u: "war_monitor",             label: "War Monitor UA",    region: "Ukraine",   lang: "uk", lat: 50.45, lon: 30.52 },
  { u: "kyivindependent_official", label: "Kyiv Independent", region: "Ukraine",   lang: "en", lat: 50.45, lon: 30.52 },
];
async function curlText(url, ua) {
  const { stdout } = await execFileP(CURL, ["-s", "-m", "14", "-A", ua, url], { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}
function stripHtml(s) {
  return s.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, " ").trim();
}
function viewsToNum(v) {
  const m = v && String(v).trim().match(/^([\d.]+)\s*([KMB]?)/i);
  if (!m) return 0;
  const mult = { "": 1, K: 1e3, M: 1e6, B: 1e9 }[(m[2] || "").toUpperCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}
function parseTgPreview(html) {
  const out = [];
  for (const b of html.split("js-widget_message_wrap").slice(1)) {
    const link = (b.match(/data-post="([^"]+)"/) || [])[1];
    if (!link) continue;
    const dt = (b.match(/datetime="([^"]+)"/) || [])[1];
    const txtM = b.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
    const text = txtM ? stripHtml(txtM[1]) : "";
    const hasVideo = /message_video_thumb|tgme_widget_message_video|tgme_widget_message_roundvideo/.test(b);
    const hasPhoto = /tgme_widget_message_photo_wrap/.test(b);
    const thumb = (b.match(/background-image:url\('([^']+)'\)/) || [])[1] || null;
    const views = (b.match(/tgme_widget_message_views[^>]*>([^<]+)</) || [])[1] || null;
    if (!text && !hasVideo && !hasPhoto) continue;
    out.push({ link, dt, text, hasVideo, hasPhoto, thumb, views: views && views.trim() });
  }
  return out;
}
export async function intelEyewitness() {
  return cached("eyewitness", 120000, async () => {
    const UAB = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
    const now = Date.now();
    const per = await Promise.all(TG_CHANNELS.map(async (ch) => {
      try {
        const posts = parseTgPreview(await curlText(`https://t.me/s/${ch.u}`, UAB));
        return posts.map((p) => {
          const t = p.dt ? Date.parse(p.dt) : now;
          const ageMin = Math.round((now - t) / 60000);
          const views = viewsToNum(p.views);
          const recency = Math.max(0, 1 - ageMin / 720);              // decays over 12h
          const score = recency * (p.hasVideo ? 2 : 1) * (1 + Math.log10(1 + views) / 6);
          return {
            kind: "eyewitness", channel: ch.u, source: ch.label, region: ch.region, lang: ch.lang,
            lat: ch.lat, lon: ch.lon, label: (p.text.slice(0, 240) || `[${p.hasVideo ? "video" : "photo"}]`),
            text: p.text, hasVideo: p.hasVideo, hasPhoto: p.hasPhoto, thumb: p.thumb,
            views, url: `https://t.me/${p.link}`, time: p.dt || null, ageMin, score,
            verified: false,                                          // NEVER assert as confirmed
          };
        });
      } catch { return []; }
    }));
    const items = per.flat().filter((x) => x.ageMin <= 1440).sort((a, b) => b.score - a.score).slice(0, 60);
    return items.length ? { items, channels: TG_CHANNELS.length, ts: now } : null;
  });
}

// 🌐 Internet outages — IODA (Georgia Tech) national/regional connectivity drops (free, no key).
// Detects censorship blackouts + infrastructure failures — "the internet just went dark over X" is
// often the FIRST sign something's happening. Alerts are per region/ASN; aggregated to one marker
// per country (via the CC centroid table), severity = worst signal, labeled with the datasources.
export async function intelOutages() {
  return cached("outages", 300000, async () => {
    const now = Math.floor(Date.now() / 1000), from = now - 4 * 3600;
    let alerts = [];
    try { alerts = (await fjson(`https://api.ioda.inetintel.cc.gatech.edu/v2/outages/alerts?from=${from}&until=${now}`)).data || []; } catch { /* */ }
    const byC = new Map();
    for (const a of alerts) {
      if (a.level === "normal") continue;   // only warning/critical drops
      const name = a.entity?.attrs?.country_name, geo = CC[name];
      if (!geo) continue;
      const cur = byC.get(name) || { lat: geo[0], lon: geo[1], country: name, sev: 0, n: 0, sources: new Set() };
      cur.n++; cur.sources.add(a.datasource); cur.sev = Math.max(cur.sev, a.level === "critical" ? 3 : 2);
      byC.set(name, cur);
    }
    const out = [...byC.values()].map((c) => ({
      lat: c.lat, lon: c.lon, kind: "outage", sev: c.sev, country: c.country,
      label: `${c.country} — ${c.n} outage signal${c.n > 1 ? "s" : ""} (${[...c.sources].join(", ")})`,
    }));
    return out.length ? { items: out, ts: Date.now() } : null;
  });
}

// 🔥 Active fire / thermal anomalies — NASA FIRMS (VIIRS). Needs a free MAP_KEY
// (firms.modaps.eosdis.nasa.gov/api → FIRMS_MAP_KEY). Sharper than our EONET wildfire events.
export async function intelFire() {
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) return null;   // layer stays absent until a key is configured
  return cached("fire", 900000, async () => {
    const out = [];
    try {
      // world, last 1 day, VIIRS S-NPP. CSV: latitude,longitude,bright_ti4,...,confidence,...,frp,...
      const csv = await ftext(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_SNPP_NRT/world/1`);
      const rows = csv.trim().split(/\r?\n/); const h = rows[0].split(",");
      const iLat = h.indexOf("latitude"), iLon = h.indexOf("longitude"), iFrp = h.indexOf("frp"), iConf = h.indexOf("confidence");
      for (const line of rows.slice(1)) {
        const f = line.split(","); const lat = +f[iLat], lon = +f[iLon];
        if (Number.isNaN(lat) || Number.isNaN(lon)) continue;
        out.push({ lat, lon, kind: "fire", frp: +f[iFrp] || 0, conf: f[iConf], label: `fire · ${Math.round(+f[iFrp] || 0)} MW` });
        if (out.length >= 4000) break;
      }
    } catch { /* */ }
    return out.length ? { items: out, ts: Date.now() } : null;
  });
}

export const INTEL = {
  disasters: intelDisasters, flights: intelFlights, satellites: intelSatellites,
  sigint: intelSigint, humint: intelHumint, cameras: intelCameras, publicsafety: intelPublicSafety,
  radiation: intelRadiation, launches: intelLaunches, volcanoes: intelVolcanoes, spacewx: intelSpacewx,
  outages: intelOutages, fire: intelFire,
};
