# TomTom Traffic - configurare

Integrarea adaugă date reale TomTom Traffic Flow și Traffic Incidents fără să înlocuiască SUMO.

## 1. Cheia API

Creează o cheie în TomTom Developer Portal și păstreaz-o numai în `backend/.env`.

Adaugă:

```env
# TomTom Traffic Flow + Incidents
TOMTOM_API_KEY=cheia_ta_tomtom
TOMTOM_BASE=https://api.tomtom.com
TOMTOM_SEGMENT_POLL_MS=600000
TOMTOM_INCIDENT_POLL_MS=120000
TOMTOM_BBOX=23.4500,46.7000,23.7500,46.8600
TOMTOM_FLOW_ZOOM=16
TOMTOM_MAX_NON_TILE_REQUESTS=2400
```

Nu pune cheia în frontend și nu o publica în GitHub.

## 2. Pornire

```cmd
cd C:\Users\iusti\Desktop\smartcity\backend
npm install
npm test
npm run dev
```

În alt terminal:

```cmd
cd C:\Users\iusti\Desktop\smartcity\frontend
npm install
npm run build
npm run dev
```

## 3. Verificare backend

- `http://localhost:4000/api/traffic/status`
- `http://localhost:4000/api/traffic/segments`
- `http://localhost:4000/api/traffic/incidents`

Pentru un punct ales manual:

- `http://localhost:4000/api/traffic/segment?lat=46.7740&lng=23.5980&zoom=16`

## 4. Structura modulului

- **Prezentare trafic**: KPI, harta TomTom, incidente si contoare SUMO.
- **Flux live**: flow tiles actualizate automat la un minut si date numerice la click.
- **Coridoare monitorizate**: 10 puncte importante, viteza, free-flow, congestie si istoric de sesiune.
- **Incidente**: accidente, ambuteiaje, inchideri, lucrari si intarzieri.
- **Simulare SUMO**: contoarele si valorile generate sau primite prin `sumo_bridge.py`.
- **Comparatie**: TomTom real versus SUMO pentru cele patru contoare asociate.

## 5. Controlul consumului API

Configuratia implicita foloseste aproximativ:

- 10 segmente la 10 minute;
- o cerere de incidente la 2 minute;
- maximum 2400 de cereri non-tile pe zi, ca limita de siguranta;
- cache de 55 secunde pentru flow tiles;
- cache de 60 secunde pentru interogarile repetate la click.

Flow tiles sunt transmise prin backend, astfel incat cheia nu apare in codul React.

## 6. Fallback

Fara cheie TomTom:

- backend-ul si frontend-ul pornesc normal;
- SUMO continua sa functioneze;
- modulul afiseaza mesajul de configurare;
- nu sunt generate date TomTom false.
