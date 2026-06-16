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

  // 2) ENVIRONMENT — air quality stations
  const env = [
    ["ENV-01", "Stație Centru", near(0.000, 0.001)],
    ["ENV-02", "Stație Mărăști", near(0.006, 0.022)],
    ["ENV-03", "Stație Mănăștur", near(-0.008, -0.024)],
  ];
  env.forEach(([id, name, c]) =>
    devices.push({
      id, module: "environment", name, lat: c.lat, lng: c.lng, status: "ok",
      metrics: { pm25: rnd(8, 25) | 0, pm10: rnd(15, 45) | 0, no2: rnd(10, 40) | 0, temp: rnd(6, 12), humidity: rnd(50, 80) | 0, noise: rnd(45, 70) | 0 },
    })
  );

  // 3) ENERGY — smart street lights
  const lights = [
    ["LMP-01", "Bd. Eroilor", near(0.001, 0.002)],
    ["LMP-02", "Str. Memorandumului", near(0.002, -0.004)],
    ["LMP-03", "Calea Florești", near(0.001, -0.030)],
    ["LMP-04", "Parcul Central", near(-0.002, -0.010)],
  ];
  lights.forEach(([id, name, c]) =>
    devices.push({
      id, module: "lighting", name, lat: c.lat, lng: c.lng, status: "ok",
      metrics: { on: true, dim: 80, powerW: rnd(60, 120) | 0 },
    })
  );

  // 4) SAFETY — CCTV cameras
  const cams = [
    ["CAM-01", "Piața Unirii", near(0.000, 0.000)],
    ["CAM-02", "Gara Cluj-Napoca", near(0.014, -0.023)],
    ["CAM-03", "Piața Avram Iancu", near(0.001, 0.003)],
    ["CAM-04", "Cluj Arena", near(-0.003, -0.016)],
    ["CAM-05", "Iulius Mall", near(0.001, 0.034)],
  ];
  cams.forEach(([id, name, c]) =>
    devices.push({
      id, module: "video", name, lat: c.lat, lng: c.lng, status: "ok",
      metrics: { fps: 25, online: true },
    })
  );

  // 5) SERVICES — parking lots
  const parks = [
    ["PRK-01", "Parcare Centru (Unirii)", near(0.001, -0.001), 150],
    ["PRK-02", "Parcare Iulius Mall", near(0.000, 0.033), 400],
    ["PRK-03", "Parcare Spital Județean", near(-0.004, 0.008), 90],
  ];
  parks.forEach(([id, name, c, cap]) =>
    devices.push({
      id, module: "parking", name, lat: c.lat, lng: c.lng, status: "ok",
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

  function tickDevice(d) {
    if (d.external) {
      const h0 = history[d.id];
      h0.push({ t: new Date().toLocaleTimeString("ro-RO"), ...JSON.parse(JSON.stringify(d.metrics)) });
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
      case "environment":
        m.pm25 = clamp(m.pm25 + rnd(-3, 3), 0, 90) | 0;
        m.pm10 = clamp(m.pm10 + rnd(-4, 4), 0, 150) | 0;
        m.no2 = clamp(m.no2 + rnd(-3, 3), 0, 120) | 0;
        m.temp = +clamp(m.temp + rnd(-0.4, 0.4), -10, 40).toFixed(1);
        m.humidity = clamp(m.humidity + rnd(-2, 2), 20, 100) | 0;
        m.noise = clamp(m.noise + rnd(-3, 3), 30, 100) | 0;
        // air quality drives status: high PM2.5 => warning/error
        d.status = m.pm25 > 55 ? "error" : m.pm25 > 35 ? "warning" : "ok";
        break;
      case "lighting": {
        const hour = new Date().getHours();
        m.on = hour >= 19 || hour < 7;
        m.dim = m.on ? clamp(m.dim + rnd(-5, 5), 30, 100) | 0 : 0;
        m.powerW = m.on ? (m.dim * rnd(1.0, 1.4)) | 0 : 0;
        break;
      }
      case "video":
        m.online = d.status !== "error" && d.status !== "disconnected";
        m.fps = m.online ? (24 + (Math.random() * 4 - 2)) | 0 : 0;
        break;
      case "parking":
        m.occupied = clamp(m.occupied + rnd(-6, 6), 0, m.capacity) | 0;
        m.free = m.capacity - m.occupied;
        d.status = m.free === 0 ? "warning" : "ok";
        break;
    }

    // random faults for non-env/non-parking modules (those compute their own)
    if (["traffic", "lighting", "video"].includes(d.module) && Math.random() < 0.04) {
      const r = Math.random();
      d.status = r < 0.7 ? "ok" : r < 0.85 ? "warning" : r < 0.95 ? "error" : "disconnected";
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
  };
}
