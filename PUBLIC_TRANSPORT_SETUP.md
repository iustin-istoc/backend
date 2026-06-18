# Modul Transport Public - CTP Cluj / Tranzy

## 1. Configurare

Adauga in `backend/.env`:

```env
# Tranzy OpenData - configurare locala
TRANZY_API_KEY=cheia_ta_tranzy
TRANZY_AGENCY_ID=
TRANZY_BASE=https://api.tranzy.ai/v1/opendata
TRANSIT_POLL_MS=20000
TRANSIT_STATIC_POLL_MS=21600000
TRANSIT_ARRIVAL_HORIZON_MIN=180
```

`TRANZY_AGENCY_ID` poate ramane gol. Backend-ul cauta automat agentia care contine `Cluj`.

## 2. Pornire

```cmd
:: Porneste backend-ul
cd C:\Users\iusti\Desktop\smartcity\backend
npm install
npm run dev
```

```cmd
:: Porneste frontend-ul
cd C:\Users\iusti\Desktop\smartcity\frontend
npm install
npm run dev
```

## 3. Endpoint-uri locale

- `GET /api/transit/status`
- `GET /api/transit/stops`
- `GET /api/transit/stops/:stopId`
- `GET /api/transit/stops/:stopId/arrivals`
- `GET /api/transit/routes`
- `GET /api/transit/routes/:routeId/stops`

## 4. Moduri ETA

- `realtime`: actualizare ETA primita din feed-ul Tranzy.
- `gps`: estimare calculata din pozitia vehiculului si orarul GTFS.
- `scheduled`: ora programata GTFS.

Interfata afiseaza explicit sursa fiecarei estimari si nu prezinta o ora programata ca fiind live.

## 5. Diagnostic

Deschide:

```text
http://localhost:4000/api/transit/status
```

Campul `endpointErrors` arata endpoint-urile pe care contul Tranzy nu le ofera. Modulul continua sa functioneze cu datele disponibile.
