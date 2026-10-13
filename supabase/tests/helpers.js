// Test harness: runs the real migrations against a local Postgres with a
// small Supabase stand-in (supabase_stub.sql), then calls the API exactly as
// the app would — as a signed-in member, a third account, or signed out.
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const here = import.meta.dirname;
const CONN = {
  host: process.env.PGHOST || '/tmp/pgtest',
  port: Number(process.env.PGPORT || 55432),
  user: process.env.PGUSER || 'postgres',
};
const sqlFiles = [
  path.join(here, 'supabase_stub.sql'),
  ...fs.readdirSync(path.join(here, '..', 'migrations')).sort()
    .map((f) => path.join(here, '..', 'migrations', f)),
];

let templateBuilt = false;
async function buildTemplate() {
  const admin = new pg.Client({ ...CONN, database: 'postgres' });
  await admin.connect();
  await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = 'duo_tpl' and pid <> pg_backend_pid()");
  await admin.query('drop database if exists duo_tpl');
  await admin.query('create database duo_tpl');
  await admin.end();
  const t = new pg.Client({ ...CONN, database: 'duo_tpl' });
  await t.connect();
  for (const f of sqlFiles) await t.query(fs.readFileSync(f, 'utf8'));
  await t.end();
  templateBuilt = true;
}

export async function freshDb() {
  if (!templateBuilt) await buildTemplate();
  const name = 'duo_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const admin = new pg.Client({ ...CONN, database: 'postgres' });
  await admin.connect();
  await admin.query(`create database ${name} template duo_tpl`);
  await admin.end();
  return new Db(name);
}

export const ANON = { anon: true };
export const SERVICE = { service: true };

class Db {
  constructor(name) {
    this.name = name;
    this.pool = new pg.Pool({ ...CONN, database: name, max: 6 });
    // Idle connections are force-closed when the test database is dropped;
    // ignore that so it isn't misreported as a failure in the next test.
    this.pool.on('error', () => {});
  }

  // Superuser query (test setup / inspection only).
  async sql(text, params = []) {
    return (await this.pool.query(text, params)).rows;
  }

  async setClock(iso) {
    await this.sql(
      `insert into app_private.test_clock (singleton, fixed_now) values (true, $1)
       on conflict (singleton) do update set fixed_now = excluded.fixed_now`, [iso]);
  }

  async createUser(email, { confirmed = true } = {}) {
    const id = randomUUID();
    await this.sql('insert into auth.users (id, email, email_confirmed_at) values ($1, $2, $3)',
      [id, email, confirmed ? new Date().toISOString() : null]);
    return { id, email };
  }

  // Run `fn(client)` inside a transaction with the caller's role and JWT claims,
  // the way PostgREST runs every API request.
  async as(who, fn, client = null) {
    const c = client || (await this.pool.connect());
    try {
      await c.query('begin');
      if (who.anon) {
        await c.query('set local role anon');
        await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: 'anon' })]);
      } else if (who.service) {
        await c.query('set local role service_role');
        await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: 'service_role' })]);
      } else {
        await c.query('set local role authenticated');
        await c.query("select set_config('request.jwt.claims', $1, true)",
          [JSON.stringify({ sub: who.id, role: 'authenticated', email: who.email })]);
      }
      const out = await fn(c);
      await c.query('commit');
      return out;
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw e;
    } finally {
      if (!client) c.release();
    }
  }

  // Call an API function as `who`. Objects are sent as jsonb.
  async rpc(who, name, ...args) {
    const params = args.map((a) => (a !== null && typeof a === 'object' && !(a instanceof Date) ? JSON.stringify(a) : a));
    const placeholders = params.map((_, i) => `$${i + 1}`).join(', ');
    return this.as(who, async (c) => (await c.query(`select public.${name}(${placeholders}) as r`, params)).rows[0].r);
  }

  // Read a table through RLS as `who`.
  async read(who, text, params = []) {
    return this.as(who, async (c) => (await c.query(text, params)).rows);
  }

  // Simulate a photo upload through the storage policies.
  async upload(who, objectPath, etag = randomUUID()) {
    return this.as(who, (c) => c.query(
      `insert into storage.objects (bucket_id, name, owner, metadata) values ('media', $1, $2, $3)`,
      [objectPath, who.id, JSON.stringify({ eTag: `"${etag}"`, mimetype: 'image/jpeg' })]));
  }

  async close() {
    await this.pool.end();
    const admin = new pg.Client({ ...CONN, database: 'postgres' });
    await admin.connect();
    await admin.query(`drop database if exists ${this.name} with (force)`);
    await admin.end();
  }
}

export const uuid = randomUUID;

// Default world: Thursday Oct 8 2026, competition starts Monday Oct 12 2026
// (America/New_York). Both members join, keep default targets
// (strength 3, cardio 2, water 2000 ml, cardio >= 20 min) and agree.
export const SETUP_CLOCK = '2026-10-08T12:00:00-04:00';

export async function setupDuo(db, { targetsA, targetsB, benchmarksA, benchmarksB, activate = true } = {}) {
  await db.setClock(SETUP_CLOCK);
  const A = await db.createUser('pedro@example.com');
  const B = await db.createUser('thomas@example.com');
  const [{ id: comp }] = await db.sql(
    "select app_private.admin_create_competition('Pedro@Example.com', 'thomas@example.com') as id");
  await db.rpc(A, 'join_competition');
  await db.rpc(B, 'join_competition');
  if (targetsA) await db.rpc(A, 'set_my_setup_targets', targetsA);
  if (targetsB) await db.rpc(B, 'set_my_setup_targets', targetsB);
  if (benchmarksA) await db.rpc(A, 'set_my_setup_benchmarks', benchmarksA);
  if (benchmarksB) await db.rpc(B, 'set_my_setup_benchmarks', benchmarksB);
  if (activate) {
    await db.rpc(A, 'agree_to_setup');
    await db.rpc(B, 'agree_to_setup');
  }
  return { A, B, comp };
}

// Convenience loggers (as the app would call them).
export const workout = (db, who, at, sets = [{ exercise: 'Bench press', equipment: 'Barbell', sets: 3, reps: 5, weight: 135, weight_unit: 'lb' }], extra = {}) =>
  db.rpc(who, 'save_workout', { client_key: uuid(), title: 'Session', activity_at: at, status: 'completed', sets, ...extra });

export const cardio = (db, who, at, extra = {}) =>
  db.rpc(who, 'save_cardio', { client_key: uuid(), activity: 'Run', duration_s: 1800, activity_at: at, ...extra });

export async function meal(db, who, at, { checklist = { protein: true, produce_or_fiber: true }, etag, path: p } = {}) {
  const photo = p || `${who.id}/meals/${uuid()}.jpg`;
  if (!p) await db.upload(who, photo, etag);
  return db.rpc(who, 'save_meal', { client_key: uuid(), description: 'Lunch', photo_path: photo, checklist, activity_at: at });
}

export const water = (db, who, day, amount = 2000, unit = 'ml') => db.rpc(who, 'save_hydration', day, amount, unit);

export async function weekScore(db, who, week = '2026-10-12') {
  const rows = await db.sql('select * from public.weekly_scores where user_id = $1 and week_start = $2', [who.id, week]);
  return rows[0];
}

export const num = (v) => Number(v);
