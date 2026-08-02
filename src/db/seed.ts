import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../config.js';
import { createPool } from './pool.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL, 2);
  const seedPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../database/migrations/002_seed_demo_data.sql',
  );
  try {
    const sql = await readFile(seedPath, 'utf8');
    await pool.query('BEGIN');
    try {
      await pool.query("DELETE FROM incidents WHERE reported_by = 'Demo Operations'");
      await pool.query(sql);
      await pool.query('COMMIT');
      console.log(JSON.stringify({ event: 'demo_seed_complete' }));
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await main();
}
