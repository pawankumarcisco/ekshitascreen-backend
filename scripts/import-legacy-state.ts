import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Pool, PoolClient } from 'pg';

type Row = Record<string, any>;
type LegacyState = Record<string, Row[]>;

const sourcePath = process.argv[2];
if (!sourcePath) {
  console.error('Usage: npm run db:import -- <path-to-legacy-state.json>');
  process.exit(2);
}
const resolvedSource = path.resolve(sourcePath);
const source: LegacyState = JSON.parse(fs.readFileSync(resolvedSource, 'utf8'));
const connectionString = process.env.LOCAL_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL or LOCAL_DATABASE_URL is required');

const pool = new Pool({
  connectionString,
  ssl: connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
    ? undefined : { rejectUnauthorized: false }
});

const text = (v: any) => v == null ? null : String(v);
const int = (v: any) => v == null ? null : Number(v);
const bool = (v: any, fallback = false) => v == null ? fallback : Boolean(v);
const date = (v: any) => v == null ? null : new Date(v);
const json = (v: any) => JSON.stringify(v ?? {});

async function insert(client: PoolClient, table: string, columns: string[], values: any[]) {
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  await client.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`, values);
}

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(74839201)');
    await client.query(`CREATE TABLE IF NOT EXISTS relational_import_runs (
      id BIGSERIAL PRIMARY KEY, source_path TEXT NOT NULL, source_sha256 TEXT NOT NULL UNIQUE,
      source_counts JSONB NOT NULL, imported_counts JSONB NOT NULL, status TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ
    )`);
    const sourceBytes = fs.readFileSync(resolvedSource);
    const crypto = await import('node:crypto');
    const checksum = crypto.createHash('sha256').update(sourceBytes).digest('hex');
    const existing = await client.query('SELECT id, status FROM relational_import_runs WHERE source_sha256 = $1', [checksum]);
    if (existing.rowCount) {
      console.log(`Source already imported (run ${existing.rows[0].id}, status ${existing.rows[0].status}); no changes made.`);
      await client.query('ROLLBACK');
      return;
    }
    const counts: Record<string, number> = {};
    for (const [key, rows] of Object.entries(source)) counts[key] = Array.isArray(rows) ? rows.length : 0;
    const runRow = await client.query(
      'INSERT INTO relational_import_runs(source_path, source_sha256, source_counts, imported_counts, status) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [resolvedSource, checksum, json(counts), json({}), 'RUNNING']
    );

    for (const r of source.users ?? []) await insert(client, 'users', ['id','name','email','password_hash','role','is_active','created_at','updated_at'], [text(r.id),text(r.name),text(r.email),text(r.passwordHash),text(r.role),bool(r.isActive,true),date(r.createdAt),date(r.updatedAt)]);
    for (const r of source.devices ?? []) await insert(client, 'devices', ['id','device_uid','device_name','app_version','android_version','model','manufacturer','registered','registered_at','last_seen_at','created_at','updated_at'], [text(r.id),text(r.deviceUid),text(r.deviceName),text(r.appVersion)||'1.0.0',text(r.androidVersion),text(r.model),text(r.manufacturer),bool(r.registered),date(r.registeredAt),date(r.lastSeenAt),date(r.createdAt),date(r.updatedAt)]);
    for (const r of source.screens ?? []) await insert(client, 'screens', ['id','device_id','user_id','name','location','description','is_active','valid_until','created_at','updated_at'], [text(r.id),text(r.deviceId),text(r.userId),text(r.name),text(r.location),text(r.description),bool(r.isActive,true),date(r.validUntil),date(r.createdAt),date(r.updatedAt)]);
    for (const r of source.activations ?? []) await insert(client, 'device_activations', ['id','device_id','code','code_hash','code_display_suffix','status','expires_at','consumed_at','created_at'], [text(r.id),text(r.deviceId),text(r.code),text(r.codeHash),text(r.codeDisplaySuffix),text(r.status),date(r.expiresAt),date(r.consumedAt),date(r.createdAt)]);
    for (const r of source.screenConfigurations ?? []) await insert(client, 'screen_configurations', ['id','screen_id','width','height','rotation','orientation','fit_mode','interval_seconds','transition','transition_duration_ms','loop','shuffle','auto_start','version','updated_at'], [text(r.id),text(r.screenId),int(r.width),int(r.height),int(r.rotation),text(r.orientation),text(r.fitMode),int(r.intervalSeconds),text(r.transition),int(r.transitionDurationMs),bool(r.loop),bool(r.shuffle),bool(r.autoStart),int(r.version),date(r.updatedAt)]);
    for (const r of source.mediaAssets ?? []) await insert(client, 'media_assets', ['id','user_id','original_name','storage_key','mime_type','file_size','width','height','dpi','quality','sha256','url','thumbnail_url','created_at','metadata'], [text(r.id),text(r.userId),text(r.originalName),text(r.storageKey),text(r.mimeType),int(r.fileSize),int(r.width),int(r.height),int(r.dpi),int(r.quality),text(r.sha256),text(r.url),text(r.thumbnailUrl),date(r.createdAt),json(r.metadata)]);
    for (const r of source.playlists ?? []) await insert(client, 'playlists', ['id','screen_id','owner_id','created_by','name','description','version','status','library_playlist','published_at','deleted_at','created_at','updated_at','metadata'], [text(r.id),text(r.screenId),text(r.ownerId),text(r.createdBy),text(r.name),text(r.description),int(r.version)||1,text(r.status),bool(r.libraryPlaylist),date(r.publishedAt),date(r.deletedAt),date(r.createdAt),date(r.updatedAt),json(r.metadata)]);
    for (const r of source.playlistItems ?? []) await insert(client, 'playlist_items', ['id','playlist_id','media_asset_id','sort_order','duration_seconds','enabled','valid_from','expires_at'], [text(r.id),text(r.playlistId),text(r.mediaAssetId),int(r.sortOrder),int(r.durationSeconds),bool(r.enabled,true),date(r.validFrom),date(r.expiresAt)]);
    for (const r of source.deviceSyncs ?? []) await insert(client, 'device_syncs', ['id','device_id','target_version','applied_version','status','progress','error_message','started_at','completed_at'], [text(r.id),text(r.deviceId),int(r.targetVersion),int(r.appliedVersion),text(r.status),int(r.progress)||0,text(r.errorMessage),date(r.startedAt),date(r.completedAt)]);
    for (const r of source.heartbeats ?? []) await insert(client, 'device_heartbeats', ['id','device_id','last_seen_at','playback_status','applied_version','free_storage_bytes','app_version'], [text(r.id),text(r.deviceId),date(r.lastSeenAt),text(r.playbackStatus),int(r.appliedVersion)||0,Number(r.freeStorageBytes)||0,text(r.appVersion)]);
    for (const r of source.auditLogs ?? []) await insert(client, 'audit_logs', ['id','user_id','device_id','action','details','created_at'], [text(r.id),text(r.userId),text(r.deviceId),text(r.action),json(r.details),date(r.createdAt)]);
    for (const r of source.screenGroups ?? []) await insert(client, 'screen_groups', ['id','owner_id','name','description','is_active','created_at','updated_at'], [text(r.id),text(r.ownerId),text(r.name),text(r.description),bool(r.isActive,true),date(r.createdAt),date(r.updatedAt)]);
    for (const r of source.screenGroupMembers ?? []) await insert(client, 'screen_group_members', ['id','group_id','screen_id','created_by','created_at'], [text(r.id),text(r.groupId),text(r.screenId),text(r.createdBy),date(r.createdAt)]);
    for (const r of source.layouts ?? []) await insert(client, 'layouts', ['id','owner_id','name','description','width','height','orientation','background_color','template','zones','version','deleted_at','created_at','updated_at'], [text(r.id),text(r.ownerId),text(r.name),text(r.description),int(r.width),int(r.height),text(r.orientation),text(r.backgroundColor),text(r.template),json(r.zones||[]),int(r.version)||1,date(r.deletedAt),date(r.createdAt),date(r.updatedAt)]);
    for (const r of source.schedules ?? []) await insert(client, 'schedules', ['id','owner_id','name','playlist_id','layout_id','screen_ids','group_ids','target_screen_ids','weekdays','start_date','end_date','start_time','end_time','all_day','timezone','priority','enabled','deleted_at','created_at','updated_at'], [text(r.id),text(r.ownerId),text(r.name),text(r.playlistId),text(r.layoutId),json(r.screenIds||[]),json(r.groupIds||[]),json(r.targetScreenIds||[]),json(r.weekdays||[]),date(r.startDate),date(r.endDate),text(r.startTime)||'00:00',text(r.endTime)||'00:00',bool(r.allDay),text(r.timezone)||'UTC',int(r.priority)||0,bool(r.enabled,true),date(r.deletedAt),date(r.createdAt),date(r.updatedAt)]);
    for (const r of source.playbackSettings ?? []) await insert(client, 'playback_settings', ['id','owner_id','scope','scope_id','values','created_at','updated_at'], [text(r.id),text(r.ownerId),text(r.scope),text(r.scopeId),json(r.values),date(r.createdAt),date(r.updatedAt)]);
    for (const r of source.cleanupRuns ?? []) await insert(client, 'cleanup_runs', ['id','initiated_by','status','eligible_ids','deleted_ids','errors','started_at','completed_at'], [text(r.id),text(r.userId),text(r.status),json(r.eligibleIds||[]),json(r.deletedIds||[]),json(r.errors||[]),date(r.startedAt),date(r.completedAt)]);
    for (const r of source.generalSettingsDrafts ?? []) await insert(client, 'general_settings_drafts', ['id','scope','scope_id','overrides','created_at','updated_at','updated_by'], [text(r.id),text(r.scope),text(r.scopeId),json(r.overrides),date(r.createdAt),date(r.updatedAt),text(r.updatedBy)]);
    for (const r of source.generalSettingsRevisions ?? []) await insert(client, 'general_settings_revisions', ['id','scope','scope_id','version','overrides','actor_id','published_at'], [text(r.id),text(r.scope),text(r.scopeId),int(r.version),json(r.overrides),text(r.actorId),date(r.publishedAt)]);
    for (const r of source.publishJobs ?? []) await insert(client, 'publish_jobs', ['id','publisher_id','source_screen_id','playlist_id','layout_id','content_version','playlist_version','target_count','created_at','group_snapshots','metadata'], [text(r.id),text(r.publisherId||r.ownerId),text(r.sourceScreenId),text(r.playlistId),text(r.layoutId),int(r.contentVersion)||0,int(r.playlistVersion)||0,int(r.targetCount)||0,date(r.createdAt),json(r.groupSnapshots||[]),json(r.metadata)]);
    for (const r of source.publishTargets ?? []) await insert(client, 'publish_targets', ['id','job_id','screen_id','device_id','screen_name_snapshot','target_version','playlist_version','configuration_version','attempt_id','active_version','status','progress_percent','files_completed','total_files','total_bytes','bytes_downloaded','last_progress_at','error_code','error_message','created_at','configuration_snapshot','layout_snapshot','settings_snapshot','schedule_snapshot','manifest_snapshot'], [text(r.id),text(r.jobId),text(r.screenId),text(r.deviceId),text(r.screenNameSnapshot),int(r.targetVersion)||0,int(r.playlistVersion)||0,int(r.configurationVersion)||0,text(r.attemptId),int(r.activeVersion),text(r.status),int(r.progressPercent)||0,int(r.filesCompleted)||0,int(r.totalFiles)||0,Number(r.totalBytes)||0,Number(r.bytesDownloaded)||0,date(r.lastProgressAt),text(r.errorCode),text(r.errorMessage),date(r.createdAt),json(r.configurationSnapshot),json(r.layoutSnapshot),json(r.settingsSnapshot),json(r.scheduleSnapshot),json(r.manifestSnapshot)]);
    for (const r of source.publishAttempts ?? []) await insert(client, 'publish_attempts', ['id','target_id','attempt_number','status','event_sequence','progress_percent','bytes_downloaded','total_bytes','files_completed','total_files','current_file','error_code','error_message','started_at','ready_at','activated_at','playback_confirmed_at','completed_at','created_at'], [text(r.id),text(r.targetId),int(r.number||r.attemptNumber)||1,text(r.status),int(r.eventSequence)||0,int(r.progressPercent)||0,Number(r.bytesDownloaded)||0,Number(r.totalBytes)||0,int(r.filesCompleted)||0,int(r.totalFiles)||0,text(r.currentFile),text(r.errorCode),text(r.errorMessage),date(r.startedAt),date(r.readyAt),date(r.activatedAt),date(r.playbackConfirmedAt),date(r.completedAt),date(r.createdAt)]);
    for (const r of source.publishEvents ?? []) await insert(client, 'publish_events', ['id','event_id','attempt_id','target_id','status','event_sequence','details','created_at'], [text(r.id),text(r.eventId),text(r.attemptId),text(r.targetId),text(r.status),int(r.eventSequence)||0,json(r.details),date(r.createdAt)]);
    for (const r of source.settingsPublications ?? []) await insert(client, 'settings_publications', ['id','idempotency_key','actor_id','scope','scope_id','revision_id','created_at','targets'], [text(r.id),text(r.idempotencyKey),text(r.actorId),text(r.scope),text(r.scopeId),text(r.revisionId),date(r.createdAt),json(r.targets||[])]);
    for (const r of source.deviceSettings ?? []) await insert(client, 'device_settings', ['device_id','screen_id','publication_id','desired_version','received_version','applied_version','status','last_seen_at','last_applied_at','error_code','error_message','effective','unsupported_capabilities'], [text(r.deviceId),text(r.screenId),text(r.publicationId),int(r.desiredVersion)||0,int(r.receivedVersion)||0,int(r.appliedVersion)||0,text(r.status)||'PENDING',date(r.lastSeenAt),date(r.lastAppliedAt),text(r.errorCode),text(r.errorMessage),json(r.effective),json(r.unsupportedCapabilities||[])]);
    for (const r of source.deviceCommands ?? []) await insert(client, 'device_commands', ['id','screen_id','device_id','command_type','status','requested_at','expires_at','delivered_at','acknowledged_at','executing_at','completed_at','failed_at','error_code','error_message'], [text(r.id),text(r.screenId),text(r.deviceId),text(r.commandType),text(r.status),date(r.requestedAt),date(r.expiresAt),date(r.deliveredAt),date(r.acknowledgedAt),date(r.executingAt),date(r.completedAt),date(r.failedAt),text(r.errorCode),text(r.errorMessage)]);

    for (const r of source.screens ?? []) if (r.assignedPlaylistId || r.settingsGroupId) await client.query('UPDATE screens SET assigned_playlist_id=$1, settings_group_id=$2, assignment_updated_at=$3 WHERE id=$4', [text(r.assignedPlaylistId),text(r.settingsGroupId),date(r.assignmentUpdatedAt),text(r.id)]);
    const imported: Record<string, number> = {};
    const tableMap: Record<string,string> = { users:'users',devices:'devices',activations:'device_activations',screens:'screens',screenConfigurations:'screen_configurations',mediaAssets:'media_assets',playlists:'playlists',playlistItems:'playlist_items',deviceSyncs:'device_syncs',heartbeats:'device_heartbeats',auditLogs:'audit_logs',screenGroups:'screen_groups',screenGroupMembers:'screen_group_members',layouts:'layouts',schedules:'schedules',playbackSettings:'playback_settings',cleanupRuns:'cleanup_runs',generalSettingsDrafts:'general_settings_drafts',generalSettingsRevisions:'general_settings_revisions',publishJobs:'publish_jobs',publishTargets:'publish_targets',publishAttempts:'publish_attempts',publishEvents:'publish_events',settingsPublications:'settings_publications',deviceSettings:'device_settings',deviceCommands:'device_commands' };
    for (const [key, table] of Object.entries(tableMap)) imported[key] = Number((await client.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count);
    await client.query('UPDATE relational_import_runs SET imported_counts=$1, status=$2, completed_at=NOW() WHERE id=$3', [json(imported), 'COMPLETED', runRow.rows[0].id]);
    for (const key of Object.keys(counts)) if ((imported[key] ?? 0) < counts[key]) throw new Error(`Destination count is lower than source for ${key}: ${imported[key] ?? 0} < ${counts[key]}`);
    await client.query('COMMIT');
    console.log(`Relational import completed (run ${runRow.rows[0].id}).`);
    for (const key of Object.keys(counts)) console.log(`${key}: source=${counts[key]} destination=${imported[key] ?? 0}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); await pool.end(); }
}

run().catch(error => { console.error('Relational import failed:', error instanceof Error ? error.message : 'unknown error'); process.exitCode = 1; });
