import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const connectionString = process.env.DATABASE_URL || 'postgres://advisor:advisor_local_pass@localhost:5435/realtime_advisor';

const pool = new pg.Pool({
  connectionString
});

export const db = drizzle(pool, { schema });
export { pool };
