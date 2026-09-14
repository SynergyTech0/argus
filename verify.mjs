// Verification gates — turn raw eyewitness items into a transparent CONFIDENCE score before
// anything is publish-eligible. Each gate returns a sub-signal + reason; the score combines only
// the gates that actually ran (unavailable gates don't fake a value). This is NOT a truth
// detector — it surfaces provenance, corroboration, and consistency, and a human still approves.
//
// Gates computable HERE, now, on data we already hold:
//   • provenance    — source alignment + country press-freedom (a prior on state pressure)
//   • corroboration — how many DIFFERENT channels report the same event (region+time+keywords)
// Gates that need the vision task / an external key (read from caches, "unchecked" if absent):
//   • location      — thumbnail-vs-claimed-region consistency (a vision task → verify_vision.json)
//   • recycled      — reverse-image search (needs TinEye/SerpAPI key)
//   • ai_generated  — synthetic-media detector (needs Hive/Sensity key; weakest gate, one signal)

// Alignment for the known eyewitness channels (the harvested country pool tags separately).
// state=government mouthpiece · public=state-funded-but-editorial · independent · partisan=
// advocacy-aligned outlet · osint=open-source-intel aggregator. Country press-freedom (RSF approx).
const CH = {
  bbcpersian:              { align: "public",      pf: 21, note: "BBC (UK public), Persian service" },
  radiofarda:              { align: "public",      pf: 21, note: "RFE/RL — US-funded" },
  manototv:                { align: "independent", pf: 21, note: "diaspora independent" },
  entekhab_ir:             { align: "state-lite",  pf: 21, note: "Iran domestic, semi-official" },
  QudsNen:                 { align: "partisan",    pf: 25, note: "Palestinian partisan" },
  PalpostN:                { align: "partisan",    pf: 25, note: "Palestinian partisan" },
  EnabBaladi:              { align: "independent", pf: 27, note: "Syrian independent" },
  DeepStateUA:             { align: "osint",       pf: 65, note: "Ukrainian OSINT, army-aligned" },
  war_monitor:             { align: "osint",       pf: 65, note: "Ukrainian air-alert monitor" },
  kyivindependent_official:{ align: "independent", pf: 65, note: "Ukrainian independent (English)" },
};
// Provenance prior by alignment: how much to trust the SOURCE before corroboration.
const ALIGN_PRIOR = { independent: 0.7, public: 0.65, osint: 0.6, partisan: 0.4, "state-lite": 0.35, state: 0.25, unclassified: 0.45 };

const STOP = new Set("the a an and or of to in on at for from with by is are was were be this that video breaking channel reports report near over east west north south city town".split(" "));
const tokens = (s = "") => [...new Set(String(s).toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)))];
const jaccard = (a, b) => { if (!a.length || !b.length) return 0; const A = new Set(a), inter = b.filter((x) => A.has(x)).length; return inter / (a.length + b.length - inter); };

export function provenance(item) {
  const c = CH[item.channel] || { align: "unclassified", pf: null };
  let s = ALIGN_PRIOR[c.align] ?? 0.45;
  if (c.pf != null) s *= 0.7 + 0.3 * Math.min(1, c.pf / 70);   // low press-freedom nudges the prior down
  return { score: +s.toFixed(2), align: c.align, pf: c.pf, reason: c.note || c.align };
}

// Regions map to a coarser THEATER so channels covering the same conflict corroborate each
// other (Gaza + Palestine + West Bank = one theater; a raid reported by both Palestinian
// aggregators is corroboration, not two separate events).
const THEATER = { Gaza: "PS", Palestine: "PS", "West Bank": "PS", Ukraine: "UA", Iran: "IR", Syria: "SY" };
const theater = (r) => THEATER[r] || r;

// Count DISTINCT other channels reporting a similar event (same theater, within 6h, keyword overlap).
export function corroboration(item, all, { text = (x) => x.enText || x.text || x.label || "" } = {}) {
  const t0 = item.time ? Date.parse(item.time) : Date.now();
  const kw = tokens(text(item)), th = theater(item.region);
  const sources = new Set();
  for (const o of all) {
    if (o === item || o.channel === item.channel || theater(o.region) !== th) continue;
    const dtOk = !o.time || Math.abs(Date.parse(o.time) - t0) <= 6 * 3.6e6;
    if (dtOk && jaccard(kw, tokens(text(o))) >= 0.18) sources.add(o.channel);
  }
  const n = sources.size;
  return { score: Math.min(1, n / 3), sources: [...sources], count: n,
    reason: n ? `${n} other channel(s) corroborate` : "single-source, uncorroborated" };
}

// Combine only the gates that ran. gates = { provenance, corroboration, location?, recycled?, ai? }
// Each optional gate is { score, ... } or null/undefined when unchecked.
export function combine(gates) {
  const W = { provenance: 0.25, corroboration: 0.30, location: 0.25, recycled: 0.15, ai: 0.05 };
  let num = 0, den = 0; const ran = {};
  for (const k of Object.keys(W)) {
    const g = gates[k];
    if (g && typeof g.score === "number") { num += W[k] * g.score; den += W[k]; ran[k] = g.score; }
  }
  const score = den ? num / den : 0;
  // Hard caps: a location contradiction or a positive recycled/ai hit floors confidence regardless.
  let capped = score, flags = [];
  if (gates.location && gates.location.verdict === "contradicts") { capped = Math.min(capped, 0.2); flags.push("location-contradiction"); }
  if (gates.recycled && gates.recycled.hit) { capped = Math.min(capped, 0.2); flags.push("recycled-media"); }
  if (gates.ai && gates.ai.probability >= 0.7) { capped = Math.min(capped, 0.25); flags.push("possible-ai"); }
  const tier = capped >= 0.66 ? "high" : capped >= 0.4 ? "medium" : "low";
  return { score: +capped.toFixed(2), tier, gatesRan: Object.keys(ran), breakdown: ran, flags, publishEligible: tier === "high" };
}

// Full pass: enrich a list of eyewitness items with computed gates + external-cache gates.
export function verifyItems(items, { vision = {}, reverse = {}, ai = {} } = {}) {
  return items.map((it) => {
    const gates = {
      provenance: provenance(it),
      corroboration: corroboration(it, items),
      location: vision[it.url] || null,      // {verdict:"consistent|contradicts|insufficient", reason} from the vision task
      recycled: reverse[it.url] || null,     // {hit:bool, ...} from reverse-image (needs key)
      ai: ai[it.url] || null,                // {probability, ...} from a detector (needs key)
    };
    return { ...it, verification: { ...combine(gates), gates } };
  });
}
