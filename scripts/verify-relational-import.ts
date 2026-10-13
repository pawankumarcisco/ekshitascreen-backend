import 'dotenv/config';
import fs from 'node:fs';
import { Pool } from 'pg';

const sourcePath = process.argv[2];
if (!sourcePath) throw new Error('Usage: npm run db:verify -- <path-to-legacy-state.json>');
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8')) as Record<string, any[]>;
const url = process.env.LOCAL_DATABASE_URL || process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL or LOCAL_DATABASE_URL is required');
const pool = new Pool({ connectionString: url, ssl: url.includes('localhost') || url.includes('127.0.0.1') ? undefined : { rejectUnauthorized: false } });
const map: Record<string,string> = { users:'users',devices:'devices',activations:'device_activations',screens:'screens',screenConfigurations:'screen_configurations',mediaAssets:'media_assets',playlists:'playlists',playlistItems:'playlist_items',deviceSyncs:'device_syncs',heartbeats:'device_heartbeats',auditLogs:'audit_logs',screenGroups:'screen_groups',screenGroupMembers:'screen_group_members',layouts:'layouts',schedules:'schedules',playbackSettings:'playback_settings',cleanupRuns:'cleanup_runs',generalSettingsDrafts:'general_settings_drafts',generalSettingsRevisions:'general_settings_revisions',publishJobs:'publish_jobs',publishTargets:'publish_targets',publishAttempts:'publish_attempts',publishEvents:'publish_events',settingsPublications:'settings_publications',deviceSettings:'device_settings',deviceCommands:'device_commands' };
const checks: Array<{name:string; source:number; destination:number; status:string}> = [];
const client = await pool.connect();
try {
  for (const [key, table] of Object.entries(map)) {
    const n = Number((await client.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count);
    const expected = Array.isArray(source[key]) ? source[key].length : 0;
    checks.push({ name:key, source:expected, destination:n, status:n === expected ? 'PASS' : 'FAIL' });
  }
  const orphanQueries: Array<[string,string]> = [
    ['screens -> users', 'SELECT COUNT(*)::int AS count FROM screens s LEFT JOIN users u ON u.id=s.user_id WHERE u.id IS NULL'],
    ['screens -> devices', 'SELECT COUNT(*)::int AS count FROM screens s LEFT JOIN devices d ON d.id=s.device_id WHERE d.id IS NULL'],
    ['playlist_items -> playlists', 'SELECT COUNT(*)::int AS count FROM playlist_items i LEFT JOIN playlists p ON p.id=i.playlist_id WHERE p.id IS NULL'],
    ['playlist_items -> media_assets', 'SELECT COUNT(*)::int AS count FROM playlist_items i LEFT JOIN media_assets a ON a.id=i.media_asset_id WHERE a.id IS NULL'],
    ['audit_logs -> users/devices', 'SELECT COUNT(*)::int AS count FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN devices d ON d.id=a.device_id WHERE (a.user_id IS NOT NULL AND u.id IS NULL) OR (a.device_id IS NOT NULL AND d.id IS NULL)']
  ];
  for (const [name, sql] of orphanQueries) { const n=Number((await client.query(sql)).rows[0].count); checks.push({name,source:0,destination:n,status:n===0?'PASS':'FAIL'}); }
  const hashRows = await client.query('SELECT id,password_hash FROM users ORDER BY id');
  const sourceHashes = new Map((source.users ?? []).map((u:any)=>[u.id,u.passwordHash]));
  const hashMismatch = hashRows.rows.filter(r => sourceHashes.get(r.id) !== r.password_hash).length;
  checks.push({name:'bcrypt hashes',source:0,destination:hashMismatch,status:hashMismatch===0?'PASS':'FAIL'});
  const failed = checks.filter(c=>c.status==='FAIL');
  const output = ['# Relational import verification','',`Generated: ${new Date().toISOString()}`,'','| Check | Source | Destination | Status |','|---|---:|---:|---|',...checks.map(c=>`| ${c.name} | ${c.source} | ${c.destination} | ${c.status} |`),'',failed.length ? `Result: FAIL (${failed.length} checks)` : 'Result: PASS'];
  fs.writeFileSync('docs/relational-import-verification.md', output.join('\n') + '\n', 'utf8');
  console.log(failed.length ? `Verification failed: ${failed.length} checks` : 'Verification passed: all counts, relationships, and hashes match');
  if (failed.length) process.exitCode = 1;
} finally { client.release(); await pool.end(); }
