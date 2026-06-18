// ---------------------------------------------------------------------------
//  db.js  —  istoric persistent cu PostgreSQL + PostGIS
//  - tabela `devices`  : id, modul, nume, locație (PostGIS geometry Point 4326)
//  - tabela `readings` : istoricul stărilor (metrics ca JSONB, ts cu timestamp)
//  Conexiunea se citește din backend/.env (vezi .env.example).
// ---------------------------------------------------------------------------
import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD,        // pune-o în backend/.env
  database: process.env.PGDATABASE || "smartcity",
});

// creează extensia, tabelele și sincronizează dispozitivele (o dată, la pornire)
export async function initDb(devices) {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS postgis;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS devices (
      id     TEXT PRIMARY KEY,
      module TEXT NOT NULL,
      name   TEXT NOT NULL,
      geom   geometry(Point, 4326)
    );`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS readings (
      id        BIGSERIAL PRIMARY KEY,
      device_id TEXT        NOT NULL REFERENCES devices(id),
      ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
      status    TEXT,
      metrics   JSONB       NOT NULL
    );`);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_readings_dev_ts ON readings(device_id, ts DESC);`
  );

  // upsert dispozitive cu locația lor ca punct PostGIS (lng, lat)
  for (const d of devices) {
    await pool.query(
      `INSERT INTO devices (id, module, name, geom)
       VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326))
       ON CONFLICT (id) DO UPDATE
         SET module = EXCLUDED.module, name = EXCLUDED.name, geom = EXCLUDED.geom`,
      [d.id, d.module, d.name, d.lng, d.lat]
    );
  }
  console.log(`  PostgreSQL + PostGIS pregătit. Dispozitive sincronizate: ${devices.length}`);
}

// salvează starea curentă a tuturor dispozitivelor într-un singur INSERT (eficient)
export async function saveReadings(devices) {
  if (!devices.length) return;

  // 1) Auto-înregistrare: ne asigurăm că fiecare dispozitiv există în tabela
  //    `devices` ÎNAINTE de a-i scrie citirile. Fără acest pas, un dispozitiv
  //    adăugat după pornire (ex. o cameră nouă) ar lipsi din tabelă, iar
  //    constrângerea FK ar respinge ÎNTREGUL batch de citiri (eroarea
  //    readings_device_id_fkey).
  const devRows = [];
  const devParams = [];
  devices.forEach((d, i) => {
    const a = i * 5;
    const lng = Number.isFinite(Number(d.lng)) ? Number(d.lng) : null;
    const lat = Number.isFinite(Number(d.lat)) ? Number(d.lat) : null;
    devRows.push(
      `($${a + 1}, $${a + 2}, $${a + 3}, ST_SetSRID(ST_MakePoint($${a + 4}, $${a + 5}), 4326))`
    );
    devParams.push(d.id, d.module, d.name, lng, lat);
  });
  await pool.query(
    `INSERT INTO devices (id, module, name, geom) VALUES ${devRows.join(",")}
     ON CONFLICT (id) DO UPDATE
       SET module = EXCLUDED.module, name = EXCLUDED.name, geom = EXCLUDED.geom`,
    devParams
  );

  // 2) Inserăm citirile (acum toate device_id-urile există în `devices`).
  const rows = [];
  const params = [];
  devices.forEach((d, i) => {
    const a = i * 3;
    rows.push(`($${a + 1}, $${a + 2}, $${a + 3}::jsonb)`);
    params.push(d.id, d.status, JSON.stringify(d.metrics));
  });
  await pool.query(
    `INSERT INTO readings (device_id, status, metrics) VALUES ${rows.join(",")}`,
    params
  );
}

// ultimele `limit` citiri ale unui dispozitiv (cele mai vechi întâi)
export async function getHistory(deviceId, limit = 200) {
  const { rows } = await pool.query(
    `SELECT ts, status, metrics FROM readings
     WHERE device_id = $1 ORDER BY ts DESC LIMIT $2`,
    [deviceId, limit]
  );
  return rows.reverse().map((r) => ({
    ts: r.ts,
    t: new Date(r.ts).toLocaleTimeString("ro-RO"),
    status: r.status,
    ...r.metrics, // JSONB revine deja ca obiect
  }));
}

// statistici pentru verificare
export async function dbStats() {
  const total = await pool.query(`SELECT COUNT(*)::int AS n FROM readings`);
  const per = await pool.query(
    `SELECT device_id, COUNT(*)::int AS n, MIN(ts) AS first, MAX(ts) AS last
     FROM readings GROUP BY device_id ORDER BY device_id`
  );
  return { totalRows: total.rows[0].n, perDevice: per.rows };
}
