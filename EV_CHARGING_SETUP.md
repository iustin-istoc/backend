# Modulul EV Charging - Open Charge Map

## 1. Cheia API

Creeaza un cont Open Charge Map, deschide My Profile > My Apps si inregistreaza o aplicatie. Copiaza cheia in `backend/.env`:

```env
# Cheia ramane numai in backend
OPENCHARGEMAP_API_KEY=cheia_ta
OCM_POLL_MS=900000
OCM_MAX_RESULTS=500
OCM_BOUNDING_BOX=(46.7000,23.4500),(46.8600,23.7500)
```

## 2. Pornire

```powershell
# Porneste backend-ul
npm install
npm run dev
```

Nu este necesar un bridge Python pentru Open Charge Map. Backend-ul interogheaza API-ul direct la pornire si apoi la fiecare 15 minute.

## 3. Verificare

Deschide `http://localhost:4000/api/devices` si cauta dispozitive cu:

```json
{
  "id": "EV-...",
  "module": "charging",
  "source": "external",
  "provider": "Open Charge Map"
}
```

Frontend-ul afiseaza modulul `EV CHARGING`, iar Overview include automat toate locatiile EV pe harta.

## Nota metodologica

Open Charge Map furnizeaza inventarul statiilor, conectorii, puterea si starea operationala declarata. Aceste date nu reprezinta ocuparea live a fiecarui loc de incarcare. Furnizorul si licenta fiecarei inregistrari sunt afisate in interfata.
