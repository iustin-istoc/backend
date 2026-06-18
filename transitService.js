// Fisier: transitService.js
// Serviciu Tranzy separat de server.js: incarca date GTFS, vehicule live si ETA-uri.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REALTIME_POLL_MS = 20_000;
const DEFAULT_STATIC_POLL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_HORIZON_MINUTES = 180;
const DEFAULT_MAX_ARRIVALS = 12;

function asArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.entity)) return payload.entity;
  return [];
}

function asString(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseDateKey(value) {
  const text = asString(value).replace(/-/g, "");
  if (!/^\d{8}$/.test(text)) return null;
  return text;
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function gtfsTimeToDate(timeValue, serviceDate) {
  const text = asString(timeValue).trim();
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;

  const totalHours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);

  if (
    !Number.isFinite(totalHours)
    || !Number.isFinite(minutes)
    || !Number.isFinite(seconds)
    || minutes > 59
    || seconds > 59
  ) {
    return null;
  }

  const dayOffset = Math.floor(totalHours / 24);
  const hour = totalHours % 24;
  const result = new Date(
    serviceDate.getFullYear(),
    serviceDate.getMonth(),
    serviceDate.getDate(),
    hour,
    minutes,
    seconds,
    0,
  );
  result.setDate(result.getDate() + dayOffset);
  return result;
}

function epochToDate(value) {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const millis = number > 10_000_000_000 ? number : number * 1000;
  const parsed = new Date(millis);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = (degrees) => degrees * Math.PI / 180;
  const earthRadius = 6_371_000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = (
    Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1))
      * Math.cos(toRad(lat2))
      * Math.sin(dLng / 2) ** 2
  );
  return 2 * earthRadius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function routeTypeLabel(routeType) {
  const value = Number(routeType);
  if (value === 0) return "tram";
  if (value === 1) return "metro";
  if (value === 2) return "rail";
  if (value === 3) return "bus";
  if (value === 11) return "trolleybus";
  return "bus";
}

function normaliseRoute(raw) {
  const routeId = asString(raw?.route_id ?? raw?.id);
  if (!routeId) return null;

  return {
    routeId,
    shortName: asString(
      raw?.route_short_name
      ?? raw?.short_name
      ?? raw?.name
      ?? routeId,
    ),
    longName: asString(raw?.route_long_name ?? raw?.long_name),
    description: asString(raw?.route_desc ?? raw?.description),
    type: routeTypeLabel(raw?.route_type ?? raw?.type),
    color: asString(raw?.route_color).replace(/^#/, ""),
    textColor: asString(raw?.route_text_color).replace(/^#/, ""),
  };
}

function normaliseStop(raw) {
  const stopId = asString(raw?.stop_id ?? raw?.id);
  const lat = asNumber(raw?.stop_lat ?? raw?.latitude ?? raw?.lat);
  const lng = asNumber(raw?.stop_lon ?? raw?.longitude ?? raw?.lng ?? raw?.lon);

  if (!stopId || lat === null || lng === null) return null;

  return {
    stopId,
    code: asString(raw?.stop_code ?? raw?.code),
    name: asString(raw?.stop_name ?? raw?.name ?? `Statia ${stopId}`),
    description: asString(raw?.stop_desc ?? raw?.description),
    lat,
    lng,
    locationType: asNumber(raw?.location_type) ?? 0,
    parentStation: asString(raw?.parent_station),
    wheelchairBoarding: asNumber(raw?.wheelchair_boarding),
    routes: [],
  };
}

function normaliseTrip(raw) {
  const tripId = asString(raw?.trip_id ?? raw?.id);
  const routeId = asString(raw?.route_id);
  if (!tripId || !routeId) return null;

  return {
    tripId,
    routeId,
    serviceId: asString(raw?.service_id),
    headsign: asString(raw?.trip_headsign ?? raw?.headsign),
    directionId: asNumber(raw?.direction_id),
    shapeId: asString(raw?.shape_id),
  };
}

function normaliseStopTime(raw) {
  const tripId = asString(raw?.trip_id);
  const stopId = asString(raw?.stop_id);
  if (!tripId || !stopId) return null;

  return {
    tripId,
    stopId,
    arrivalTime: asString(raw?.arrival_time ?? raw?.arrival),
    departureTime: asString(raw?.departure_time ?? raw?.departure),
    stopSequence: asNumber(raw?.stop_sequence ?? raw?.sequence) ?? 0,
    pickupType: asNumber(raw?.pickup_type),
    dropOffType: asNumber(raw?.drop_off_type),
  };
}

function normaliseCalendar(raw) {
  const serviceId = asString(raw?.service_id ?? raw?.id);
  if (!serviceId) return null;

  return {
    serviceId,
    monday: Number(raw?.monday) === 1,
    tuesday: Number(raw?.tuesday) === 1,
    wednesday: Number(raw?.wednesday) === 1,
    thursday: Number(raw?.thursday) === 1,
    friday: Number(raw?.friday) === 1,
    saturday: Number(raw?.saturday) === 1,
    sunday: Number(raw?.sunday) === 1,
    startDate: parseDateKey(raw?.start_date),
    endDate: parseDateKey(raw?.end_date),
  };
}

function normaliseCalendarDate(raw) {
  const serviceId = asString(raw?.service_id);
  const date = parseDateKey(raw?.date);
  const exceptionType = asNumber(raw?.exception_type);
  if (!serviceId || !date || exceptionType === null) return null;

  return { serviceId, date, exceptionType };
}

function normaliseVehicle(raw, routeById) {
  const lat = asNumber(raw?.latitude ?? raw?.lat);
  const lng = asNumber(raw?.longitude ?? raw?.lng ?? raw?.lon);
  const rawId = raw?.id ?? raw?.vehicle_id ?? raw?.vehicle?.id ?? raw?.label;
  const vehicleId = asString(rawId);

  if (!vehicleId || lat === null || lng === null) return null;

  const routeId = asString(raw?.route_id ?? raw?.trip?.route_id);
  const route = routeById.get(routeId);
  const routeName = route?.shortName || routeId;
  const vehicleTypeRaw = raw?.vehicle_type ?? raw?.type ?? route?.type;
  const vehicleType = typeof vehicleTypeRaw === "string"
    ? vehicleTypeRaw.toLowerCase()
    : Number(vehicleTypeRaw) === 0
      ? "tram"
      : route?.type || "bus";

  return {
    vehicleId,
    tripId: asString(raw?.trip_id ?? raw?.trip?.trip_id),
    routeId,
    routeName,
    label: asString(raw?.label ?? raw?.vehicle?.label ?? vehicleId),
    lat,
    lng,
    speed: Math.max(0, Math.round(asNumber(raw?.speed) || 0)),
    bearing: Math.round(asNumber(raw?.bearing) || 0),
    timestamp: raw?.timestamp ?? raw?.observed_at ?? new Date().toISOString(),
    vehicleType,
  };
}

function activeServicesForDate(date, calendars, calendarDates) {
  if (!calendars.length && !calendarDates.length) return null;

  const dateKey = localDateKey(date);
  const dayNames = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  const dayName = dayNames[date.getDay()];
  const active = new Set();

  calendars.forEach((calendar) => {
    if (calendar.startDate && dateKey < calendar.startDate) return;
    if (calendar.endDate && dateKey > calendar.endDate) return;
    if (calendar[dayName]) active.add(calendar.serviceId);
  });

  calendarDates.forEach((exception) => {
    if (exception.date !== dateKey) return;
    if (exception.exceptionType === 1) active.add(exception.serviceId);
    if (exception.exceptionType === 2) active.delete(exception.serviceId);
  });

  return active;
}

function eventDate(event) {
  if (!event) return null;
  return epochToDate(event.time ?? event.timestamp ?? event.date_time ?? event.datetime);
}

function extractTripUpdates(payload) {
  const rows = asArray(payload);
  const updates = [];

  rows.forEach((row) => {
    const tripUpdate = row?.trip_update ?? row?.tripUpdate ?? row;
    const tripId = asString(
      tripUpdate?.trip_id
      ?? tripUpdate?.trip?.trip_id
      ?? tripUpdate?.tripId,
    );
    if (!tripId) return;

    const stopUpdates = (
      tripUpdate?.stop_time_update
      ?? tripUpdate?.stop_time_updates
      ?? tripUpdate?.stopTimeUpdate
      ?? tripUpdate?.stop_times
      ?? []
    );

    const list = Array.isArray(stopUpdates) ? stopUpdates : [stopUpdates];
    list.forEach((stopUpdate) => {
      const stopId = asString(
        stopUpdate?.stop_id
        ?? stopUpdate?.stop?.stop_id
        ?? stopUpdate?.stopId,
      );
      if (!stopId) return;

      const arrival = eventDate(stopUpdate?.arrival);
      const departure = eventDate(stopUpdate?.departure);
      const delay = asNumber(
        stopUpdate?.arrival?.delay
        ?? stopUpdate?.departure?.delay
        ?? stopUpdate?.delay,
      );

      updates.push({
        tripId,
        stopId,
        stopSequence: asNumber(stopUpdate?.stop_sequence ?? stopUpdate?.sequence),
        estimatedAt: arrival || departure,
        delaySeconds: delay,
      });
    });
  });

  return updates;
}

export function createTransitService(options = {}) {
  const baseUrl = asString(options.baseUrl).replace(/\/$/, "");
  const apiKey = asString(options.apiKey).trim();
  const configuredAgencyId = asString(options.agencyId).trim();
  const realtimePollMs = Number(options.realtimePollMs) || DEFAULT_REALTIME_POLL_MS;
  const staticPollMs = Number(options.staticPollMs) || DEFAULT_STATIC_POLL_MS;
  const horizonMinutes = Number(options.horizonMinutes) || DEFAULT_HORIZON_MINUTES;
  const maxArrivals = Number(options.maxArrivals) || DEFAULT_MAX_ARRIVALS;
  const onVehicles = typeof options.onVehicles === "function" ? options.onVehicles : () => {};
  const logger = options.logger || console;
  // Cache pe disc pentru rețeaua statică GTFS (stații, linii, curse), ca transportul
  // să fie disponibil chiar dacă Tranzy e picat (502/500) la pornire.
  const cacheFile = asString(options.staticCacheFile)
    || path.join(path.dirname(fileURLToPath(import.meta.url)), "transit-static-cache.json");

  const state = {
    enabled: Boolean(apiKey),
    agencyId: configuredAgencyId || null,
    agencyName: "CTP Cluj-Napoca",
    routes: [],
    stops: [],
    trips: [],
    stopTimes: [],
    calendars: [],
    calendarDates: [],
    vehicles: [],
    officialTripUpdates: new Map(),
    gpsEstimates: new Map(),
    routeById: new Map(),
    stopById: new Map(),
    tripById: new Map(),
    stopTimesByStop: new Map(),
    stopTimesByTrip: new Map(),
    routeStops: new Map(),
    lastStaticUpdate: null,
    lastRealtimeUpdate: null,
    lastError: null,
    endpointErrors: {},
    staticFromCache: false,
  };

  let realtimeTimer = null;
  let staticTimer = null;
  let stopped = false;

  async function request(path, agencyId = state.agencyId) {
    if (!apiKey) throw new Error("TRANZY_API_KEY lipseste");

    const headers = {
      Accept: "application/json",
      "X-API-KEY": apiKey,
    };
    if (agencyId) headers["X-Agency-Id"] = asString(agencyId);

    const response = await fetch(`${baseUrl}${path}`, {
      headers,
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 140)}` : ""}`);
    }

    return response.json();
  }

  async function safeRequest(path, agencyId = state.agencyId) {
    try {
      const payload = await request(path, agencyId);
      delete state.endpointErrors[path];
      return payload;
    } catch (error) {
      state.endpointErrors[path] = error.message;
      return null;
    }
  }

  async function resolveAgency() {
    if (state.agencyId) return state.agencyId;

    const payload = await request("/agency", null);
    const agencies = asArray(payload);
    const agency = agencies.find((item) => {
      const text = asString(item?.agency_name ?? item?.name).toLowerCase();
      return text.includes("cluj");
    });

    if (!agency) throw new Error("Nu am gasit agentia CTP Cluj in /agency");

    state.agencyId = asString(agency?.agency_id ?? agency?.id);
    state.agencyName = asString(agency?.agency_name ?? agency?.name, state.agencyName);
    logger.log(`  Tranzy: agency_id Cluj = ${state.agencyId}`);
    return state.agencyId;
  }

  function rebuildIndexes() {
    state.routeById = new Map(state.routes.map((route) => [route.routeId, route]));
    state.stopById = new Map(state.stops.map((stop) => [stop.stopId, stop]));
    state.tripById = new Map(state.trips.map((trip) => [trip.tripId, trip]));
    state.stopTimesByStop = new Map();
    state.stopTimesByTrip = new Map();

    state.stopTimes.forEach((stopTime) => {
      if (!state.stopTimesByStop.has(stopTime.stopId)) {
        state.stopTimesByStop.set(stopTime.stopId, []);
      }
      state.stopTimesByStop.get(stopTime.stopId).push(stopTime);

      if (!state.stopTimesByTrip.has(stopTime.tripId)) {
        state.stopTimesByTrip.set(stopTime.tripId, []);
      }
      state.stopTimesByTrip.get(stopTime.tripId).push(stopTime);
    });

    state.stopTimesByTrip.forEach((rows) => {
      rows.sort((a, b) => a.stopSequence - b.stopSequence);
    });

    const routeTripCandidates = new Map();
    state.stopTimesByTrip.forEach((rows, tripId) => {
      const trip = state.tripById.get(tripId);
      if (!trip) return;
      const key = `${trip.routeId}:${trip.directionId ?? "x"}`;
      const previous = routeTripCandidates.get(key);
      if (!previous || rows.length > previous.rows.length) {
        routeTripCandidates.set(key, { trip, rows });
      }
    });

    state.routeStops = new Map();
    routeTripCandidates.forEach(({ trip, rows }) => {
      if (!state.routeStops.has(trip.routeId)) state.routeStops.set(trip.routeId, []);
      const target = state.routeStops.get(trip.routeId);
      rows.forEach((row) => {
        if (!target.includes(row.stopId)) target.push(row.stopId);
      });
    });

    const routesPerStop = new Map();
    state.stopTimes.forEach((stopTime) => {
      const trip = state.tripById.get(stopTime.tripId);
      if (!trip) return;
      if (!routesPerStop.has(stopTime.stopId)) routesPerStop.set(stopTime.stopId, new Set());
      routesPerStop.get(stopTime.stopId).add(trip.routeId);
    });

    state.stops.forEach((stop) => {
      const routeIds = [...(routesPerStop.get(stop.stopId) || [])];
      stop.routes = routeIds
        .map((routeId) => state.routeById.get(routeId)?.shortName || routeId)
        .sort((a, b) => a.localeCompare(b, "ro", { numeric: true }));
    });
  }

  function saveStaticCache() {
    try {
      const snapshot = {
        savedAt: new Date().toISOString(),
        agencyId: state.agencyId,
        agencyName: state.agencyName,
        routes: state.routes,
        stops: state.stops,
        trips: state.trips,
        stopTimes: state.stopTimes,
        calendars: state.calendars,
        calendarDates: state.calendarDates,
      };
      fs.writeFileSync(cacheFile, JSON.stringify(snapshot));
    } catch (error) {
      logger.error("  ! Nu am putut salva cache-ul GTFS:", error.message);
    }
  }

  function loadStaticCache() {
    try {
      if (!fs.existsSync(cacheFile)) return false;
      const data = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      if (!Array.isArray(data.stops) || !data.stops.length) return false;

      if (!state.agencyId && data.agencyId) state.agencyId = asString(data.agencyId);
      if (data.agencyName) state.agencyName = asString(data.agencyName, state.agencyName);
      state.routes = Array.isArray(data.routes) ? data.routes : [];
      state.stops = data.stops;
      state.trips = Array.isArray(data.trips) ? data.trips : [];
      state.stopTimes = Array.isArray(data.stopTimes) ? data.stopTimes : [];
      state.calendars = Array.isArray(data.calendars) ? data.calendars : [];
      state.calendarDates = Array.isArray(data.calendarDates) ? data.calendarDates : [];

      rebuildIndexes();
      state.lastStaticUpdate = data.savedAt || null;
      state.staticFromCache = true;
      logger.log(
        `  Transport static (din cache local): ${state.stops.length} statii, ${state.routes.length} linii (salvat ${data.savedAt}).`,
      );
      return true;
    } catch (error) {
      logger.error("  ! Cache GTFS invalid, il ignor:", error.message);
      return false;
    }
  }

  async function pollStatic() {
    if (!apiKey || stopped) return;

    try {
      await resolveAgency();

      const endpoints = [
        "/routes",
        "/stops",
        "/trips",
        "/stop_times",
        "/calendar",
        "/calendar_dates",
      ];
      const results = await Promise.all(endpoints.map((path) => safeRequest(path)));
      const [routesPayload, stopsPayload, tripsPayload, stopTimesPayload, calendarPayload, calendarDatesPayload] = results;

      const routes = asArray(routesPayload).map(normaliseRoute).filter(Boolean);
      const stops = asArray(stopsPayload).map(normaliseStop).filter(Boolean);
      const trips = asArray(tripsPayload).map(normaliseTrip).filter(Boolean);
      const stopTimes = asArray(stopTimesPayload).map(normaliseStopTime).filter(Boolean);
      const calendars = asArray(calendarPayload).map(normaliseCalendar).filter(Boolean);
      const calendarDates = asArray(calendarDatesPayload).map(normaliseCalendarDate).filter(Boolean);

      if (routes.length) state.routes = routes;
      if (stops.length) state.stops = stops;
      if (trips.length) state.trips = trips;
      if (stopTimes.length) state.stopTimes = stopTimes;
      if (calendarPayload !== null) state.calendars = calendars;
      if (calendarDatesPayload !== null) state.calendarDates = calendarDates;

      rebuildIndexes();
      state.lastStaticUpdate = new Date().toISOString();
      state.lastError = null;

      // Persistăm rețeaua proaspătă pe disc doar dacă chiar avem date utile.
      if (state.stops.length && state.routes.length) {
        state.staticFromCache = false;
        saveStaticCache();
      }

      logger.log(
        `  Transport static: ${state.stops.length} statii, ${state.routes.length} linii, ${state.trips.length} curse.`,
      );
    } catch (error) {
      state.lastError = error.message;
      logger.error("  ! Tranzy static indisponibil:", error.message);
      // Dacă nu avem nimic în memorie, încercăm cache-ul local salvat anterior.
      if (!state.stops.length) loadStaticCache();
    }
  }

  function buildGpsEstimates(vehicles) {
    const estimates = new Map();
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    vehicles.forEach((vehicle) => {
      if (!vehicle.tripId) return;
      const tripRows = state.stopTimesByTrip.get(vehicle.tripId);
      if (!tripRows?.length) return;

      let nearest = null;
      tripRows.forEach((row) => {
        const stop = state.stopById.get(row.stopId);
        if (!stop) return;
        const distance = haversineMeters(vehicle.lat, vehicle.lng, stop.lat, stop.lng);
        if (!nearest || distance < nearest.distance) nearest = { row, distance };
      });
      if (!nearest || nearest.distance > 2500) return;

      const nearestTimeText = nearest.row.arrivalTime || nearest.row.departureTime;
      const candidates = [-1, 0, 1]
        .map((offset) => gtfsTimeToDate(nearestTimeText, addDays(today, offset)))
        .filter(Boolean)
        .sort((a, b) => Math.abs(a - now) - Math.abs(b - now));
      const nearestScheduled = candidates[0];
      if (!nearestScheduled) return;

      const delaySeconds = Math.max(-1800, Math.min(3600, Math.round((now - nearestScheduled) / 1000)));

      tripRows.forEach((row) => {
        if (row.stopSequence < nearest.row.stopSequence) return;
        const scheduled = gtfsTimeToDate(row.arrivalTime || row.departureTime, today);
        if (!scheduled) return;
        const estimatedAt = new Date(scheduled.getTime() + delaySeconds * 1000);
        const key = `${vehicle.tripId}|${row.stopId}`;
        estimates.set(key, {
          estimatedAt,
          delaySeconds,
          vehicleId: vehicle.vehicleId,
        });
      });
    });

    state.gpsEstimates = estimates;
  }

  async function pollRealtime() {
    if (!apiKey || stopped) return;

    try {
      await resolveAgency();
      if (!state.routes.length || !state.stops.length) await pollStatic();

      const vehiclesPayload = await request("/vehicles");
      const vehicles = asArray(vehiclesPayload)
        .map((vehicle) => normaliseVehicle(vehicle, state.routeById))
        .filter(Boolean);

      state.vehicles = vehicles;
      buildGpsEstimates(vehicles);
      onVehicles(vehicles);

      const tripUpdatesPayload = await safeRequest("/trip_updates");
      const tripUpdates = extractTripUpdates(tripUpdatesPayload);
      state.officialTripUpdates = new Map();
      tripUpdates.forEach((update) => {
        state.officialTripUpdates.set(`${update.tripId}|${update.stopId}`, update);
      });

      state.lastRealtimeUpdate = new Date().toISOString();
      state.lastError = null;
      logger.log(
        `  Transport public live: ${vehicles.length} vehicule, ${tripUpdates.length} actualizari ETA.`,
      );
    } catch (error) {
      state.lastError = error.message;
      logger.error("  ! Tranzy realtime indisponibil:", error.message);
    }
  }

  function getRoute(routeId) {
    return state.routeById.get(asString(routeId)) || null;
  }

  function getStop(stopId) {
    return state.stopById.get(asString(stopId)) || null;
  }

  function listStops({ search = "", limit = 2000, offset = 0 } = {}) {
    const query = asString(search).trim().toLowerCase();
    const safeLimit = Math.min(Math.max(Number(limit) || 2000, 1), 5000);
    const safeOffset = Math.max(Number(offset) || 0, 0);

    const filtered = state.stops.filter((stop) => {
      if (!query) return true;
      return (
        stop.name.toLowerCase().includes(query)
        || stop.code.toLowerCase().includes(query)
        || stop.routes.some((route) => route.toLowerCase().includes(query))
      );
    });

    return {
      total: filtered.length,
      data: filtered.slice(safeOffset, safeOffset + safeLimit),
    };
  }

  function listRoutes() {
    const vehicleCountByRoute = new Map();
    state.vehicles.forEach((vehicle) => {
      const key = vehicle.routeId || vehicle.routeName;
      vehicleCountByRoute.set(key, (vehicleCountByRoute.get(key) || 0) + 1);
    });

    return state.routes.map((route) => ({
      ...route,
      stopCount: state.routeStops.get(route.routeId)?.length || 0,
      activeVehicles: vehicleCountByRoute.get(route.routeId) || 0,
    })).sort((a, b) => a.shortName.localeCompare(b.shortName, "ro", { numeric: true }));
  }

  function getRouteStops(routeId) {
    const route = getRoute(routeId);
    if (!route) return null;
    const stopIds = state.routeStops.get(route.routeId) || [];
    return {
      route,
      stops: stopIds.map((stopId, index) => ({
        ...state.stopById.get(stopId),
        sequence: index + 1,
      })).filter((stop) => stop.stopId),
    };
  }

  function getArrivals(stopId, requestedLimit = maxArrivals) {
    const stop = getStop(stopId);
    if (!stop) return null;

    const now = new Date();
    const horizon = new Date(now.getTime() + horizonMinutes * 60_000);
    const limit = Math.min(Math.max(Number(requestedLimit) || maxArrivals, 1), 50);
    const stopTimes = state.stopTimesByStop.get(stop.stopId) || [];
    const serviceDates = [
      new Date(now.getFullYear(), now.getMonth(), now.getDate()),
      addDays(new Date(now.getFullYear(), now.getMonth(), now.getDate()), 1),
    ];
    const arrivals = [];

    serviceDates.forEach((serviceDate) => {
      const activeServices = activeServicesForDate(
        serviceDate,
        state.calendars,
        state.calendarDates,
      );

      stopTimes.forEach((stopTime) => {
        const trip = state.tripById.get(stopTime.tripId);
        if (!trip) return;
        if (activeServices && trip.serviceId && !activeServices.has(trip.serviceId)) return;

        const scheduledAt = gtfsTimeToDate(
          stopTime.arrivalTime || stopTime.departureTime,
          serviceDate,
        );
        if (!scheduledAt) return;

        const key = `${trip.tripId}|${stop.stopId}`;
        const official = state.officialTripUpdates.get(key);
        const gps = state.gpsEstimates.get(key);
        let estimatedAt = scheduledAt;
        let source = "scheduled";
        let delaySeconds = 0;
        let vehicleId = null;

        if (official?.estimatedAt) {
          estimatedAt = official.estimatedAt;
          delaySeconds = Math.round((estimatedAt - scheduledAt) / 1000);
          source = "realtime";
        } else if (Number.isFinite(official?.delaySeconds)) {
          delaySeconds = official.delaySeconds;
          estimatedAt = new Date(scheduledAt.getTime() + delaySeconds * 1000);
          source = "realtime";
        } else if (gps?.estimatedAt) {
          estimatedAt = gps.estimatedAt;
          delaySeconds = gps.delaySeconds || 0;
          vehicleId = gps.vehicleId || null;
          source = "gps";
        }

        if (estimatedAt < new Date(now.getTime() - 60_000) || estimatedAt > horizon) return;

        const route = state.routeById.get(trip.routeId);
        arrivals.push({
          stopId: stop.stopId,
          tripId: trip.tripId,
          vehicleId,
          routeId: trip.routeId,
          route: route?.shortName || trip.routeId,
          routeLongName: route?.longName || "",
          vehicleType: route?.type || "bus",
          destination: trip.headsign || route?.longName || "Destinatie nespecificata",
          directionId: trip.directionId,
          scheduledArrival: scheduledAt.toISOString(),
          estimatedArrival: estimatedAt.toISOString(),
          waitMinutes: Math.max(0, Math.ceil((estimatedAt - now) / 60_000)),
          delaySeconds,
          source,
          realtime: source === "realtime",
          gpsEstimated: source === "gps",
        });
      });
    });

    const unique = new Map();
    arrivals
      .sort((a, b) => new Date(a.estimatedArrival) - new Date(b.estimatedArrival))
      .forEach((arrival) => {
        const key = `${arrival.tripId}|${arrival.stopId}|${arrival.estimatedArrival}`;
        if (!unique.has(key)) unique.set(key, arrival);
      });

    return {
      stop,
      updatedAt: state.lastRealtimeUpdate || state.lastStaticUpdate,
      horizonMinutes,
      arrivals: [...unique.values()].slice(0, limit),
    };
  }

  function getStatus() {
    return {
      enabled: state.enabled,
      agencyId: state.agencyId,
      agencyName: state.agencyName,
      counts: {
        routes: state.routes.length,
        stops: state.stops.length,
        trips: state.trips.length,
        stopTimes: state.stopTimes.length,
        vehicles: state.vehicles.length,
        officialEtaUpdates: state.officialTripUpdates.size,
        gpsEstimates: state.gpsEstimates.size,
      },
      lastStaticUpdate: state.lastStaticUpdate,
      staticFromCache: state.staticFromCache,
      lastRealtimeUpdate: state.lastRealtimeUpdate,
      lastError: state.lastError,
      endpointErrors: state.endpointErrors,
      etaMode: state.officialTripUpdates.size
        ? "realtime"
        : state.gpsEstimates.size
          ? "gps"
          : state.stopTimes.length
            ? "scheduled"
            : "unavailable",
    };
  }

  async function start() {
    if (!apiKey) {
      logger.log("  Transport public: seteaza TRANZY_API_KEY in .env pentru date CTP.");
      return;
    }

    stopped = false;
    // Pre-încărcăm rețeaua din cache-ul local, ca stațiile/liniile să fie disponibile
    // imediat chiar dacă Tranzy e picat la pornire (502/500).
    loadStaticCache();
    await pollStatic();
    await pollRealtime();

    realtimeTimer = setInterval(pollRealtime, realtimePollMs);
    staticTimer = setInterval(pollStatic, staticPollMs);
  }

  function stop() {
    stopped = true;
    if (realtimeTimer) clearInterval(realtimeTimer);
    if (staticTimer) clearInterval(staticTimer);
    realtimeTimer = null;
    staticTimer = null;
  }

  return {
    start,
    stop,
    pollStatic,
    pollRealtime,
    getStatus,
    listStops,
    getStop,
    getArrivals,
    listRoutes,
    getRouteStops,
  };
}
