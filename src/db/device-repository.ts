import { relationalQuery } from './relational-pool.js';

export async function findDeviceByUid(deviceUid: string) {
  const result = await relationalQuery<any>('SELECT id,device_uid,registered,device_name,app_version,last_seen_at FROM devices WHERE device_uid=$1 LIMIT 1', [deviceUid]);
  return result.rows[0] || null;
}

export async function findDeviceById(id: string) {
  const result = await relationalQuery<any>('SELECT id,device_uid,registered,device_name,app_version,last_seen_at FROM devices WHERE id=$1 LIMIT 1', [id]);
  return result.rows[0] || null;
}
