// Teste unitare pentru normalizarea datelor TomTom si cache-ul intern.
import test from "node:test";
import assert from "node:assert/strict";
import { createTomTomTrafficService } from "../tomtomTrafficService.js";

test("normalizeaza flow, incidente si tile-uri", async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (input) => {
    const url = String(input);
    calls.push(url);

    if (url.includes("flowSegmentData")) {
      return new Response(JSON.stringify({
        flowSegmentData: {
          frc: "FRC2",
          currentSpeed: 20,
          freeFlowSpeed: 50,
          currentTravelTime: 180,
          freeFlowTravelTime: 90,
          confidence: 0.9,
          roadClosure: false,
          coordinates: {
            coordinate: [
              { latitude: 46.77, longitude: 23.58 },
              { latitude: 46.771, longitude: 23.581 },
            ],
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (url.includes("incidentDetails")) {
      return new Response(JSON.stringify({
        incidents: [{
          type: "Feature",
          geometry: { type: "Point", coordinates: [23.59, 46.77] },
          properties: {
            id: "INC-1",
            iconCategory: 6,
            magnitudeOfDelay: 2,
            events: [{ description: "Trafic intens" }],
            delay: 120,
            length: 500,
          },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (url.includes("/tile/flow/")) {
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }

    return new Response("not found", { status: 404 });
  };

  try {
    const service = createTomTomTrafficService({
      apiKey: "test-key",
      monitoredRoads: [{
        id: "TT-X",
        name: "Test Road",
        lat: 46.77,
        lng: 23.58,
        simulatedDeviceId: "CNT-01",
      }],
      maxNonTileRequestsPerDay: 100,
    });

    await service.pollSegments();
    await service.pollIncidents();

    const segment = service.getSegment("TT-X");
    assert.equal(segment.currentSpeed, 20);
    assert.equal(segment.freeFlowSpeed, 50);
    assert.equal(segment.congestionPercent, 60);
    assert.equal(segment.delaySeconds, 90);
    assert.equal(segment.status, "error");
    assert.equal(segment.coordinateSource, "tomtom_geometry");
    assert.deepEqual(segment.queryPoint, { lat: 46.77, lng: 23.58 });
    assert.deepEqual(segment.samplePoint, { lat: 46.77, lng: 23.58 });
    assert.equal(segment.history.length, 1);

    const incidents = service.getIncidents();
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].category, "Ambuteiaj");
    assert.equal(incidents[0].delaySeconds, 120);

    const firstTile = await service.getFlowTile({ z: 13, x: 4629, y: 2902 });
    const secondTile = await service.getFlowTile({ z: 13, x: 4629, y: 2902 });
    assert.equal(firstTile.cache, "miss");
    assert.equal(secondTile.cache, "hit");

    const tileCalls = calls.filter((url) => url.includes("/tile/flow/"));
    assert.equal(tileCalls.length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("ramane dezactivat fara cheie API", () => {
  const service = createTomTomTrafficService({ apiKey: "" });
  const status = service.getStatus();
  assert.equal(status.enabled, false);
  assert.equal(service.getSegments().length > 0, true);
});
