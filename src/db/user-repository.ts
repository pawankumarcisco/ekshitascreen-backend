import { relationalQuery, withRelationalTransaction } from './relational-pool.js';

export interface RelationalUser {
  id: string; name: string; email: string; passwordHash: string; role: string;
  isActive: boolean; createdAt: string; updatedAt: string;
}

function mapUser(row: any): RelationalUser {
  return {
    id: row.id, name: row.name, email: row.email, passwordHash: row.password_hash,
    role: row.role, isActive: row.is_active, createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

export async function findUserByEmail(email: string) {
  const result = await relationalQuery(
    'SELECT id,name,email,password_hash,role,is_active,created_at,updated_at FROM users WHERE lower(email)=lower($1) AND is_active=true LIMIT 1',
    [email]
  );
  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function findUserById(id: string) {
  const result = await relationalQuery(
    'SELECT id,name,email,password_hash,role,is_active,created_at,updated_at FROM users WHERE id=$1 LIMIT 1',
    [id]
  );
  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function listUsers() {
  const result = await relationalQuery(
    'SELECT id,name,email,password_hash,role,is_active,created_at,updated_at FROM users ORDER BY created_at ASC, id ASC'
  );
  return result.rows.map(mapUser);
}

const mapSafe = (row: any) => { const user = mapUser(row); const { passwordHash: _passwordHash, ...safe } = user; return safe; };

export async function createUser(input: { id: string; name: string; email: string; passwordHash: string; role: string; isActive: boolean; createdAt: string; updatedAt: string }, audit: { id: string; actorId: string; details: any }) {
  return withRelationalTransaction(async client => {
    const result = await client.query('INSERT INTO users(id,name,email,password_hash,role,is_active,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,name,email,password_hash,role,is_active,created_at,updated_at', [input.id,input.name,input.email,input.passwordHash,input.role,input.isActive,input.createdAt,input.updatedAt]);
    await client.query('INSERT INTO audit_logs(id,user_id,action,details,created_at) VALUES($1,$2,$3,$4,NOW())', [audit.id,audit.actorId,'USER_CREATED',JSON.stringify(audit.details)]);
    return mapSafe(result.rows[0]);
  });
}

export async function updateUser(id: string, patch: { name: string; email: string; passwordHash?: string; role: string; isActive: boolean; updatedAt: string }, audit: { id: string; actorId: string; details: any }) {
  return withRelationalTransaction(async client => {
    const result = patch.passwordHash
      ? await client.query('UPDATE users SET name=$1,email=$2,password_hash=$3,role=$4,is_active=$5,updated_at=$6 WHERE id=$7 RETURNING id,name,email,password_hash,role,is_active,created_at,updated_at', [patch.name,patch.email,patch.passwordHash,patch.role,patch.isActive,patch.updatedAt,id])
      : await client.query('UPDATE users SET name=$1,email=$2,role=$3,is_active=$4,updated_at=$5 WHERE id=$6 RETURNING id,name,email,password_hash,role,is_active,created_at,updated_at', [patch.name,patch.email,patch.role,patch.isActive,patch.updatedAt,id]);
    if (!result.rowCount) return null;
    await client.query('INSERT INTO audit_logs(id,user_id,action,details,created_at) VALUES($1,$2,$3,$4,NOW())', [audit.id,audit.actorId,'USER_UPDATED',JSON.stringify(audit.details)]);
    return mapSafe(result.rows[0]);
  });
}

export async function deleteUser(id: string, audit: { id: string; actorId: string; details: any }) {
  return withRelationalTransaction(async client => {
    const refs = await client.query('SELECT EXISTS(SELECT 1 FROM screens WHERE user_id=$1) OR EXISTS(SELECT 1 FROM media_assets WHERE user_id=$1) AS referenced', [id]);
    if (refs.rows[0].referenced) return { referenced: true, deleted: false };
    const result = await client.query('DELETE FROM users WHERE id=$1', [id]);
    if (!result.rowCount) return { referenced: false, deleted: false };
    await client.query('INSERT INTO audit_logs(id,user_id,action,details,created_at) VALUES($1,$2,$3,$4,NOW())', [audit.id,audit.actorId,'USER_DELETED',JSON.stringify(audit.details)]);
    return { referenced: false, deleted: true };
  });
}
