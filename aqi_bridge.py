# Fisier: backend/aqi_bridge.py
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

STATIONS = [
    {
        "id": "ENV-01",
        "station_id": "472192",
        "fallback_name": "Cluj Napoca 2",
    },
    {
        "id": "ENV-02",
        "station_id": "471601",
        "fallback_name": "Cluj Napoca",
    },
    {
        "id": "ENV-03",
        "station_id": "972211",
        "fallback_name": "DN1C",
    },
]

SESSION = requests.Session()
SESSION.headers.update(
    {
        "Accept": "application/json",
        "User-Agent": "Iustin-Licenta-WAQI-Bridge/1.0",
    }
)


def as_number(value: Any) -> float | None:
    # Converteste o valoare la numar sau None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None

    if number != number:
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
            result.append(
                {
                    "name": name,
                    "url": url,
                }
            )

    return result


def fetch_station(
    station: dict[str, str],
) -> dict[str, Any] | None:
    # Citeste valorile curente ale unei statii WAQI
    station_id = station["station_id"]
    endpoint = (
        f"https://api.waqi.info/feed/A{station_id}/"
    )

    try:
        response = SESSION.get(
            endpoint,
            params={"token": WAQI_API_TOKEN},
            timeout=20,
        )
        response.raise_for_status()
    except requests.RequestException as error:
        print(
            f"[WAQI] Eroare pentru statia {station_id}: "
            f"{type(error).__name__}"
        )
        return None

    try:
        result = response.json()
    except ValueError:
        print(
            f"[WAQI] JSON invalid pentru statia {station_id}."
        )
        return None

    if result.get("status") != "ok":
        print(
            f"[WAQI] Statia {station_id} nu a returnat date."
        )
        return None

    data = result.get("data", {})
    city = data.get("city", {})
    iaqi = data.get("iaqi", {})
    time_data = data.get("time", {})
    geo = city.get("geo", [])

    aqi = as_number(data.get("aqi"))

    if aqi is None:
        print(
            f"[WAQI] Statia {station_id} nu are AQI numeric."
        )
        return None

    if not isinstance(geo, list) or len(geo) < 2:
        print(
            f"[WAQI] Statia {station_id} nu are coordonate."
        )
        return None

    latitude = as_number(geo[0])
    longitude = as_number(geo[1])

    if latitude is None or longitude is None:
        print(
            f"[WAQI] Coordonate invalide pentru {station_id}."
        )
        return None

    observed_at = (
        time_data.get("iso")
        or time_data.get("s")
        or time_data.get("v")
        or ""
    )

    return {
        "id": station["id"],
        "stationId": station_id,
        "name": str(
            city.get("name")
            or station["fallback_name"]
        ),
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
        "attributions": clean_attributions(
            data.get("attributions")
        ),
    }


def send_updates(
    updates: list[dict[str, Any]],
) -> bool:
    # Trimite toate statiile catre backend
    if not updates:
        print("[WAQI] Nu exista actualizari valide.")
        return False

    endpoint = f"{BACKEND_URL}/api/ingest/env"

    try:
        response = SESSION.post(
            endpoint,
            json=updates,
            timeout=20,
        )
        response.raise_for_status()
    except requests.RequestException as error:
        print(
            f"[BACKEND] Trimiterea a esuat: "
            f"{type(error).__name__}"
        )
        return False

    result = response.json()

    print(
        f"[BACKEND] Actualizari aplicate: "
        f"{result.get('applied', 0)}"
    )

    return True


def run_cycle() -> None:
    # Citeste toate statiile configurate
    updates = []

    for station in STATIONS:
        payload = fetch_station(station)

        if payload is not None:
            updates.append(payload)

            print(
                f"[WAQI] {payload['id']} | "
                f"{payload['name']} | "
                f"AQI={payload['aqi']}"
            )

        time.sleep(1)

    send_updates(updates)


def main() -> None:
    # Porneste actualizarea periodica
    if not WAQI_API_TOKEN:
        raise RuntimeError(
            "Lipseste WAQI_API_TOKEN din backend/.env."
        )

    if POLL_SECONDS < 60:
        raise RuntimeError(
            "WAQI_POLL_SECONDS trebuie sa fie minimum 60."
        )

    print("[WAQI] Bridge pornit.")
    print(f"[WAQI] Backend: {BACKEND_URL}")
    print(f"[WAQI] Interval: {POLL_SECONDS} secunde")

    try:
        while True:
            run_cycle()

            print(
                f"[WAQI] Urmatoarea actualizare peste "
                f"{POLL_SECONDS} secunde."
            )

            time.sleep(POLL_SECONDS)
    except KeyboardInterrupt:
        print("\n[WAQI] Bridge oprit.")


if __name__ == "__main__":
    # Ruleaza programul direct
    main()