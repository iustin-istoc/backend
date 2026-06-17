# Fisier: backend/aqi_bridge.py
# Pod WAQI -> backend. Descopera AUTOMAT toate statiile de calitate a aerului
# din zona Cluj-Napoca (aqicn.org / WAQI) si le trimite periodic la backend,
# care le creeaza si le actualizeaza in modulul "environment".
import os
import time
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv


ENV_FILE = Path(__file__).with_name(".env")
load_dotenv(ENV_FILE)

WAQI_API_TOKEN = os.getenv("WAQI_API_TOKEN", "").strip()
BACKEND_URL = os.getenv(
    "BACKEND_URL",
    "http://localhost:4000",
).rstrip("/")
POLL_SECONDS = int(os.getenv("WAQI_POLL_SECONDS", "180"))

# Cadru geografic (bounding box) pentru Cluj-Napoca si imprejurimi:
#   lat_sud, lng_vest, lat_nord, lng_est
CLUJ_BOUNDS = os.getenv(
    "WAQI_BOUNDS",
    "46.68,23.46,46.86,23.74",
).strip()

# Pe retele cu inspectie SSL (facultate/firma) verificarea certificatului poate
# pica. Pune WAQI_VERIFY_SSL=0 in .env ca sa o dezactivezi (doar pentru demo).
VERIFY_SSL = os.getenv("WAQI_VERIFY_SSL", "1").strip() != "0"
RETRIES = int(os.getenv("WAQI_RETRIES", "3"))

SESSION = requests.Session()
SESSION.verify = VERIFY_SSL
SESSION.headers.update(
    {
        "Accept": "application/json",
        "User-Agent": "Iustin-Licenta-WAQI-Bridge/2.0",
    }
)

if not VERIFY_SSL:
    try:
        import urllib3

        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    except Exception:
        pass


def get_json(url: str, params: dict[str, Any]) -> dict[str, Any] | None:
    # GET cu reincercari; afiseaza cauza REALA a erorii (DNS / SSL / refuz).
    last_error: Exception | None = None

    for attempt in range(1, RETRIES + 1):
        try:
            response = SESSION.get(url, params=params, timeout=20)
            response.raise_for_status()
            return response.json()
        except requests.exceptions.SSLError as error:
            print(
                f"[NET] Eroare SSL: {error}. "
                f"Daca esti pe retea cu inspectie SSL, pune WAQI_VERIFY_SSL=0 in .env."
            )
            return None
        except (requests.RequestException, ValueError) as error:
            last_error = error
            print(f"[NET] Incercarea {attempt}/{RETRIES} pentru {url} a esuat: {error!r}")
            time.sleep(2 * attempt)

    if last_error is not None:
        print(f"[NET] Renunt dupa {RETRIES} incercari: {last_error!r}")
    return None


def as_number(value: Any) -> float | None:
    # Converteste o valoare la numar sau None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None

    if number != number:  # NaN
        return None

    return number


def iaqi_value(iaqi: dict[str, Any], key: str) -> float | None:
    # Extrage indicele individual din obiectul iaqi
    item = iaqi.get(key)

    if isinstance(item, dict):
        return as_number(item.get("v"))

    return as_number(item)


def clean_attributions(value: Any) -> list[dict[str, str]]:
    # Pastreaza doar numele si adresa sursei
    if not isinstance(value, list):
        return []

    result = []

    for item in value:
        if not isinstance(item, dict):
            continue

        name = str(item.get("name") or "").strip()
        url = str(item.get("url") or "").strip()

        if name:
            result.append({"name": name, "url": url})

    return result


def discover_stations() -> list[dict[str, Any]]:
    # Descopera toate statiile WAQI din cadrul geografic Cluj.
    endpoint = "https://api.waqi.info/map/bounds/"

    result = get_json(endpoint, {"token": WAQI_API_TOKEN, "latlng": CLUJ_BOUNDS})
    if result is None:
        return []

    if result.get("status") != "ok":
        print(f"[WAQI] Descoperirea nu a returnat date (status={result.get('status')}).")
        return []

    stations: list[dict[str, Any]] = []
    seen: set[Any] = set()

    for item in result.get("data", []):
        if not isinstance(item, dict):
            continue

        uid = item.get("uid")
        if uid is None or uid in seen:
            continue
        seen.add(uid)

        station = item.get("station") or {}
        name = str(station.get("name") or f"Statie {uid}")

        stations.append({"uid": uid, "fallback_name": name})

    print(f"[WAQI] Statii descoperite in zona Cluj: {len(stations)}")
    return stations


def fetch_station(station: dict[str, Any]) -> dict[str, Any] | None:
    # Citeste valorile curente complete ale unei statii WAQI dupa uid.
    uid = station["uid"]
    endpoint = f"https://api.waqi.info/feed/@{uid}/"

    result = get_json(endpoint, {"token": WAQI_API_TOKEN})
    if result is None:
        return None

    if result.get("status") != "ok":
        return None

    data = result.get("data", {})
    city = data.get("city", {})
    iaqi = data.get("iaqi", {})
    time_data = data.get("time", {})
    geo = city.get("geo", [])

    aqi = as_number(data.get("aqi"))
    if aqi is None:
        return None  # statie fara AQI numeric (ex. "-")

    if not isinstance(geo, list) or len(geo) < 2:
        return None

    latitude = as_number(geo[0])
    longitude = as_number(geo[1])
    if latitude is None or longitude is None:
        return None

    observed_at = (
        time_data.get("iso")
        or time_data.get("s")
        or time_data.get("v")
        or ""
    )

    return {
        "id": f"ENV-{uid}",
        "stationId": str(uid),
        "name": str(city.get("name") or station["fallback_name"]),
        "lat": latitude,
        "lng": longitude,
        "aqi": aqi,
        "pm25": iaqi_value(iaqi, "pm25"),
        "pm10": iaqi_value(iaqi, "pm10"),
        "no2": iaqi_value(iaqi, "no2"),
        "o3": iaqi_value(iaqi, "o3"),
        "co": iaqi_value(iaqi, "co"),
        "so2": iaqi_value(iaqi, "so2"),
        "temp": iaqi_value(iaqi, "t"),
        "humidity": iaqi_value(iaqi, "h"),
        "pressure": iaqi_value(iaqi, "p"),
        "wind": iaqi_value(iaqi, "w"),
        "dominantPollutant": data.get("dominentpol"),
        "observedAt": str(observed_at),
        "cityUrl": str(city.get("url") or ""),
        "attributions": clean_attributions(data.get("attributions")),
    }


def send_updates(updates: list[dict[str, Any]]) -> bool:
    # Trimite toate statiile catre backend
    if not updates:
        print("[WAQI] Nu exista actualizari valide.")
        return False

    endpoint = f"{BACKEND_URL}/api/ingest/env"

    try:
        response = SESSION.post(endpoint, json=updates, timeout=20)
        response.raise_for_status()
        result = response.json()
    except (requests.RequestException, ValueError) as error:
        print(f"[BACKEND] Trimiterea a esuat: {type(error).__name__}")
        return False

    print(f"[BACKEND] Actualizari aplicate: {result.get('applied', 0)}")
    return True


def run_cycle() -> None:
    # Descopera statiile, citeste valorile complete si le trimite la backend.
    stations = discover_stations()
    updates = []

    for station in stations:
        payload = fetch_station(station)

        if payload is not None:
            updates.append(payload)
            print(
                f"[WAQI] {payload['id']} | "
                f"{payload['name']} | "
                f"AQI={payload['aqi']}"
            )

        time.sleep(0.5)

    send_updates(updates)


def main() -> None:
    # Porneste actualizarea periodica
    if not WAQI_API_TOKEN:
        raise RuntimeError("Lipseste WAQI_API_TOKEN din backend/.env.")

    if POLL_SECONDS < 60:
        raise RuntimeError("WAQI_POLL_SECONDS trebuie sa fie minimum 60.")

    print("[WAQI] Bridge pornit (descoperire automata Cluj).")
    print(f"[WAQI] Backend: {BACKEND_URL}")
    print(f"[WAQI] Zona: {CLUJ_BOUNDS}")
    print(f"[WAQI] Interval: {POLL_SECONDS} secunde")

    try:
        while True:
            run_cycle()
            print(f"[WAQI] Urmatoarea actualizare peste {POLL_SECONDS} secunde.")
            time.sleep(POLL_SECONDS)
    except KeyboardInterrupt:
        print("\n[WAQI] Bridge oprit.")


if __name__ == "__main__":
    main()
