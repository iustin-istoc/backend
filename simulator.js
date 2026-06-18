// ---------------------------------------------------------------------------
//  simulator.js  —  "the living city"
//  One simulator that feeds the static modules and dynamic external modules.
//  Each device has: id, module, name, lat, lng, status, metrics{...}
//  Every tick we update metrics (random walk) and occasionally flip status.
// ---------------------------------------------------------------------------

// Cluj-Napoca city center (Piața Unirii)
const CENTER = { lat: 46.7693, lng: 23.5895 };

// small helpers
const rnd = (min, max) => min + Math.random() * (max - min);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
// jitter coordinates around the center so markers spread over the city
const near = (dLat, dLng) => ({ lat: CENTER.lat + dLat, lng: CENTER.lng + dLng });

const STATUSES = ["disconnected", "error", "warning", "ok", "unknown"];

// Converteste valoarea AQI in starea folosita de interfata
export function statusFromAqi(value) {
  const aqi = Number(value);

  if (!Number.isFinite(aqi)) return "unknown";
  if (aqi <= 50) return "ok";
  if (aqi <= 150) return "warning";

  return "error";
}

// ---- device definitions (modulele statice) --------------------------------
function buildDevices() {
  const devices = [];

  // 1) MOBILITY — traffic counters
  const counters = [
    ["CNT-01", "Bd. 21 Decembrie 1989", { lat: 46.7740, lng: 23.5980 }],
    ["CNT-02", "Splaiul Independenței", { lat: 46.7685, lng: 23.5840 }],
    ["CNT-03", "Piața Ștefan cel Mare", { lat: 46.7720, lng: 23.5870 }],
    ["CNT-04", "Strada Clinicilor",     { lat: 46.7665, lng: 23.5840 }],
  ];;
  counters.forEach(([id, name, c]) =>
    devices.push({
      id, module: "traffic", name, lat: c.lat, lng: c.lng, status: "ok",
      metrics: { in: rnd(60, 120) | 0, out: rnd(50, 110) | 0, speed: rnd(30, 55) | 0, occupancy: rnd(10, 60) | 0 },
    })
  );

  // 2) ENVIRONMENT — DOAR stații LIVE, fără puncte simulate.
  // Nu mai pre-populăm stații „placeholder" simulate. Stațiile de mediu apar
  // dinamic numai când sosesc date reale:
  //   • podul WAQI (aqi_bridge.py)  -> ensureEnvDevice("ENV-<uid>")
  //   • poller-ul uRADMonitor (server.js) -> ensureEnvDevice("ENV-URAD-<id>")
  // Astfel, harta de mediu conține exclusiv senzori cu măsurători reale.


  // 3) ENERGY — corpuri de iluminat inteligent (model tip CMS / LoRaWAN)
  // [id, nume, dLat, dLng, ratedW (putere nominală LED), segment (controller)]
  const lights = [
    ["LMP-01", "Bd. Eroilor",         0.001,  0.002,  90,  "SC-Centru"],
    ["LMP-02", "Str. Memorandumului", 0.002, -0.004,  75,  "SC-Centru"],
    ["LMP-03", "Calea Florești",      0.001, -0.030, 120,  "SC-Vest"],
    ["LMP-04", "Parcul Central",     -0.002, -0.010,  60,  "SC-Centru"],
    ["LMP-05", "Bd. 21 Decembrie",    0.005,  0.007, 100,  "SC-Est"],
    ["LMP-06", "Str. Horea",          0.005, -0.002,  90,  "SC-Est"],
  ];
  lights.forEach(([id, name, dLat, dLng, ratedW, segment]) => {
    const c = near(dLat, dLng);
    devices.push({
      id, module: "lighting", name, lat: c.lat, lng: c.lng, status: "ok",
      source: "simulated", segment, node: "Zhaga D4i", protocol: "LoRaWAN",
      fault: null, astro: null,
      metrics: { on: true, dim: 80, ratedW, powerW: Math.round(ratedW * 0.8) },
    });
  });

  // 4) SAFETY — CCTV cameras
  // streamUrl (optional): pune o sursă video reală în locul feed-ului simulat.
  // CAM-03 folosește webcam-ul live din Piața Avram Iancu (YouTube, webcamromania.ro).
  const cams = [
    ["CAM-03", "Piața Avram Iancu", near(0.001, 0.003), "https://www.youtube.com/embed/EfAO0iXOeiE"],
    // CAM-04: webcam live YouTube (WC3CkcTYCYY) — Planetarium Café, lângă Piața Unirii.
    ["CAM-04", "Planetarium Café", { lat: 46.768854, lng: 23.589230 }, "https://www.youtube.com/embed/WC3CkcTYCYY"],
  ];
  cams.forEach(([id, name, c, streamUrl]) =>
    devices.push({
      id, module: "video", name, lat: c.lat, lng: c.lng, status: "ok",
      source: streamUrl ? "external" : "simulated",
      streamUrl: streamUrl || null,
      metrics: { fps: 25, online: true },
    })
  );

  // 5) SERVICES — parcări cu barieră (date reale, Primăria Cluj-Napoca / OpenData)
  // parkingKey trebuie să fie EXACT „denumire" din sitpark.json (cheia de potrivire).
  // Coordonate + capacități preluate din feed-ul oficial.
  const parks = [
    ["PRK-01", "Parking Moților",         "Parking Motilor",          46.767933, 23.584979, 382],
    ["PRK-02", "Parcare Unirii",          "Parcare Unirii",           46.770511, 23.590050, 96],
    ["PRK-03", "Parcare Mihai Viteazul",  "Parcare Mihai Viteazul",   46.774168, 23.590393, 73],
    ["PRK-04", "Parcare Cipariu",         "Parcare Cipariu",          46.768347, 23.599221, 100],
    ["PRK-05", "Parking Sala Polivalentă","Parking Sala Polivalenta", 46.767020, 23.571684, 440],
    ["PRK-06", "Parking Multiplex Leul",  "Parking Multiplex Leul",   46.774915, 23.593615, 210],
    ["PRK-07", "Parking Cluj Arena",      "Parking Cluj Arena",       46.768876, 23.571106, 303],
    ["PRK-08", "Parking Hașdeu",          "Parking Hasdeu",           46.762130, 23.577944, 37],
    ["PRK-09", "Park & Ride",             "Park & Ride",              46.781571, 23.681115, 889],
  ];
  parks.forEach(([id, name, parkingKey, lat, lng, cap]) =>
    devices.push({
      id, module: "parking", name, parkingKey, lat, lng, status: "ok",
      source: "simulated", provider: "Simulator local", liveData: false,
      observedAt: null, updatedAt: null,
      // valori inițiale simulate până la prima preluare din feed
      metrics: { capacity: cap, occupied: (cap * rnd(0.3, 0.8)) | 0, free: 0 },
    })
  );

  return devices;
}

// ---- the simulator object -------------------------------------------------
export function createSimulator() {
  const devices = buildDevices();
  const history = {};            // id -> [{t, ...metrics}]
  devices.forEach((d) => (history[d.id] = []));

  // Configurare partajată: orele reale de apus/răsărit (Open-Meteo) pentru iluminat.
  const config = { sun: null, sunProvider: null };

  function tickDevice(d) {
    // Mediu: EXCLUSIV date LIVE — nu se simulează niciodată.
    // Înregistrăm istoricul valorilor reale primite; după expirarea TTL marcăm
    // stația ca „date învechite" (stale), dar NU generăm valori aleatorii.
    if (d.module === "environment") {
      const hasTtl = Number(d.externalUntil || 0) > 0;
      d.stale = hasTtl && Date.now() > Number(d.externalUntil);
      if (d.stale && d.status !== "unknown") d.status = "unknown";

      const h0 = history[d.id];
      h0.push({
        t: new Date().toLocaleTimeString("ro-RO"),
        ...JSON.parse(JSON.stringify(d.metrics)),
      });
      if (h0.length > 30) h0.shift();

      return;
    }

    // Traficul extern SUMO ramane neschimbat
    if (d.external) {
      const h0 = history[d.id];

      h0.push({
        t: new Date().toLocaleTimeString("ro-RO"),
        ...JSON.parse(JSON.stringify(d.metrics)),
      });

      if (h0.length > 30) h0.shift();

      return;
    }

    const m = d.metrics;
    switch (d.module) {
      case "traffic":
        m.in = clamp(m.in + rnd(-15, 15), 0, 200) | 0;
        m.out = clamp(m.out + rnd(-15, 15), 0, 200) | 0;
        m.speed = clamp(m.speed + rnd(-4, 4), 5, 70) | 0;
        m.occupancy = clamp(m.occupancy + rnd(-8, 8), 0, 100) | 0;
        break;
      case "lighting": {
        const now = new Date();
        const h = now.getHours() + now.getMinutes() / 60;

        // Layer 1 — aprindere/stingere pe baza orelor REALE de apus/răsărit (Open-Meteo).
        // Fallback la orar fix 19:00–07:00 dacă nu avem încă date solare.
        const sun = config.sun;
        const on = sun && sun.sunrise && sun.sunset
          ? (now < sun.sunrise || now >= sun.sunset)
          : (h >= 19 || h < 7);

        // Layer 2 — profil de dimming conform EN 13201 (reducere la miezul nopții) ...
        let base;
        if (!on) base = 0;
        else if (h < 5) base = 50;        // noapte adâncă
        else if (h < 7) base = 70;        // spre răsărit
        else if (h >= 22) base = 80;      // seara târziu
        else base = 100;                  // amurg / prima parte a serii

        // ... + dimming adaptiv la trafic (Traffic Adaptive Installation).
        let occSum = 0, occN = 0;
        devices.forEach((t) => {
          if (t.module === "traffic") { occSum += t.metrics.occupancy || 0; occN += 1; }
        });
        const avgOcc = occN ? occSum / occN : 0;
        const dim = on ? Math.min(100, Math.round(base + avgOcc * 0.25)) : 0;

        m.on = on;
        m.dim = dim;
        // Layer 3 — consum determinist din puterea nominală LED și nivelul de dimming.
        m.powerW = on ? Math.round((m.ratedW || 90) * dim / 100) : 0;
        m.occAdaptive = Math.round(avgOcc);

        // expune orele solare pentru frontend (tab Schedule)
        d.astro = sun
          ? { sunrise: sun.sunrise.toISOString(), sunset: sun.sunset.toISOString(), provider: config.sunProvider }
          : null;
        break;
      }
      case "video":
        // Camerele cu sursă reală (streamUrl) rămân mereu online, fără variații simulate.
        if (d.streamUrl) {
          d.status = "ok";
          m.online = true;
          m.fps = 25;
          break;
        }
        m.online = d.status !== "error" && d.status !== "disconnected";
        m.fps = m.online ? (24 + (Math.random() * 4 - 2)) | 0 : 0;
        break;
      case "parking":
        m.occupied = clamp(m.occupied + rnd(-6, 6), 0, m.capacity) | 0;
        m.free = m.capacity - m.occupied;
        d.status = m.free === 0 ? "warning" : "ok";
        break;
    }

    // Defecte aleatorii pentru modulele non-mediu/non-parcare (restul își calculează singure starea).
    // Camerele cu sursă reală (streamUrl) nu primesc defecte aleatorii.
    if (["traffic", "lighting", "video"].includes(d.module) && !d.streamUrl && Math.random() < 0.04) {
      const r = Math.random();
      d.status = r < 0.7 ? "ok" : r < 0.85 ? "warning" : r < 0.95 ? "error" : "disconnected";
    }

    // Layer 4 — semantica defectelor pentru iluminat (stări tipice unui CMS real)
    if (d.module === "lighting") {
      if (d.status === "error") {
        d.fault = "Lampă defectă (bec/driver ars)";
        d.metrics.on = false;
        d.metrics.powerW = 0;
        d.metrics.dim = 0;
      } else if (d.status === "disconnected") {
        d.fault = "Pierdere comunicație nod (LoRaWAN)";
      } else if (d.status === "warning") {
        d.fault = "Supraconsum / driver degradat";
      } else {
        d.fault = null;
      }
    }

    // record history (keep last 30 points)
    const h = history[d.id];
    h.push({ t: new Date().toLocaleTimeString("ro-RO"), ...JSON.parse(JSON.stringify(m)) });
    if (h.length > 30) h.shift();
  }

  function tick() {
    devices.forEach(tickDevice);
  }

  return {
    devices,
    history,
    tick,
    getDevices: () => devices,
    getHistory: (id) => history[id] || [],
    statuses: STATUSES,
    // setează orele reale de apus/răsărit (apelat de poller-ul Open-Meteo din server)
    setSunTimes: (sunrise, sunset, provider) => {
      config.sun = { sunrise, sunset };
      config.sunProvider = provider || "Open-Meteo";
    },
    getConfig: () => config,
    // Sincronizează inventarul din Open Charge Map. Locațiile EV sunt dinamice:
    // se adaugă, se actualizează și se elimină după fiecare răspuns API valid.
    syncChargingDevices: (incoming) => {
      const list = Array.isArray(incoming) ? incoming : [];
      const currentIds = new Set(list.map((item) => item.id));

      list.forEach((item) => {
        let device = devices.find((d) => d.id === item.id);

        if (!device) {
          device = { ...item, metrics: { ...(item.metrics || {}) } };
          devices.push(device);
          history[item.id] = [];
          return;
        }

        Object.assign(device, item);
        device.metrics = { ...(item.metrics || {}) };
      });

      for (let index = devices.length - 1; index >= 0; index -= 1) {
        const device = devices[index];
        if (device.module === "charging" && !currentIds.has(device.id)) {
          devices.splice(index, 1);
          delete history[device.id];
        }
      }
    },
    // Creează (dacă lipsește) un dispozitiv de mediu pentru o stație WAQI descoperită
    // dinamic de pod. Inițializează și istoricul, ca tick-ul să nu eșueze.
    ensureEnvDevice: (id) => {
      let device = devices.find((d) => d.id === id);
      if (device) return device;
      device = {
        id,
        module: "environment",
        name: id,
        stationId: null,
        lat: CENTER.lat,
        lng: CENTER.lng,
        status: "unknown",
        source: "external",
        provider: "World Air Quality Index Project",
        external: true,
        externalUntil: 0,
        observedAt: null,
        updatedAt: null,
        cityUrl: null,
        attributions: [],
        metrics: { aqi: null, pm25: null, pm10: null, no2: null, temp: null, humidity: null },
      };
      devices.push(device);
      history[id] = [];
      return device;
    },
    // Sincronizeaza vehiculele CTP din Tranzy si elimina vehiculele disparute din feed.
    syncTransitDevices: (incoming) => {
      const list = Array.isArray(incoming) ? incoming : [];
      const currentIds = new Set(list.map((item) => item.id));

      list.forEach((item) => {
        let device = devices.find((d) => d.id === item.id);

        if (!device) {
          device = { ...item, metrics: { ...(item.metrics || {}) } };
          devices.push(device);
          history[item.id] = [];
          return;
        }

        Object.assign(device, item);
        device.metrics = { ...(item.metrics || {}) };
      });

      for (let index = devices.length - 1; index >= 0; index -= 1) {
        const device = devices[index];
        if (device.module === "transit" && !currentIds.has(device.id)) {
          devices.splice(index, 1);
          delete history[device.id];
        }
      }
    },
    // Creeaza (daca lipseste) un vehicul de transport public (CTP/Tranzy).
    ensureTransitDevice: (id) => {
      let device = devices.find((d) => d.id === id);
      if (device) return device;
      device = {
        id,
        module: "transit",
        name: id,
        lat: CENTER.lat,
        lng: CENTER.lng,
        status: "ok",
        source: "external",
        provider: "CTP Cluj-Napoca (Tranzy OpenData)",
        external: true,
        observedAt: null,
        updatedAt: null,
        metrics: { speed: 0, bearing: 0, route: "", label: "", vehicleType: "bus" },
      };
      devices.push(device);
      history[id] = [];
      return device;
    },
  };
}
