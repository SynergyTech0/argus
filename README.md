# Argus

**A self-hostable global intelligence apparatus.** Argus is a live 3D globe that fuses dozens of
real-time, open-source intelligence feeds onto one screen — ships, aircraft, satellites, disasters,
lightning, internet blackouts, radiation, wildfires, crisis-zone eyewitness footage, cameras, and
more — every layer built from **public signal**, brokered server-side, and toggled on demand.

It's the open, public-data counterpart to a national watch floor: no classified sources, no private
surveillance — just the firehose of open data the world already broadcasts, fused and mapped.

> Inspired by Bilawal Sidhu's open-source [gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view).

---

## What it fuses

| Discipline | Layers |
|---|---|
| **GEOINT / disaster** | earthquakes + NASA EONET + GDACS, volcanoes, active fire (NASA FIRMS) |
| **Maritime** | global AIS ship tracking (live) + any chokepoint you scope |
| **Aviation** | ADS-B civil + military flights, satellites (SGP4-propagated) |
| **SIGINT / RF** | geolocated radio emitters, global lightning (Blitzortung) |
| **Cyber** | internet outages / shutdowns (IODA), a bring-your-own threat feed |
| **IMINT** | live traffic/city/port cameras (Windy + DOT feeds) |
| **MASINT** | crowd-sourced radiation sensors, aurora / space-weather |
| **OSINT / HUMINT** | GDELT world-news events, crisis-zone eyewitness footage from public Telegram aggregators |
| **Public safety** | live 911/CAD dispatch + police-radio references |
| **Registry** | add any geo-bearing open-data source as a config row; discover more via the Socrata catalog |
| **Your estate** | drop your own hosts in `fleet.json` for live reachability, and your own threat feed |

Most layers are **keyless**. A few (maritime AIS, cameras, active fire) light up with a **free** API key.

---

## Architecture

- **Server-side broker.** The browser never holds an API key or talks to a third party. Every keyed
  or rate-limited feed is proxied and cached by the Node server; keys stay in the process env.
- **No build step, no dependencies.** Pure Node standard library + a single static page. CesiumJS
  and satellite.js load from CDNs; nothing to `npm install`.
- **Live streams** (AIS, lightning) are held as persistent server-side WebSockets and served as
  snapshots — the browser just polls REST.
- **Config-driven.** Your fleet is `fleet.json`; open-data sources are `sources.json`; keys are `.env`.
- **Model-agnostic enrichment.** The LLM work (translating foreign captions, writing wire stories,
  vision-checking footage) runs in a separate worker that speaks the OpenAI-compatible protocol —
  point it at **OpenAI, Groq, OpenRouter, or a local Ollama / LM Studio / vLLM**. The globe itself
  calls no model.

---

## Quick start

```bash
git clone <this repo> argus && cd argus
node server.mjs               # → http://127.0.0.1:8790
```

That's it — the keyless layers are live immediately. To enable the keyed ones and the LLM worker:

```bash
cp .env.example .env          # fill in the free keys / your LLM endpoint
cp fleet.example.json fleet.json   # optional: your own hosts for the reachability layer
```

Free keys: **AIS** ([aisstream.io](https://aisstream.io)) · **cameras** ([api.windy.com/keys](https://api.windy.com/keys)) · **fire** ([firms.modaps.eosdis.nasa.gov/api](https://firms.modaps.eosdis.nasa.gov/api/)).

### LLM enrichment (optional, model-agnostic)

The eyewitness and news wires come alive when a worker translates and writes them. Set `LLM_*` in
`.env` (any OpenAI-compatible endpoint), then run the jobs on a cron or loop:

```bash
node worker.mjs translate       # foreign captions → English, keyed by post
node worker.mjs newsroom        # breaking wire → short grounded stories
node worker.mjs verify-vision   # thumbnail ↔ claimed-location consistency (needs a vision model)
```

---

## Discipline

This is an **open-source intelligence** tool. Everything it ingests is public. Crisis-zone footage
is always surfaced **UNVERIFIED** — a labeled feed with translation, source attribution, and a
verification-confidence score, never presented as confirmed fact. It reads public broadcast channels
only. Use it to observe and understand open signal, responsibly.

## License

MIT — see [LICENSE](LICENSE).
