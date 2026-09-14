// worker.mjs — Argus's LLM enrichment worker. MODEL-AGNOSTIC: it speaks the OpenAI-compatible
// /chat/completions protocol, so it runs against OpenAI, Anthropic (compat), Groq, OpenRouter,
// Together, DeepSeek, or a LOCAL model via Ollama / LM Studio / vLLM — nothing here is tied to any
// one provider. The Argus server itself calls no model; this worker fills the JSON caches the
// server serves (translations, vision verdicts, wire stories).
//
// Config (.env): LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, LLM_VISION_MODEL (optional), ARGUS_URL.
// Run one job at a time, on cron or a loop:  node worker.mjs translate | newsroom | verify-vision
import "./loadenv.mjs";
import { writeFile, readFile } from "node:fs/promises";

const BASE = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const KEY = process.env.LLM_API_KEY || "";
const MODEL = process.env.LLM_MODEL || "gpt-4o-mini";
const VMODEL = process.env.LLM_VISION_MODEL || MODEL;
const ARGUS = (process.env.ARGUS_URL || "http://127.0.0.1:8790").replace(/\/$/, "");

async function chat(messages, { model = MODEL, json = false, temperature = 0.3 } = {}) {
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
    body: JSON.stringify({ model, messages, temperature, ...(json ? { response_format: { type: "json_object" } } : {}) }),
  });
  if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).choices?.[0]?.message?.content || "";
}
const getJSON = async (path) => (await fetch(ARGUS + path)).json();
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

// TRANSLATE — fill eyewitness_tr.json (English + why-it-matters), incrementally.
async function translate() {
  const { items = [] } = await getJSON("/api/eyewitness");
  let cache = {}; try { cache = JSON.parse(await readFile("eyewitness_tr.json")).items || {}; } catch { /* */ }
  const out = { generated_at: new Date().toISOString(), note: "English translations + why-it-matters. UNVERIFIED.", items: {} };
  for (const i of items) if (cache[i.url]) out.items[i.url] = cache[i.url];                 // carry forward
  const todo = items.filter((i) => !out.items[i.url] && (i.text || "").trim()).slice(0, 20);
  for (const i of todo) {
    try {
      const c = await chat([
        { role: "system", content: 'Translate a short social/news caption to concise English. Output JSON {"en":"<=60 words","why":"<=18 words on why it matters to an analyst","flag":"none"}. Neutral; attribute contested claims to the channel; invent nothing.' },
        { role: "user", content: `Channel: ${i.source} (${i.region}). Caption: ${i.text}` },
      ], { json: true });
      const p = parse(c); if (p?.en) out.items[i.url] = { en: p.en, why: p.why || "", flag: p.flag || "none" };
    } catch (e) { console.error("  skip", i.url, e.message); }
  }
  await writeFile("eyewitness_tr.json", JSON.stringify(out, null, 2));
  console.log(`translate: ${Object.keys(out.items).length} cached (${todo.length} new)`);
}

// NEWSROOM — write short grounded blurbs from the breaking wire into newsroom.json.
async function newsroom() {
  const { wire = [] } = await getJSON("/api/news");
  const stories = [];
  for (const w of wire.slice(0, 12)) {
    try {
      const c = await chat([
        { role: "system", content: 'Write a 2-3 sentence factual news blurb from a single incident record. Output JSON {"headline":"<=90 chars","body":"..."}. No fabrication beyond the record; unconfirmed items say so.' },
        { role: "user", content: JSON.stringify({ label: w.label, city: w.city, cat: w.cat, region: w.region }) },
      ], { json: true });
      const p = parse(c); if (p?.headline) stories.push({ ...p, cat: w.cat, city: w.city, lat: w.lat, lon: w.lon, time: w.time });
    } catch (e) { console.error("  skip", e.message); }
  }
  await writeFile("newsroom.json", JSON.stringify({ generated_at: new Date().toISOString(), stories }, null, 2));
  console.log(`newsroom: ${stories.length} stories`);
}

// VERIFY-VISION — thumbnail-vs-claimed-region consistency, needs a vision-capable model.
async function verifyVision() {
  const { items = [] } = await getJSON("/api/eyewitness");
  let cache = {}; try { cache = JSON.parse(await readFile("verify_vision.json")).items || {}; } catch { /* */ }
  const out = { generated_at: new Date().toISOString(), items: {} };
  for (const i of items) if (cache[i.url]) out.items[i.url] = cache[i.url];
  const todo = items.filter((i) => i.thumb && !out.items[i.url]).slice(0, 12);
  for (const i of todo) {
    try {
      const c = await chat([
        { role: "system", content: 'Judge whether the image is CONSISTENT with the claimed region (architecture, signage/script, terrain, climate). Output JSON {"verdict":"consistent|contradicts|insufficient","reason":"..."}. Plausibility on a low-res still, not proof; "insufficient" for logos/graphics/too-dark.' },
        { role: "user", content: [{ type: "text", text: `Claimed region: ${i.region}. Caption: ${(i.label || "").slice(0, 160)}` }, { type: "image_url", image_url: { url: i.thumb } }] },
      ], { model: VMODEL, json: true });
      const p = parse(c);
      if (p?.verdict) out.items[i.url] = { verdict: p.verdict, score: p.verdict === "consistent" ? 0.85 : p.verdict === "contradicts" ? 0.1 : null, reason: p.reason || "" };
    } catch (e) { console.error("  skip", i.url, e.message); }
  }
  await writeFile("verify_vision.json", JSON.stringify(out, null, 2));
  console.log(`verify-vision: ${Object.keys(out.items).length} verdicts (${todo.length} new)`);
}

const JOBS = { translate, newsroom, "verify-vision": verifyVision };
const job = JOBS[process.argv[2]];
if (!job) { console.log("usage: node worker.mjs translate | newsroom | verify-vision"); process.exit(1); }
job().catch((e) => { console.error(e.message); process.exit(1); });
