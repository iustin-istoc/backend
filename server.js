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

    const device = sim.getDevices().find(
      (item) =>
        item.id === update.id
        && item.module === "environment"
    );

    if (!device) {
      errors.push({
        index,
        id: update.id,
        error: "environment device not found",
      });
      return;
    }

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

server.listen(PORT, () => {
  console.log(`\n  Smart City backend running`);
  console.log(`  REST:      http://localhost:${PORT}/api/devices`);
  console.log(`  WebSocket: ws://localhost:${PORT}`);
  console.log(`  Simulating ${sim.devices.length} devices across 5 modules.\n`);
});
