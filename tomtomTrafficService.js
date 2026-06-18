// Serviciu TomTom Traffic pentru date live, incidente si segmente monitorizate.
const DEFAULT_MONITORED_ROADS = [
  // Punctele sunt ancore WGS84 plasate pe carosabil, nu in centrul cartierelor.
  { id: "TT-01", name: "Bd. 21 Decembrie 1989", lat: 46.77121, lng: 23.59155, simulatedDeviceId: "CNT-01" },
  { id: "TT-02", name: "Splaiul Independentei", lat: 46.76796, lng: 23.57486, simulatedDeviceId: "CNT-02" },
  { id: "TT-03", name: "Piata Stefan cel Mare", lat: 46.76944, lng: 23.59778, simulatedDeviceId: "CNT-03" },
  { id: "TT-04", name: "Strada Clinicilor", lat: 46.76618, lng: 23.58376, simulatedDeviceId: "CNT-04" },
  { id: "TT-05", name: "Calea Floresti", lat: 46.75247, lng: 23.53343, simulatedDeviceId: null },
  { id: "TT-06", name: "Calea Manastur", lat: 46.76065, lng: 23.55991, simulatedDeviceId: null },
  { id: "TT-07", name: "Calea Turzii", lat: 46.74843, lng: 23.60036, simulatedDeviceId: null },
  { id: "TT-08", name: "Strada Observatorului", lat: 46.75238, lng: 23.58551, simulatedDeviceId: null },
  { id: "TT-09", name: "Strada Horea", lat: 46.77932, lng: 23.58667, simulatedDeviceId: null },
  { id: "TT-10", name: "Piata Marasti", lat: 46.77778, lng: 23.61361, simulatedDeviceId: null },
];

const INCIDENT_CATEGORY = {
  0: "Necunoscut",
  1: "Accident",
  2: "Ceata",
  3: "Conditii periculoase",
  4: "Ploaie",
  5: "Gheata",
  6: "Ambuteiaj",
  7: "Banda inchisa",
  8: "Drum inchis",
  9: "Lucrari",
  10: "Vant",
  11: "Inundatie",
  14: "Vehicul defect",
};

const DELAY_MAGNITUDE = {
  0: "Necunoscut",
  1: "Minor",
  2: "Moderat",
  3: "Major",
  4: "Nedeterminat",
};

const ALLOWED_TILE_STYLES = new Set([
  "absolute",
  "relative",
  "relative0",
  "relative0-dark",
  "relative-delay",
  "reduced-sensitivity",
]);

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dateKey() {
  return new Date().toISOString().slice(0, 10);
}

function firstCoordinate(geometry) {
  const coordinates = geometry?.coordinates;
  if (!Array.isArray(coordinates)) return null;

  if (
    coordinates.length >= 2
    && Number.isFinite(Number(coordinates[0]))
    && Number.isFinite(Number(coordinates[1]))
  ) {
    return {
      lng: Number(coordinates[0]),
      lat: Number(coordinates[1]),
    };
  }

  for (const item of coordinates) {
    const result = firstCoordinate({ coordinates: item });
    if (result) return result;
  }

  return null;
}

function segmentStatus(congestionPercent, roadClosure) {
  if (roadClosure) return "error";
  if (congestionPercent >= 50) return "error";
  if (congestionPercent >= 25) return "warning";
  return "ok";
}

function normaliseCoordinates(value) {
  const list = Array.isArray(value?.coordinate) ? value.coordinate : [];

  return list
    .map((item) => ({
      lat: toNumber(item?.latitude),
      lng: toNumber(item?.longitude),
    }))
    .filter((item) => item.lat !== null && item.lng !== null);
}

function closestCoordinate(coordinates, target) {
  // Alege coordonata TomTom cea mai apropiata de punctul de interogare.
  if (!Array.isArray(coordinates) || !coordinates.length) return null;

  let closest = null;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const coordinate of coordinates) {
    const latDelta = coordinate.lat - target.lat;
    const lngDelta = (coordinate.lng - target.lng) * Math.cos(target.lat * Math.PI / 180);
    const distance = (latDelta * latDelta) + (lngDelta * lngDelta);

    if (distance < closestDistance) {
      closest = coordinate;
      closestDistance = distance;
    }
  }

  return closest ? { lat: closest.lat, lng: closest.lng } : null;
}

function normaliseSegment(raw, road, observedAt) {
  const flow = raw?.flowSegmentData;
  if (!flow) throw new Error("TomTom response does not contain flowSegmentData");

  const currentSpeed = toNumber(flow.currentSpeed);
  const freeFlowSpeed = toNumber(flow.freeFlowSpeed);
  const currentTravelTime = toNumber(flow.currentTravelTime);
  const freeFlowTravelTime = toNumber(flow.freeFlowTravelTime);
  const confidence = toNumber(flow.confidence);
  const roadClosure = Boolean(flow.roadClosure);

  if (currentSpeed === null || freeFlowSpeed === null) {
    throw new Error("TomTom response does not contain numeric speeds");
  }

  const ratio = freeFlowSpeed > 0 ? currentSpeed / freeFlowSpeed : 0;
  const congestionPercent = roadClosure
    ? 100
    : Math.round(clamp((1 - ratio) * 100, 0, 100));
  const delaySeconds = currentTravelTime !== null && freeFlowTravelTime !== null
    ? Math.max(0, currentTravelTime - freeFlowTravelTime)
    : null;

  const coordinates = normaliseCoordinates(flow.coordinates);
  const queryPoint = { lat: road.lat, lng: road.lng };
  const snappedPoint = closestCoordinate(coordinates, queryPoint) || queryPoint;

  return {
    id: road.id,
    name: road.name,
    queryPoint,
    samplePoint: snappedPoint,
    coordinateSource: coordinates.length ? "tomtom_geometry" : "configured_anchor",
    simulatedDeviceId: road.simulatedDeviceId || null,
    frc: flow.frc || null,
    currentSpeed,
    freeFlowSpeed,
    speedRatio: Number(ratio.toFixed(3)),
    congestionPercent,
    currentTravelTime,
    freeFlowTravelTime,
    delaySeconds,
    confidence,
    roadClosure,
    status: segmentStatus(congestionPercent, roadClosure),
    coordinates,
    observedAt,
    source: "TomTom Traffic Flow",
  };
}

function normaliseIncident(feature, observedAt) {
  const properties = feature?.properties || {};
  const geometry = feature?.geometry || null;
  const center = firstCoordinate(geometry);
  const iconCategory = Number(properties.iconCategory || 0);
  const magnitude = Number(properties.magnitudeOfDelay || 0);
  const events = Array.isArray(properties.events) ? properties.events : [];

  return {
    id: String(properties.id || `${iconCategory}-${center?.lat || 0}-${center?.lng || 0}`),
    categoryCode: iconCategory,
    category: INCIDENT_CATEGORY[iconCategory] || "Necunoscut",
    magnitudeCode: magnitude,
    magnitude: DELAY_MAGNITUDE[magnitude] || "Necunoscut",
    description: events.map((event) => event?.description).filter(Boolean).join("; ") || null,
    from: properties.from || null,
    to: properties.to || null,
    startTime: properties.startTime || null,
    endTime: properties.endTime || null,
    lengthMeters: toNumber(properties.length),
    delaySeconds: toNumber(properties.delay),
    roadNumbers: Array.isArray(properties.roadNumbers) ? properties.roadNumbers : [],
    probability: properties.probabilityOfOccurrence || null,
    numberOfReports: toNumber(properties.numberOfReports),
    lastReportTime: properties.lastReportTime || null,
    geometry,
    center,
    observedAt,
    source: "TomTom Traffic Incidents",
  };
}

export function createTomTomTrafficService(options = {}) {
  const baseUrl = String(options.baseUrl || "https://api.tomtom.com").replace(/\/$/, "");
  const apiKey = String(options.apiKey || "").trim();
  const segmentPollMs = Math.max(60_000, Number(options.segmentPollMs || 600_000));
  const incidentPollMs = Math.max(60_000, Number(options.incidentPollMs || 120_000));
  const bbox = String(options.bbox || "23.4500,46.7000,23.7500,46.8600");
  const zoom = clamp(Number(options.zoom || 16), 0, 22);
  const maxNonTileRequestsPerDay = Math.max(100, Number(options.maxNonTileRequestsPerDay || 2400));
  const monitoredRoads = Array.isArray(options.monitoredRoads) && options.monitoredRoads.length
    ? options.monitoredRoads
    : DEFAULT_MONITORED_ROADS;

  const state = {
    enabled: Boolean(apiKey),
    segments: monitoredRoads.map((road) => ({
      ...road,
      samplePoint: { lat: road.lat, lng: road.lng },
      status: "unknown",
      source: "TomTom Traffic Flow",
      observedAt: null,
      error: null,
    })),
    incidents: [],
    segmentHistory: new Map(),
    lastSegmentAttempt: null,
    lastSegmentSuccess: null,
    lastIncidentAttempt: null,
    lastIncidentSuccess: null,
    errors: {},
    usage: { day: dateKey(), nonTileRequests: 0 },
    timers: [],
    started: false,
  };

  const onDemandCache = new Map();
  const tileCache = new Map();
  const TILE_CACHE_TTL_MS = 55_000;
  const SEGMENT_CACHE_TTL_MS = 60_000;
  const MAX_TILE_CACHE_ITEMS = 800;

  function resetUsageIfNeeded() {
    const currentDay = dateKey();
    if (state.usage.day !== currentDay) {
      state.usage = { day: currentDay, nonTileRequests: 0 };
    }
  }

  function reserveNonTileRequest() {
    resetUsageIfNeeded();
    if (state.usage.nonTileRequests >= maxNonTileRequestsPerDay) {
      throw new Error("TomTom daily non-tile safety budget reached");
    }
    state.usage.nonTileRequests += 1;
  }

  async function fetchJson(url, timeoutMs = 12_000) {
    reserveNonTileRequest();

    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "User-Agent": "SmartCity-Cluj-Thesis/1.0",
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`TomTom HTTP ${response.status}${body ? `: ${body.slice(0, 180)}` : ""}`);
    }

    return response.json();
  }

  async function fetchFlowSegment(road) {
    if (!apiKey) throw new Error("TOMTOM_API_KEY is missing");

    const url = new URL(
      `${baseUrl}/traffic/services/4/flowSegmentData/relative0/${zoom}/json`,
    );
    url.searchParams.set("key", apiKey);
    url.searchParams.set("point", `${road.lat},${road.lng}`);
    url.searchParams.set("unit", "kmph");
    url.searchParams.set("openLr", "false");

    const observedAt = new Date().toISOString();
    const payload = await fetchJson(url);
    return normaliseSegment(payload, road, observedAt);
  }

  async function pollSegments() {
    if (!apiKey) return;

    state.lastSegmentAttempt = new Date().toISOString();
    const next = [];
    let successful = 0;

    for (const road of monitoredRoads) {
      try {
        const segment = await fetchFlowSegment(road);
        next.push(segment);
        successful += 1;

        const history = state.segmentHistory.get(road.id) || [];
        history.push({
          observedAt: segment.observedAt,
          currentSpeed: segment.currentSpeed,
          freeFlowSpeed: segment.freeFlowSpeed,
          congestionPercent: segment.congestionPercent,
          delaySeconds: segment.delaySeconds,
          confidence: segment.confidence,
        });
        state.segmentHistory.set(road.id, history.slice(-144));
      } catch (error) {
        const previous = state.segments.find((item) => item.id === road.id);
        next.push({
          ...(previous || road),
          id: road.id,
          name: road.name,
          queryPoint: { lat: road.lat, lng: road.lng },
          samplePoint: previous?.samplePoint || { lat: road.lat, lng: road.lng },
          coordinateSource: previous?.coordinateSource || "configured_anchor",
          simulatedDeviceId: road.simulatedDeviceId || null,
          status: previous?.status || "unknown",
          error: error.message,
        });
      }

      await sleep(220);
    }

    state.segments = next;

    if (successful > 0) {
      state.lastSegmentSuccess = new Date().toISOString();
      delete state.errors.segments;
    } else {
      state.errors.segments = "No monitored segment could be updated";
    }
  }

  async function pollIncidents() {
    if (!apiKey) return;

    state.lastIncidentAttempt = new Date().toISOString();

    try {
      const fields = "{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,code,iconCategory},startTime,endTime,from,to,length,delay,roadNumbers,timeValidity,probabilityOfOccurrence,numberOfReports,lastReportTime}}}";
      const url = new URL(`${baseUrl}/traffic/services/5/incidentDetails`);
      url.searchParams.set("key", apiKey);
      url.searchParams.set("bbox", bbox);
      url.searchParams.set("fields", fields);
      url.searchParams.set("language", "ro-RO");
      url.searchParams.set("timeValidityFilter", "present");

      const observedAt = new Date().toISOString();
      const payload = await fetchJson(url);
      const incidents = Array.isArray(payload?.incidents) ? payload.incidents : [];
      state.incidents = incidents.map((item) => normaliseIncident(item, observedAt));
      state.lastIncidentSuccess = observedAt;
      delete state.errors.incidents;
    } catch (error) {
      state.errors.incidents = error.message;
    }
  }

  async function querySegment(lat, lng, requestedZoom = zoom) {
    if (!apiKey) throw new Error("TOMTOM_API_KEY is missing");

    const latitude = toNumber(lat);
    const longitude = toNumber(lng);
    const safeZoom = clamp(Number(requestedZoom || zoom), 0, 22);

    if (latitude === null || longitude === null) {
      throw new Error("lat and lng must be numeric");
    }

    const cacheKey = `${latitude.toFixed(5)},${longitude.toFixed(5)},${safeZoom}`;
    const cached = onDemandCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < SEGMENT_CACHE_TTL_MS) {
      return { ...cached.value, cache: "hit" };
    }

    const road = {
      id: `CLICK-${cacheKey}`,
      name: "Segment selectat",
      lat: latitude,
      lng: longitude,
      simulatedDeviceId: null,
    };

    const originalZoom = zoom;
    const url = new URL(
      `${baseUrl}/traffic/services/4/flowSegmentData/relative0/${safeZoom}/json`,
    );
    url.searchParams.set("key", apiKey);
    url.searchParams.set("point", `${latitude},${longitude}`);
    url.searchParams.set("unit", "kmph");
    url.searchParams.set("openLr", "false");

    const observedAt = new Date().toISOString();
    const payload = await fetchJson(url);
    const value = normaliseSegment(payload, road, observedAt);
    value.zoom = safeZoom || originalZoom;

    onDemandCache.set(cacheKey, { createdAt: Date.now(), value });
    return { ...value, cache: "miss" };
  }

  function getStatus() {
    resetUsageIfNeeded();

    return {
      enabled: state.enabled,
      source: "TomTom Traffic API",
      segmentPollMs,
      incidentPollMs,
      bbox,
      zoom,
      monitoredRoads: monitoredRoads.length,
      lastSegmentAttempt: state.lastSegmentAttempt,
      lastSegmentSuccess: state.lastSegmentSuccess,
      lastIncidentAttempt: state.lastIncidentAttempt,
      lastIncidentSuccess: state.lastIncidentSuccess,
      errors: { ...state.errors },
      usage: {
        ...state.usage,
        safetyLimit: maxNonTileRequestsPerDay,
        remaining: Math.max(0, maxNonTileRequestsPerDay - state.usage.nonTileRequests),
      },
    };
  }

  function getSegments() {
    return state.segments.map((segment) => ({ ...segment }));
  }

  function getSegment(id) {
    const segment = state.segments.find((item) => item.id === id);
    if (!segment) return null;

    return {
      ...segment,
      history: [...(state.segmentHistory.get(id) || [])],
    };
  }

  function getIncidents() {
    return state.incidents.map((incident) => ({ ...incident }));
  }

  async function getFlowTile({ z, x, y, style = "relative0" }) {
    if (!apiKey) throw new Error("TOMTOM_API_KEY is missing");

    const safeStyle = ALLOWED_TILE_STYLES.has(style) ? style : "relative0";
    const rawZoom = Number(z);
    const tileX = Number(x);
    const tileY = Number(y);

    if (!Number.isInteger(rawZoom) || rawZoom < 0 || rawZoom > 22) {
      throw new Error("Invalid tile zoom");
    }

    const zoomLevel = rawZoom;
    const maxCoordinate = (2 ** zoomLevel) - 1;
    if (
      !Number.isInteger(tileX)
      || !Number.isInteger(tileY)
      || tileX < 0
      || tileY < 0
      || tileX > maxCoordinate
      || tileY > maxCoordinate
    ) {
      throw new Error("Invalid tile coordinates");
    }

    const cacheKey = `${safeStyle}/${zoomLevel}/${tileX}/${tileY}`;
    const cached = tileCache.get(cacheKey);

    if (cached && Date.now() - cached.createdAt < TILE_CACHE_TTL_MS) {
      return { ...cached, cache: "hit" };
    }

    const url = new URL(
      `${baseUrl}/traffic/map/4/tile/flow/${safeStyle}/${zoomLevel}/${tileX}/${tileY}.png`,
    );
    url.searchParams.set("key", apiKey);
    url.searchParams.set("tileSize", "256");

    const response = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      headers: {
        Accept: "image/png",
        "User-Agent": "SmartCity-Cluj-Thesis/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(`TomTom tile HTTP ${response.status}`);
    }

    const result = {
      createdAt: Date.now(),
      buffer: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") || "image/png",
      cache: "miss",
    };

    tileCache.set(cacheKey, result);

    if (tileCache.size > MAX_TILE_CACHE_ITEMS) {
      const oldestKey = tileCache.keys().next().value;
      tileCache.delete(oldestKey);
    }

    return result;
  }

  async function start() {
    if (state.started) return;
    state.started = true;

    if (!apiKey) return;

    await Promise.allSettled([pollSegments(), pollIncidents()]);
    state.timers.push(setInterval(pollSegments, segmentPollMs));
    state.timers.push(setInterval(pollIncidents, incidentPollMs));
  }

  function stop() {
    state.timers.forEach((timer) => clearInterval(timer));
    state.timers = [];
    state.started = false;
  }

  return {
    start,
    stop,
    pollSegments,
    pollIncidents,
    querySegment,
    getStatus,
    getSegments,
    getSegment,
    getIncidents,
    getFlowTile,
  };
}
