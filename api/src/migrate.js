// migrate.js
// Idempotent database migration runner for Polaris.
// - Reads connection info ONLY from the DATABASE_URL environment variable.
// - Never hardcode credentials in this file.
// - Applies each .sql file in ./migrations in filename order, exactly once,
// tracked via the migrations table (created by 001_init.sql itself).
// - Additive only: migration files must not contain DROP or other
// destructive statements.

import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import pg from 'pg';

const { Client } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function run() {
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
console.error('DATABASE_URL is not set. Aborting migration run.');
process.exitCode = 1;
return;
}

const client = new Client({
connectionString,
ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});

await client.connect();

try {
await client.query('CREATE TABLE IF NOT EXISTS migrations (id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, applied_at TIMESTAMPTZ DEFAULT now());');

const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

for (const file of files) {
const { rows } = await client.query('SELECT 1 FROM migrations WHERE name = $1', [file]);

if (rows.length > 0) {
console.log(`Skipping already-applied migration: ${file}`);
continue;
}

console.log(`Applying migration: ${file}`);
const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

await client.query('BEGIN');
try {
await client.query(sql);
await client.query('INSERT INTO migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [file]);
await client.query('COMMIT');
console.log(`Applied migration: ${file}`);
} catch (err) {
await client.query('ROLLBACK');
throw err;
}
}

console.log('Migrations complete.');
} finally {
await client.end();
}
}

run().catch((err) => {
console.error('Migration run failed:', err);
process.exitCode = 1;
});
