// ---------------------------------------------------------------------------
//  server.js  —  REST API + WebSocket live feed
//  - GET  /api/devices            list all devices (all 5 modules)
//  - GET  /api/devices/:id        one device + its history
//  - WS   ws://localhost:4000     pushes {type:'tick', devices, ts} every 2s
// ---------------------------------------------------------------------------
import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import http from "http";
import {
  createSimulator,
  statusFromAqi,
} from "./simulator.js";
import { initDb, saveReadings, getHistory, dbStats } from "./db.js";
import crypto from "node:crypto";

const PORT = 4000;
const TICK_MS = 2000;
const ENV_EXTERNAL_TTL_MS = Number(
  process.env.ENV_EXTERNAL_TTL_MS
  || 10 * 60 * 1000
);
// Feed-ul oficial de parcări cu barieră (Primăria Cluj-Napoca / OpenData)
const PARK_URL = process.env.PARK_URL
  || "http://data.e-primariaclujnapoca.ro/sitpark.json";
const PARK_POLL_MS = Number(process.env.PARK_POLL_MS || 30_000);
// Ore reale de apus/răsărit pentru iluminat (Open-Meteo, gratuit, fără cheie)
const CLUJ_LAT = 46.770;
const CLUJ_LON = 23.591;
const SUN_URL = process.env.SUN_URL
  || `https://api.open-meteo.com/v1/forecast?latitude=${CLUJ_LAT}&longitude=${CLUJ_LON}&daily=sunrise,sunset&timezone=Europe%2FBucharest&forecast_days=1`;
const SUN_POLL_MS = Number(process.env.SUN_POLL_MS || 6 * 60 * 60 * 1000);
const sim = createSimulator();
// Converteste o valoare optionala la numar
function optionalNumber(value) {
  if (
    value === null
    || value === undefined
    || value === ""
  ) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

// Curata lista surselor trimisa de WAQI
function cleanAttributions(value) {
  if (!Array.isArray(value)) return [];

  return value
    .filter(
      (item) =>
        item
        && typeof item === "object"
        && item.name
    )
    .map((item) => ({
      name: String(item.name),
      url: item.url ? String(item.url) : "",
    }));
}
const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => res.json({ ok: true, devices: sim.devices.length }));

app.get("/api/devices", (_req, res) => res.json(sim.getDevices()));

app.get("/api/devices/:id", async (req, res) => {
  const d = sim.getDevices().find((x) => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: "not found" });
  res.json({ ...d, history: await getHistory(d.id, 300) });
});

// history straight from the database (oldest-first)
app.get("/api/history/:id", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 2000);
  res.json(await getHistory(req.params.id, limit));
});

// quick check that persistence works
app.get("/api/db/stats", async (_req, res) => res.json(await dbStats()));

// Ingest endpoint: the SUMO/TraCI bridge POSTs real traffic counts here.
app.post("/api/ingest/traffic", (req, res) => {
  const updates = Array.isArray(req.body) ? req.body : [];
  let applied = 0;
  updates.forEach((u) => {
    const d = sim.getDevices().find((x) => x.id === u.id && x.module === "traffic");
    if (!d) return;
    d.external = true;          // tells the simulator to stop randomizing this one
    if (u.edge) d.edge = u.edge;
    if (u.in != null) d.metrics.in = u.in;
    if (u.out != null) d.metrics.out = u.out;
    if (u.speed != null) d.metrics.speed = u.speed;
    if (u.occupancy != null) d.metrics.occupancy = u.occupancy;
    applied++;
    if (u.lat != null && u.lng != null) { d.lat = u.lat; d.lng = u.lng; }
  });
  res.json({ ok: true, applied });
});
// Primeste datele reale trimise de podul WAQI
app.post("/api/ingest/env", (req, res) => {
  const updates = Array.isArray(req.body)
    ? req.body
    : [req.body];

  const errors = [];
  let applied = 0;

  updates.forEach((update, index) => {
    if (!update || typeof update !== "object") {
      errors.push({
        index,
        error: "invalid payload",
      });
      return;
    }

    if (!update.id) {
      errors.push({ index, error: "id lipsă" });
      return;
    }

    const existing = sim.getDevices().find(
      (item) =>
        item.id === update.id
        && item.module === "environment"
    );

    // Stațiile descoperite dinamic de pod sunt create automat la prima ingestie.
    const device = existing || sim.ensureEnvDevice(update.id);

    const aqi = optionalNumber(update.aqi);
    const lat = optionalNumber(update.lat);
    const lng = optionalNumber(update.lng);

    if (aqi === null || lat === null || lng === null) {
      errors.push({
        index,
        id: update.id,
        error: "aqi, lat and lng must be numeric",
      });
      return;
    }

    device.name = update.name
      ? String(update.name)
      : device.name;

    device.stationId = update.stationId
      ? String(update.stationId)
      : device.stationId;

    device.lat = lat;
    device.lng = lng;
    device.status = statusFromAqi(aqi);
    device.source = "external";
    device.provider = "World Air Quality Index Project";
    device.external = true;
    device.externalUntil =
      Date.now() + ENV_EXTERNAL_TTL_MS;

    device.observedAt = update.observedAt
      ? String(update.observedAt)
      : null;

    device.updatedAt = new Date().toISOString();

    device.cityUrl = update.cityUrl
      ? String(update.cityUrl)
      : null;

    device.attributions = cleanAttributions(
      update.attributions
    );

    device.metrics.aqi = aqi;
    device.metrics.pm25 = optionalNumber(update.pm25);
    device.metrics.pm10 = optionalNumber(update.pm10);
    device.metrics.no2 = optionalNumber(update.no2);
    device.metrics.o3 = optionalNumber(update.o3);
    device.metrics.co = optionalNumber(update.co);
    device.metrics.so2 = optionalNumber(update.so2);
    device.metrics.temp = optionalNumber(update.temp);
    device.metrics.humidity =
      optionalNumber(update.humidity);
    device.metrics.pressure =
      optionalNumber(update.pressure);
    device.metrics.wind =
      optionalNumber(update.wind);

    device.metrics.dominantPollutant =
      update.dominantPollutant
        ? String(update.dominantPollutant)
        : null;

    applied += 1;
  });

  res
    .status(applied > 0 ? 202 : 400)
    .json({
      ok: applied > 0,
      applied,
      errors,
    });
});
// Ingest pentru iluminat: un CMS real (TALQ / pod LoRaWAN) trimite aici starea corpurilor.
app.post("/api/ingest/lighting", (req, res) => {
  const updates = Array.isArray(req.body) ? req.body : [];
  let applied = 0;
  updates.forEach((u) => {
    const d = sim.getDevices().find((x) => x.id === u.id && x.module === "lighting");
    if (!d) return;
    d.external = true;                 // oprește simularea pentru acest corp
    d.source = "external";
    d.provider = "CMS iluminat (TALQ / LoRaWAN)";
    if (u.on != null) d.metrics.on = !!u.on;
    if (u.dim != null) d.metrics.dim = Number(u.dim);
    if (u.powerW != null) d.metrics.powerW = Number(u.powerW);
    if (u.ratedW != null) d.metrics.ratedW = Number(u.ratedW);
    if (u.status) d.status = String(u.status);
    if (u.segment) d.segment = String(u.segment);
    d.fault = u.fault ? String(u.fault) : null;
    d.updatedAt = new Date().toISOString();
    if (u.lat != null && u.lng != null) { d.lat = u.lat; d.lng = u.lng; }
    applied += 1;
  });
  res.json({ ok: true, applied });
});

// --- autentificare simplă (nivel demonstrație) ---
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "admin";
const sessions = new Set();

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = crypto.randomBytes(24).toString("hex");
    sessions.add(token);
    return res.json({ ok: true, token });
  }
  res.status(401).json({ ok: false, error: "Credențiale invalide" });
});

app.post("/api/logout", (req, res) => {
  sessions.delete((req.body || {}).token);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
//  Poller pentru parcările cu barieră — preia locurile libere LIVE din
//  feed-ul oficial (sitpark.json) și actualizează dispozitivele „parking".
//  Potrivirea se face după `parkingKey` === `denumire` din feed.
// ---------------------------------------------------------------------------
async function pollParking() {
  try {
    const res = await fetch(PARK_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error("format neașteptat");

    const byKey = new Map(
      data.map((p) => [String(p.denumire || "").trim(), p])
    );

    let applied = 0;
    sim.getDevices().forEach((d) => {
      if (d.module !== "parking" || !d.parkingKey) return;
      const p = byKey.get(d.parkingKey);
      if (!p) return;

      const cap = Number(p.capacitate) || d.metrics.capacity;
      const freeRaw = p.locuri_libere;
      const free =
        freeRaw === "NA" || freeRaw === null || freeRaw === undefined
          ? null
          : Number(freeRaw);

      d.external = true;                 // oprește simularea pentru acest dispozitiv
      d.source = "external";
      d.provider = "Primăria Cluj-Napoca (OpenData)";
      d.observedAt = p?.detalii?.actualizare || null;
      d.updatedAt = new Date().toISOString();
      d.metrics.capacity = cap;

      if (free === null || !Number.isFinite(free)) {
        // senzor fără date live (în feed apare „NA")
        d.metrics.free = null;
        d.metrics.occupied = null;
        d.liveData = false;
        d.status = "unknown";
      } else {
        const clampedFree = Math.max(0, Math.min(cap, free | 0));
        d.metrics.free = clampedFree;
        d.metrics.occupied = cap - clampedFree;
        d.liveData = true;
        const pct = cap > 0 ? (d.metrics.occupied / cap) * 100 : 0;
        d.status = clampedFree === 0 ? "error" : pct >= 90 ? "warning" : "ok";
        // flux intrări/ieșiri (ultimele 15 min) din feed
        d.metrics.in15 = Number(p?.detalii?.in15min) || 0;
        d.metrics.out15 = Number(p?.detalii?.out15min) || 0;
      }
      applied += 1;
    });

    if (applied) {
      console.log(`  Parking live: ${applied} parcări actualizate din sitpark.json.`);
    }
  } catch (err) {
    console.error("  ! Feed parcări indisponibil (rămân valori simulate):", err.message);
  }
}

// ---------------------------------------------------------------------------
//  Poller pentru orele de apus/răsărit (Open-Meteo) — alimentează iluminatul
//  cu un „ceas astronomic" real, exact cum funcționează un CMS de iluminat.
// ---------------------------------------------------------------------------
async function pollSunTimes() {
  try {
    const res = await fetch(SUN_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const sr = j?.daily?.sunrise?.[0];
    const ss = j?.daily?.sunset?.[0];
    if (!sr || !ss) throw new Error("răspuns fără sunrise/sunset");
    const sunrise = new Date(sr);
    const sunset = new Date(ss);
    if (Number.isNaN(sunrise.getTime()) || Number.isNaN(sunset.getTime())) {
      throw new Error("date solare invalide");
    }
    sim.setSunTimes(sunrise, sunset, "Open-Meteo");
    console.log(`  Iluminat: ceas astronomic real (Open-Meteo) — răsărit ${sr}, apus ${ss}.`);
  } catch (err) {
    console.error("  ! Date solare indisponibile (rămâne orarul fix 19–07):", err.message);
  }
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  // send a full snapshot immediately on connect
  ws.send(JSON.stringify({ type: "snapshot", devices: sim.getDevices(), ts: Date.now() }));
});

// the heartbeat of the city — started only after the DB is ready
function startHeartbeat() {
  setInterval(async () => {
    sim.tick();
    const devices = sim.getDevices();
    try {
      const persistentDevices = devices.filter(
        (device) =>
         !(
            device.module === "environment"
            && device.source === "external"
          )
        );
    await saveReadings(persistentDevices);
    } catch (err) {
      console.error("  ! DB write failed:", err.message);
    }
    const payload = JSON.stringify({ type: "tick", devices, ts: Date.now() });
    wss.clients.forEach((c) => c.readyState === 1 && c.send(payload));
  }, TICK_MS);
}

try {
  await initDb(sim.getDevices());
} catch (err) {
  console.error("\n  ! Nu m-am putut conecta la PostgreSQL.");
  console.error("    Verifică: baza de date 'smartcity' există, PostGIS e instalat,");
  console.error("    și parola din backend/.env este corectă.");
  console.error("    Detaliu:", err.message, "\n");
  process.exit(1);
}

startHeartbeat();

// preia datele de parcare imediat, apoi periodic
pollParking();
setInterval(pollParking, PARK_POLL_MS);

// preia orele solare imediat, apoi periodic (se schimbă lent)
pollSunTimes();
setInterval(pollSunTimes, SUN_POLL_MS);

server.listen(PORT, () => {
  console.log(`\n  Smart City backend running`);
  console.log(`  REST:      http://localhost:${PORT}/api/devices`);
  console.log(`  WebSocket: ws://localhost:${PORT}`);
  console.log(`  Simulating ${sim.devices.length} devices across 5 modules.`);
  console.log(`  Parcări live din: ${PARK_URL}\n`);
});
