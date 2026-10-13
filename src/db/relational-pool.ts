import { Pool, QueryResultRow } from 'pg';

const connectionString = process.env.LOCAL_DATABASE_URL || process.env.DATABASE_URL;
export const relationalEnabled = process.env.USE_RELATIONAL_DB === 'true' && Boolean(connectionString);

export const relationalPool = relationalEnabled && connectionString
  ? new Pool({
      connectionString,
      ssl: connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
        ? undefined
        : { rejectUnauthorized: false }
    })
  : null;

export async function relationalQuery<T extends QueryResultRow = any>(text: string, values: any[] = []): Promise<{ rows: T[]; rowCount: number | null }> {
  if (!relationalPool) throw new Error('Relational database is not enabled');
  return relationalPool.query<T>(text, values);
}

export async function withRelationalTransaction<T>(work: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  if (!relationalPool) throw new Error('Relational database is not enabled');
  const client = await relationalPool.connect();
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
