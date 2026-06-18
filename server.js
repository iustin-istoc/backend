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
import { createTransitService } from "./transitService.js";
import { createTomTomTrafficService } from "./tomtomTrafficService.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
// Transport public live — CTP Cluj prin Tranzy OpenData (necesită cheie gratuită).
const TRANZY_BASE = process.env.TRANZY_BASE || "https://api.tranzy.ai/v1/opendata";
const TRANZY_KEY = (process.env.TRANZY_API_KEY || "").trim();
const TRANZY_AGENCY = (process.env.TRANZY_AGENCY_ID || "").trim(); // opțional; altfel auto-detect
const TRANSIT_POLL_MS = Number(process.env.TRANSIT_POLL_MS || 20_000);
const TRANSIT_STATIC_POLL_MS = Number(
  process.env.TRANSIT_STATIC_POLL_MS || 6 * 60 * 60 * 1000,
);
const TRANSIT_ARRIVAL_HORIZON_MIN = Number(
  process.env.TRANSIT_ARRIVAL_HORIZON_MIN || 180,
);

// Stații de încărcare EV — Open Charge Map (necesită cheie API gratuită).
// Interogarea folosește un bounding box pentru municipiul Cluj-Napoca și
// este limitată/rărită pentru a respecta politica de fair usage.
const OCM_BASE = process.env.OCM_BASE || "https://api.openchargemap.io/v3";
const OCM_KEY = (process.env.OPENCHARGEMAP_API_KEY || "").trim();
const OCM_POLL_MS = Number(process.env.OCM_POLL_MS || 15 * 60 * 1000);
const OCM_MAX_RESULTS = Number(process.env.OCM_MAX_RESULTS || 500);
const OCM_BOUNDING_BOX = process.env.OCM_BOUNDING_BOX
  || "(46.7000,23.4500),(46.8600,23.7500)";

// uRADMonitor — rețea globală de senzori de mediu (date LIVE).
// Acces public de citire fără cont: X-User-id: www / X-User-hash: global.
// Opțional, poți pune propriile credențiale gratuite (dashboard > tab API) în .env.
const URAD_BASE = (process.env.URADMONITOR_BASE || "https://data.uradmonitor.com").replace(/\/$/, "");
const URAD_USER_ID = (process.env.URADMONITOR_USER_ID || "www").trim();
const URAD_USER_HASH = (process.env.URADMONITOR_USER_HASH || "global").trim();
const URAD_POLL_MS = Number(process.env.URADMONITOR_POLL_MS || 5 * 60 * 1000);
// Fereastra de prospețime: includem doar senzorii văzuți recent (date „live").
const URAD_MAX_AGE_S = Number(process.env.URADMONITOR_MAX_AGE_S || 3 * 60 * 60);
// Bounding box Cluj-Napoca: latMin, lngMin, latMax, lngMax
const URAD_BBOX = (process.env.URADMONITOR_BBOX || "46.7000,23.4500,46.8600,23.7500")
  .split(",")
  .map((value) => Number(value.trim()));

// WAQI (aqicn.org) — calitatea aerului, poller INTERN (înlocuiește aqi_bridge.py,
// nu mai trebuie rulat scriptul Python separat). Descoperă automat stațiile Cluj.
const WAQI_TOKEN = (process.env.WAQI_API_TOKEN || "").trim();
const WAQI_BOUNDS = (process.env.WAQI_BOUNDS || "46.68,23.46,46.86,23.74").trim();
const WAQI_POLL_MS = Math.max(60_000, Number(process.env.WAQI_POLL_SECONDS || 180) * 1000);
// Stații cunoscute din Cluj (de pe aqicn.org). Lista se completează automat din
// search + map/bounds, dar acestea sunt mereu incluse ca punct de plecare.
const WAQI_KNOWN_STATIONS = {
  "479848": "Sânnicoară", "472192": "Cluj Napoca 2", "471601": "Cluj Napoca",
  "502057": "Bd. 21 Decembrie 1989", "484903": "Strada Câmpului",
  "523171": "Strada Fântânele", "205393": "Calea Turzii", "598894": "Strada 1 Mai",
  "235588": "Strada Bună Ziua", "532648": "Aleea Bâlea", "527899": "Strada George Barițiu",
  "760486": "Strada Constructorilor", "233335": "Aleea Budai Nagy Antal",
  "193945": "Antonio Gaudi S1", "527887": "Strada George Coșbuc",
  "532642": "Strada Aviator Bădescu", "177814": "Strada Antonio Gaudi",
  "518284": "Strada Bună Ziua (2)", "244603": "Strada Regele Ferdinand",
  "205399": "Strada Frunzișului",
};

// TomTom Traffic Flow + Incidents. Cheia ramane exclusiv in backend.
const TOMTOM_BASE = process.env.TOMTOM_BASE || "https://api.tomtom.com";
const TOMTOM_KEY = (process.env.TOMTOM_API_KEY || "").trim();
const TOMTOM_SEGMENT_POLL_MS = Number(
  process.env.TOMTOM_SEGMENT_POLL_MS || 10 * 60 * 1000,
);
const TOMTOM_INCIDENT_POLL_MS = Number(
  process.env.TOMTOM_INCIDENT_POLL_MS || 2 * 60 * 1000,
);
const TOMTOM_BBOX = process.env.TOMTOM_BBOX
  || "23.4500,46.7000,23.7500,46.8600";
const TOMTOM_FLOW_ZOOM = Number(process.env.TOMTOM_FLOW_ZOOM || 16);
const TOMTOM_MAX_NON_TILE_REQUESTS = Number(
  process.env.TOMTOM_MAX_NON_TILE_REQUESTS || 2400,
);

const sim = createSimulator();

const transitService = createTransitService({
  baseUrl: TRANZY_BASE,
  apiKey: TRANZY_KEY,
  agencyId: TRANZY_AGENCY,
  realtimePollMs: TRANSIT_POLL_MS,
  staticPollMs: TRANSIT_STATIC_POLL_MS,
  horizonMinutes: TRANSIT_ARRIVAL_HORIZON_MIN,
  onVehicles: (vehicles) => {
    const devices = vehicles.map((vehicle) => ({
      id: `CTP-${vehicle.vehicleId}`,
      module: "transit",
      name: `${vehicle.label}${vehicle.routeName ? ` · ${vehicle.routeName}` : ""}`,
      lat: vehicle.lat,
      lng: vehicle.lng,
      status: "ok",
      source: "external",
      provider: "CTP Cluj-Napoca (Tranzy OpenData)",
      external: true,
      observedAt: vehicle.timestamp ? String(vehicle.timestamp) : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metrics: {
        speed: vehicle.speed,
        bearing: vehicle.bearing,
        route: vehicle.routeName,
        routeId: vehicle.routeId,
        tripId: vehicle.tripId,
        label: vehicle.label,
        vehicleType: vehicle.vehicleType,
      },
    }));

    sim.syncTransitDevices(devices);
  },
});

const tomtomTrafficService = createTomTomTrafficService({
  baseUrl: TOMTOM_BASE,
  apiKey: TOMTOM_KEY,
  segmentPollMs: TOMTOM_SEGMENT_POLL_MS,
  incidentPollMs: TOMTOM_INCIDENT_POLL_MS,
  bbox: TOMTOM_BBOX,
  zoom: TOMTOM_FLOW_ZOOM,
  maxNonTileRequestsPerDay: TOMTOM_MAX_NON_TILE_REQUESTS,
});

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

// AQI (US EPA) calculat din PM2.5 (µg/m³). uRADMonitor publică concentrații
// brute, nu indici; convertim pentru a folosi aceeași semantică de status ca WAQI.
function aqiFromPm25(concentration) {
  const c = optionalNumber(concentration);
  if (c === null || c < 0) return null;

  const breakpoints = [
    [0.0, 12.0, 0, 50],
    [12.1, 35.4, 51, 100],
    [35.5, 55.4, 101, 150],
    [55.5, 150.4, 151, 200],
    [150.5, 250.4, 201, 300],
    [250.5, 350.4, 301, 400],
    [350.5, 500.4, 401, 500],
  ];

  const pm = Math.min(c, 500.4);
  for (const [cLow, cHigh, iLow, iHigh] of breakpoints) {
    if (pm >= cLow && pm <= cHigh) {
      return Math.round(((iHigh - iLow) / (cHigh - cLow)) * (pm - cLow) + iLow);
    }
  }
  return 500;
}

function ocmStatus(statusType) {
  // Open Charge Map oferă starea operațională declarată a locației, nu
  // ocuparea în timp real a fiecărei prize.
  if (statusType?.IsOperational === true) return "ok";
  if (statusType?.IsOperational === false) return "error";

  const title = String(statusType?.Title || "").toLowerCase();
  if (title.includes("planned") || title.includes("temporary")) return "warning";
  return "unknown";
}

function normaliseOcmPoi(poi) {
  const id = Number(poi?.ID);
  const addressInfo = poi?.AddressInfo || {};
  const lat = Number(addressInfo.Latitude);
  const lng = Number(addressInfo.Longitude);

  if (!Number.isFinite(id) || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  const rawConnections = Array.isArray(poi.Connections) ? poi.Connections : [];
  const connections = rawConnections.map((connection) => {
    const quantityRaw = Number(connection?.Quantity);
    const powerRaw = Number(connection?.PowerKW);
    return {
      type: String(connection?.ConnectionType?.Title || "Necunoscut"),
      level: String(connection?.Level?.Title || ""),
      currentType: String(connection?.CurrentType?.Title || ""),
      powerKW: Number.isFinite(powerRaw) ? powerRaw : null,
      quantity: Number.isFinite(quantityRaw) && quantityRaw > 0 ? quantityRaw : 1,
      status: String(connection?.StatusType?.Title || ""),
    };
  });

  const connectorCount = connections.reduce((sum, item) => sum + item.quantity, 0);
  const declaredPoints = Number(poi?.NumberOfPoints);
  const totalPoints = Number.isFinite(declaredPoints) && declaredPoints > 0
    ? declaredPoints
    : Math.max(connectorCount, 1);
  const maxPowerKW = connections.reduce(
    (max, item) => Number.isFinite(item.powerKW) ? Math.max(max, item.powerKW) : max,
    0,
  );
  const fastPoints = connections.reduce(
    (sum, item) => item.powerKW >= 50 ? sum + item.quantity : sum,
    0,
  );

  const title = String(addressInfo.Title || `Stație OCM ${id}`);
  const address = [
    addressInfo.AddressLine1,
    addressInfo.Town,
    addressInfo.Postcode,
  ].filter(Boolean).join(", ");
  const dataProvider = poi?.DataProvider || {};
  const licenseValue = dataProvider?.License;
  const license = typeof licenseValue === "string"
    ? licenseValue
    : String(licenseValue?.Title || licenseValue?.URL || "");

  return {
    id: `EV-${id}`,
    module: "charging",
    ocmId: id,
    name: title,
    lat,
    lng,
    status: ocmStatus(poi?.StatusType),
    source: "external",
    provider: "Open Charge Map",
    external: true,
    observedAt: poi?.DateLastStatusUpdate || poi?.DateLastVerified || null,
    updatedAt: new Date().toISOString(),
    address,
    town: String(addressInfo.Town || ""),
    operator: String(poi?.OperatorInfo?.Title || "Operator nespecificat"),
    usageType: String(poi?.UsageType?.Title || "Nespecificat"),
    usageCost: String(poi?.UsageCost || ""),
    statusTitle: String(poi?.StatusType?.Title || "Necunoscut"),
    isOperational: poi?.StatusType?.IsOperational ?? null,
    dataProvider: String(dataProvider?.Title || "Open Charge Map contributors"),
    dataProviderWebsite: String(dataProvider?.WebsiteURL || ""),
    license,
    ocmUrl: `https://openchargemap.org/site/poi/details/${id}`,
    connections,
    metrics: {
      totalPoints,
      connectorCount,
      maxPowerKW,
      fastPoints,
    },
  };
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

// Date publice CTP/Tranzy: statii, linii si timpi de sosire.
app.get("/api/transit/status", (_req, res) => {
  res.json(transitService.getStatus());
});

app.get("/api/transit/stops", (req, res) => {
  const result = transitService.listStops({
    search: req.query.search || "",
    limit: req.query.limit,
    offset: req.query.offset,
  });
  res.json(result);
});

app.get("/api/transit/stops/:stopId/arrivals", (req, res) => {
  const result = transitService.getArrivals(req.params.stopId, req.query.limit);
  if (!result) return res.status(404).json({ error: "stop not found" });
  return res.json(result);
});

app.get("/api/transit/stops/:stopId", (req, res) => {
  const stop = transitService.getStop(req.params.stopId);
  if (!stop) return res.status(404).json({ error: "stop not found" });
  return res.json(stop);
});

app.get("/api/transit/routes", (_req, res) => {
  res.json(transitService.listRoutes());
});

app.get("/api/transit/routes/:routeId/stops", (req, res) => {
  const result = transitService.getRouteStops(req.params.routeId);
  if (!result) return res.status(404).json({ error: "route not found" });
  return res.json(result);
});

// TomTom Traffic: stare, segmente monitorizate, incidente si interogare la click.
app.get("/api/traffic/status", (_req, res) => {
  res.json(tomtomTrafficService.getStatus());
});

app.get("/api/traffic/segments", (_req, res) => {
  res.json({
    ok: true,
    updatedAt: tomtomTrafficService.getStatus().lastSegmentSuccess,
    data: tomtomTrafficService.getSegments(),
  });
});

app.get("/api/traffic/segments/:id", (req, res) => {
  const segment = tomtomTrafficService.getSegment(req.params.id);
  if (!segment) return res.status(404).json({ error: "segment not found" });
  return res.json(segment);
});

app.get("/api/traffic/incidents", (_req, res) => {
  res.json({
    ok: true,
    updatedAt: tomtomTrafficService.getStatus().lastIncidentSuccess,
    data: tomtomTrafficService.getIncidents(),
  });
});

app.get("/api/traffic/segment", async (req, res) => {
  try {
    const segment = await tomtomTrafficService.querySegment(
      req.query.lat,
      req.query.lng,
      req.query.zoom,
    );
    return res.json(segment);
  } catch (error) {
    const status = TOMTOM_KEY ? 502 : 503;
    return res.status(status).json({ error: error.message });
  }
});

// Proxy tile: cheia TomTom nu este expusa in React sau in browser.
app.get("/api/traffic/flow-tiles/:z/:x/:y.png", async (req, res) => {
  try {
    const tile = await tomtomTrafficService.getFlowTile({
      z: req.params.z,
      x: req.params.x,
      y: req.params.y,
      style: req.query.style || "relative0",
    });

    res.setHeader("Content-Type", tile.contentType);
    res.setHeader("Cache-Control", "public, max-age=45, stale-while-revalidate=15");
    res.setHeader("X-Traffic-Cache", tile.cache);
    return res.send(tile.buffer);
  } catch (error) {
    const status = TOMTOM_KEY ? 502 : 503;
    return res.status(status).json({ error: error.message });
  }
});

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
    device.network = "waqi";
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

// ---------------------------------------------------------------------------
//  Poller Open Charge Map — toate locațiile de încărcare din bounding box-ul
//  Cluj. Datele reprezintă inventarul, caracteristicile și starea operațională
//  declarată; API-ul nu garantează disponibilitatea live a unui conector.
// ---------------------------------------------------------------------------
async function pollChargingStations() {
  if (!OCM_KEY) return;

  try {
    const url = new URL(`${OCM_BASE.replace(/\/$/, "")}/poi/`);
    url.searchParams.set("output", "json");
    url.searchParams.set("countrycode", "RO");
    url.searchParams.set("boundingbox", OCM_BOUNDING_BOX);
    url.searchParams.set("maxresults", String(OCM_MAX_RESULTS));
    url.searchParams.set("compact", "false");
    url.searchParams.set("verbose", "false");
    url.searchParams.set("client", "IustinLicentaSmartCity");

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-API-Key": OCM_KEY,
        "User-Agent": "Iustin-Licenta-SmartCity/1.0",
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload)) throw new Error("răspuns OCM invalid");

    const stations = payload.map(normaliseOcmPoi).filter(Boolean);
    sim.syncChargingDevices(stations);

    const points = stations.reduce((sum, station) => sum + station.metrics.totalPoints, 0);
    console.log(`  EV charging: ${stations.length} locații / ${points} puncte din Open Charge Map.`);
  } catch (error) {
    console.error("  ! Open Charge Map indisponibil; păstrez ultima listă validă:", error.message);
  }
}

// ---------------------------------------------------------------------------
//  Poller uRADMonitor — senzori de mediu LIVE din rețeaua globală uRADMonitor.
//  Citire publică fără cont (www/global) sau cu credențiale proprii din .env.
//  Filtrăm la bounding box-ul Cluj și păstrăm doar senzorii văzuți recent.
//  AQI se calculează din PM2.5; fără simulare — dispozitivele apar doar dacă
//  există măsurători reale.
// ---------------------------------------------------------------------------
function uradFirstNumber(record, keys) {
  for (const key of keys) {
    const value = optionalNumber(record?.[key]);
    if (value !== null) return value;
  }
  return null;
}

async function pollUradMonitor() {
  if (!Array.isArray(URAD_BBOX) || URAD_BBOX.length !== 4 || URAD_BBOX.some((v) => !Number.isFinite(v))) {
    console.error("  ! uRADMonitor: URADMONITOR_BBOX invalid; sar peste.");
    return;
  }
  const [latMin, lngMin, latMax, lngMax] = URAD_BBOX;

  try {
    const response = await fetch(`${URAD_BASE}/api/v1/devices`, {
      headers: {
        Accept: "application/json",
        "X-User-id": URAD_USER_ID,
        "X-User-hash": URAD_USER_HASH,
        "User-Agent": "Iustin-Licenta-SmartCity/1.0",
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const list = Array.isArray(payload) ? payload : [];

    const nowSeconds = Math.floor(Date.now() / 1000);
    let applied = 0;

    list.forEach((record) => {
      const lat = optionalNumber(record?.latitude);
      const lng = optionalNumber(record?.longitude);
      if (lat === null || lng === null) return;
      if (lat < latMin || lat > latMax || lng < lngMin || lng > lngMax) return;

      // doar senzori văzuți recent (live)
      const seen = optionalNumber(record?.time);
      if (seen !== null && URAD_MAX_AGE_S > 0 && nowSeconds - seen > URAD_MAX_AGE_S) return;

      const rawId = String(record?.id || "").trim();
      if (!rawId) return;

      const pm25 = uradFirstNumber(record, ["pm25", "pm2_5", "pm_25"]);
      const pm10 = uradFirstNumber(record, ["pm10", "pm_10"]);
      const no2 = uradFirstNumber(record, ["no2"]);
      const o3 = uradFirstNumber(record, ["o3", "ozone"]);
      const so2 = uradFirstNumber(record, ["so2"]);
      const co = uradFirstNumber(record, ["co"]);
      const temp = uradFirstNumber(record, ["temperature", "temperature2", "avg_temperature"]);
      const humidity = uradFirstNumber(record, ["humidity"]);
      const pressure = uradFirstNumber(record, ["pressure"]);
      const aqi = aqiFromPm25(pm25);

      const id = `ENV-URAD-${rawId}`;
      const device = sim.getDevices().find(
        (item) => item.id === id && item.module === "environment",
      ) || sim.ensureEnvDevice(id);

      const cityName = String(record?.city || record?.name || "").trim();
      device.name = cityName ? `uRADMonitor ${cityName} (${rawId})` : `uRADMonitor ${rawId}`;
      device.stationId = rawId;
      device.lat = lat;
      device.lng = lng;
      device.status = aqi !== null ? statusFromAqi(aqi) : "unknown";
      device.source = "external";
      device.network = "uradmonitor";
      device.provider = "uRADMonitor (rețea globală)";
      device.external = true;
      device.externalUntil = Date.now() + ENV_EXTERNAL_TTL_MS;
      device.observedAt = seen !== null ? new Date(seen * 1000).toISOString() : null;
      device.updatedAt = new Date().toISOString();
      device.cityUrl = `https://www.uradmonitor.com/?open=${rawId}`;
      device.attributions = [{ name: "uRADMonitor", url: "https://www.uradmonitor.com/" }];

      device.metrics.aqi = aqi;
      device.metrics.pm25 = pm25;
      device.metrics.pm10 = pm10;
      device.metrics.no2 = no2;
      device.metrics.o3 = o3;
      device.metrics.so2 = so2;
      device.metrics.co = co;
      device.metrics.temp = temp;
      device.metrics.humidity = humidity;
      device.metrics.pressure = pressure;
      device.metrics.dominantPollutant = pm25 !== null ? "pm25" : null;

      applied += 1;
    });

    if (applied) {
      console.log(`  Mediu uRADMonitor: ${applied} senzori live în zona Cluj.`);
    } else {
      console.log("  Mediu uRADMonitor: niciun senzor live în bounding box-ul configurat.");
    }
  } catch (error) {
    console.error("  ! uRADMonitor indisponibil:", error.message);
  }
}

// ---------------------------------------------------------------------------
//  Poller WAQI INTERN — descoperă și citește stațiile de calitate a aerului din
//  Cluj (aqicn.org) și le publică LIVE în modulul environment, fără proces extern.
// ---------------------------------------------------------------------------
function iaqiValue(iaqi, key) {
  const item = iaqi?.[key];
  if (item && typeof item === "object") return optionalNumber(item.v);
  return optionalNumber(item);
}

async function waqiJson(url) {
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "Iustin-Licenta-SmartCity/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.status === "ok" ? data : null;
  } catch {
    return null;
  }
}

let waqiStationCache = null;
let waqiStationCacheAt = 0;
const WAQI_DISCOVERY_TTL_MS = 60 * 60 * 1000; // re-descoperire la o oră

async function discoverWaqiStations() {
  if (waqiStationCache && Date.now() - waqiStationCacheAt < WAQI_DISCOVERY_TTL_MS) {
    return waqiStationCache;
  }
  const stations = { ...WAQI_KNOWN_STATIONS };

  for (const keyword of ["cluj", "cluj-napoca"]) {
    const result = await waqiJson(
      `https://api.waqi.info/v2/search/?token=${encodeURIComponent(WAQI_TOKEN)}&keyword=${encodeURIComponent(keyword)}`,
    );
    (Array.isArray(result?.data) ? result.data : []).forEach((item) => {
      const uid = item?.uid;
      if (uid != null) stations[String(uid)] = stations[String(uid)] || String(item?.station?.name || `Statie ${uid}`);
    });
  }

  const bounds = await waqiJson(
    `https://api.waqi.info/map/bounds/?token=${encodeURIComponent(WAQI_TOKEN)}&latlng=${encodeURIComponent(WAQI_BOUNDS)}`,
  );
  (Array.isArray(bounds?.data) ? bounds.data : []).forEach((item) => {
    const uid = item?.uid;
    if (uid != null) stations[String(uid)] = stations[String(uid)] || String(item?.station?.name || `Statie ${uid}`);
  });

  waqiStationCache = Object.entries(stations).map(([uid, name]) => ({ uid, name }));
  waqiStationCacheAt = Date.now();
  return waqiStationCache;
}

async function fetchWaqiStation(station) {
  const result = await waqiJson(
    `https://api.waqi.info/feed/@${encodeURIComponent(station.uid)}/?token=${encodeURIComponent(WAQI_TOKEN)}`,
  );
  if (!result) return null;

  const data = result.data || {};
  const city = data.city || {};
  const iaqi = data.iaqi || {};
  const geo = Array.isArray(city.geo) ? city.geo : [];

  const aqi = optionalNumber(data.aqi);
  const lat = optionalNumber(geo[0]);
  const lng = optionalNumber(geo[1]);
  if (aqi === null || lat === null || lng === null) return null;

  return {
    uid: String(station.uid),
    name: String(city.name || station.name),
    lat,
    lng,
    aqi,
    pm25: iaqiValue(iaqi, "pm25"),
    pm10: iaqiValue(iaqi, "pm10"),
    no2: iaqiValue(iaqi, "no2"),
    o3: iaqiValue(iaqi, "o3"),
    co: iaqiValue(iaqi, "co"),
    so2: iaqiValue(iaqi, "so2"),
    temp: iaqiValue(iaqi, "t"),
    humidity: iaqiValue(iaqi, "h"),
    pressure: iaqiValue(iaqi, "p"),
    dominantPollutant: data.dominentpol || null,
    observedAt: String(data.time?.iso || data.time?.s || ""),
    cityUrl: String(city.url || `https://aqicn.org/station/@${station.uid}/`),
    attributions: cleanAttributions(data.attributions),
  };
}

async function pollWaqi() {
  if (!WAQI_TOKEN) return;

  try {
    const stations = await discoverWaqiStations();
    let applied = 0;

    for (const station of stations) {
      const payload = await fetchWaqiStation(station);
      if (payload) {
        const id = `ENV-${payload.uid}`;
        const device = sim.getDevices().find(
          (item) => item.id === id && item.module === "environment",
        ) || sim.ensureEnvDevice(id);

        device.name = payload.name;
        device.stationId = payload.uid;
        device.lat = payload.lat;
        device.lng = payload.lng;
        device.status = statusFromAqi(payload.aqi);
        device.source = "external";
        device.network = "waqi";
        device.provider = "World Air Quality Index Project";
        device.external = true;
        device.externalUntil = Date.now() + ENV_EXTERNAL_TTL_MS;
        device.observedAt = payload.observedAt || null;
        device.updatedAt = new Date().toISOString();
        device.cityUrl = payload.cityUrl;
        device.attributions = payload.attributions;

        device.metrics.aqi = payload.aqi;
        device.metrics.pm25 = payload.pm25;
        device.metrics.pm10 = payload.pm10;
        device.metrics.no2 = payload.no2;
        device.metrics.o3 = payload.o3;
        device.metrics.co = payload.co;
        device.metrics.so2 = payload.so2;
        device.metrics.temp = payload.temp;
        device.metrics.humidity = payload.humidity;
        device.metrics.pressure = payload.pressure;
        device.metrics.dominantPollutant = payload.dominantPollutant;

        applied += 1;
      }
      await new Promise((r) => setTimeout(r, 250)); // politicos cu API-ul WAQI
    }

    console.log(`  Mediu WAQI: ${applied} stații live în zona Cluj.`);
  } catch (error) {
    console.error("  ! WAQI indisponibil:", error.message);
  }
}

// ---------------------------------------------------------------------------
//  Servire frontend (build Vite) pe ACELASI origin ca API-ul.
//  Permite un singur link public (cu SSL prin tunel) fara probleme de CORS
//  sau "mixed content". In dev frontend-ul ruleaza separat pe Vite (5173).
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIST = path.resolve(__dirname, "../frontend/dist");

app.use(express.static(FRONTEND_DIST));

// Fallback SPA: orice ruta care NU e /api si nu e fisier => index.html
app.get(/^\/(?!api\/).*/, (req, res, next) => {
  if (req.method !== "GET") return next();
  res.sendFile(path.join(FRONTEND_DIST, "index.html"), (err) => {
    if (err) next();
  });
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
    let devices;
    try {
      sim.tick();
      devices = sim.getDevices();
    } catch (err) {
      console.error("  ! tick a esuat (continui):", err.message);
      return;
    }
    try {
      const persistentDevices = devices.filter(
        (device) =>
         !(
            device.module === "environment"
            && device.source === "external"
          )
         && device.module !== "transit"   // vehiculele CTP sunt dinamice, nu se persistă
         && device.module !== "charging"  // inventarul OCM se reîmprospătează din API
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

// Transport public CTP/Tranzy: date statice, vehicule si estimari de sosire.
transitService.start();

// Trafic real TomTom: segmente monitorizate si incidente.
if (TOMTOM_KEY) {
  tomtomTrafficService.start().catch((error) => {
    console.error("  ! TomTom Traffic nu a putut porni:", error.message);
  });
} else {
  console.log("  TomTom Traffic: seteaza TOMTOM_API_KEY in .env pentru date reale.");
}

// Calitatea aerului LIVE din WAQI (poller intern; nu mai e nevoie de aqi_bridge.py)
if (WAQI_TOKEN) {
  pollWaqi();
  setInterval(pollWaqi, WAQI_POLL_MS);
} else {
  console.log("  Mediu WAQI: setează WAQI_API_TOKEN în .env pentru stații live.");
}

// Senzori de mediu LIVE din uRADMonitor (acces public www/global by default)
pollUradMonitor();
setInterval(pollUradMonitor, URAD_POLL_MS);

// stații EV din Open Charge Map (doar dacă există cheia în .env)
if (OCM_KEY) {
  pollChargingStations();
  setInterval(pollChargingStations, OCM_POLL_MS);
} else {
  console.log("  EV charging: setează OPENCHARGEMAP_API_KEY în .env pentru locații reale.");
}

server.listen(PORT, () => {
  console.log(`\n  Smart City backend running`);
  console.log(`  REST:      http://localhost:${PORT}/api/devices`);
  console.log(`  WebSocket: ws://localhost:${PORT}`);
  console.log(`  ${sim.devices.length} dispozitive inițiale; modulele dinamice se încarcă din API.`);
  console.log(`  Parcari live din: ${PARK_URL}`);
  console.log(`  TomTom Traffic: ${TOMTOM_KEY ? "activ" : "inactiv - lipseste cheia"}\n`);
});

function shutdown() {
  tomtomTrafficService.stop();
  transitService.stop?.();
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
