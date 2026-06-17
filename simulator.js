// ---------------------------------------------------------------------------
//  simulator.js  —  "the living city"
//  One simulator that feeds all 5 modules. No real hardware needed.
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

// ---- device definitions (5 modules) --------------------------------------
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

  // 2) ENVIRONMENT — stații de calitate a aerului (toate stațiile WAQI din Cluj)
  // [uid WAQI, nume]. id-ul dispozitivului = ENV-<uid>, exact cheia trimisă de podul
  // aqi_bridge.py, așa că valorile REALE și coordonatele corecte le actualizează pe loc
  // când podul are conexiune. Coordonatele de start sunt distribuite în jurul centrului
  // (placeholder) până la prima măsurare reală. Stații noi se adaugă automat (ensureEnvDevice).
  const envStations = [
    ["479848", "Sânnicoară"],
    ["472192", "Cluj Napoca 2"],
    ["471601", "Cluj Napoca"],
    ["502057", "Bd. 21 Decembrie 1989"],
    ["484903", "Strada Câmpului"],
    ["523171", "Strada Fântânele"],
    ["205393", "Calea Turzii"],
    ["598894", "Strada 1 Mai"],
    ["235588", "Strada Bună Ziua"],
    ["532648", "Aleea Bâlea"],
    ["527899", "Strada George Barițiu"],
    ["760486", "Strada Constructorilor"],
    ["233335", "Aleea Budai Nagy Antal"],
    ["193945", "Antonio Gaudi S1"],
    ["527887", "Strada George Coșbuc"],
    ["532642", "Strada Aviator Bădescu"],
    ["177814", "Strada Antonio Gaudi"],
    ["518284", "Strada Bună Ziua (2)"],
    ["244603", "Strada Regele Ferdinand"],
    ["205399", "Strada Frunzișului"],
  ];
  envStations.forEach(([uid, name], i) => {
    // distribuie pe inele concentrice ca să nu se suprapună pe hartă
    const ang = (i / envStations.length) * Math.PI * 2;
    const r = 0.010 + (i % 3) * 0.006;
    devices.push({
      id: `ENV-${uid}`,
      module: "environment",
      name,
      stationId: uid,
      lat: CENTER.lat + Math.sin(ang) * r,
      lng: CENTER.lng + Math.cos(ang) * r,
      status: "ok",
      source: "simulated",
      provider: "Simulator local",
      external: false,
      externalUntil: 0,
      observedAt: null,
      cityUrl: `https://aqicn.org/station/@${uid}/ro/`,
      attributions: [],
      metrics: {
        aqi: rnd(20, 60) | 0,
        pm25: rnd(15, 50) | 0,
        pm10: rnd(10, 45) | 0,
        no2: rnd(8, 40) | 0,
        temp: +rnd(6, 18).toFixed(1),
        humidity: rnd(50, 80) | 0,
      },
    });
  });


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

// Reactiveaza simularea cand datele WAQI au expirat
function restoreEnvironmentFallback(d) {
  d.external = false;
  d.externalUntil = 0;
  d.source = "simulated";
  d.provider = "Simulator local";
  d.observedAt = null;
  d.updatedAt = null;
  d.cityUrl = null;
  d.attributions = [];

  if (!Number.isFinite(Number(d.metrics.aqi))) {
    d.metrics.aqi = rnd(20, 55) | 0;
  }

  if (!Number.isFinite(Number(d.metrics.pm25))) {
    d.metrics.pm25 = rnd(15, 50) | 0;
  }

  if (!Number.isFinite(Number(d.metrics.pm10))) {
    d.metrics.pm10 = rnd(10, 45) | 0;
  }

  if (!Number.isFinite(Number(d.metrics.no2))) {
    d.metrics.no2 = rnd(8, 40) | 0;
  }

  if (!Number.isFinite(Number(d.metrics.temp))) {
    d.metrics.temp = +rnd(6, 18).toFixed(1);
  }

  if (!Number.isFinite(Number(d.metrics.humidity))) {
    d.metrics.humidity = rnd(50, 80) | 0;
  }

  delete d.metrics.o3;
  delete d.metrics.co;
  delete d.metrics.so2;
  delete d.metrics.pressure;
  delete d.metrics.wind;
  delete d.metrics.dominantPollutant;
}

  function tickDevice(d) {
    // Traficul extern SUMO ramane neschimbat
    if (d.external && d.module !== "environment") {
      const h0 = history[d.id];

      h0.push({
        t: new Date().toLocaleTimeString("ro-RO"),
        ...JSON.parse(JSON.stringify(d.metrics)),
      });

      if (h0.length > 30) h0.shift();

      return;
    }

    // Datele WAQI expira si revin automat la simulare
    if (d.external && d.module === "environment") {
      if (Date.now() <= Number(d.externalUntil || 0)) {
        const h0 = history[d.id];

        h0.push({
          t: new Date().toLocaleTimeString("ro-RO"),
          ...JSON.parse(JSON.stringify(d.metrics)),
        });

        if (h0.length > 30) h0.shift();

        return;
      }

  restoreEnvironmentFallback(d);
}
    const m = d.metrics;
    switch (d.module) {
      case "traffic":
        m.in = clamp(m.in + rnd(-15, 15), 0, 200) | 0;
        m.out = clamp(m.out + rnd(-15, 15), 0, 200) | 0;
        m.speed = clamp(m.speed + rnd(-4, 4), 5, 70) | 0;
        m.occupancy = clamp(m.occupancy + rnd(-8, 8), 0, 100) | 0;
        break;
      // Simulare de rezerva pentru modulul de mediu
      case "environment":
        m.aqi = clamp(m.aqi + rnd(-4, 4), 0, 200) | 0;
        m.pm25 = clamp(m.pm25 + rnd(-3, 3), 0, 200) | 0;
        m.pm10 = clamp(m.pm10 + rnd(-4, 4), 0, 200) | 0;
        m.no2 = clamp(m.no2 + rnd(-3, 3), 0, 200) | 0;
        m.temp = +clamp(
          m.temp + rnd(-0.4, 0.4),
          -20,
          45,
        ).toFixed(1);
        m.humidity = clamp(
          m.humidity + rnd(-2, 2),
          20,
          100,
        ) | 0;

        d.status = statusFromAqi(m.aqi);
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
    // Creează (dacă lipsește) un vehicul de transport public (CTP/Tranzy).
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
