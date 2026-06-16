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
import { createSimulator } from "./simulator.js";
import { initDb, saveReadings, getHistory, dbStats } from "./db.js";
import crypto from "node:crypto";

const PORT = 4000;
const TICK_MS = 2000;

const sim = createSimulator();

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
      await saveReadings(devices); // persist history to PostgreSQL
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
