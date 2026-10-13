-- EkshitaScreen relational schema.
-- Additive and forward-only. Never drop/truncate app_state.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  email VARCHAR(320) NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('ADMIN','OPERATOR','VIEWER')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uq ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  device_uid VARCHAR(200) NOT NULL UNIQUE,
  device_name VARCHAR(200), app_version VARCHAR(100) NOT NULL,
  android_version VARCHAR(100), model VARCHAR(200), manufacturer VARCHAR(200),
  registered BOOLEAN NOT NULL DEFAULT FALSE, registered_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS device_activations (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id),
  code VARCHAR(32) NOT NULL, code_hash VARCHAR(128) NOT NULL,
  code_display_suffix VARCHAR(16), status VARCHAR(20) NOT NULL CHECK (status IN ('PENDING','ACTIVATED','EXPIRED','CANCELLED')),
  expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (code), UNIQUE (code_hash)
);
CREATE INDEX IF NOT EXISTS device_activations_device_created_idx ON device_activations(device_id, created_at DESC);

CREATE TABLE IF NOT EXISTS screens (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL UNIQUE REFERENCES devices(id),
  user_id TEXT NOT NULL REFERENCES users(id), name VARCHAR(200) NOT NULL,
  location TEXT, description TEXT, is_active BOOLEAN NOT NULL DEFAULT TRUE,
  valid_until TIMESTAMPTZ NOT NULL, assigned_playlist_id TEXT,
  settings_group_id TEXT, assignment_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS screens_user_updated_idx ON screens(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS screen_configurations (
  id TEXT PRIMARY KEY, screen_id TEXT NOT NULL UNIQUE REFERENCES screens(id) ON DELETE CASCADE,
  width INTEGER NOT NULL CHECK (width > 0), height INTEGER NOT NULL CHECK (height > 0),
  rotation INTEGER NOT NULL CHECK (rotation IN (0,90,180,270)), orientation VARCHAR(20) NOT NULL,
  fit_mode VARCHAR(20) NOT NULL, interval_seconds INTEGER NOT NULL CHECK (interval_seconds > 0),
  transition VARCHAR(40) NOT NULL, transition_duration_ms INTEGER NOT NULL CHECK (transition_duration_ms >= 0),
  loop BOOLEAN NOT NULL, shuffle BOOLEAN NOT NULL, auto_start BOOLEAN NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0), updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), original_name TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE, mime_type VARCHAR(120) NOT NULL, file_size BIGINT NOT NULL CHECK (file_size >= 0),
  width INTEGER NOT NULL CHECK (width >= 0), height INTEGER NOT NULL CHECK (height >= 0),
  dpi INTEGER, quality INTEGER, sha256 CHAR(64) NOT NULL, url TEXT, thumbnail_url TEXT,
  created_at TIMESTAMPTZ NOT NULL, deleted_at TIMESTAMPTZ, auto_delete BOOLEAN, cleanup_grace_days INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS media_assets_user_created_idx ON media_assets(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY, screen_id TEXT REFERENCES screens(id), owner_id TEXT REFERENCES users(id),
  created_by TEXT NOT NULL REFERENCES users(id), name TEXT, description TEXT, version INTEGER NOT NULL CHECK (version > 0),
  status VARCHAR(20) NOT NULL CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  library_playlist BOOLEAN NOT NULL DEFAULT FALSE, published_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS playlists_screen_status_version_idx ON playlists(screen_id, status, version DESC);
CREATE INDEX IF NOT EXISTS playlists_owner_created_idx ON playlists(owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS playlist_items (
  id TEXT PRIMARY KEY, playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  media_asset_id TEXT NOT NULL REFERENCES media_assets(id), sort_order INTEGER NOT NULL CHECK (sort_order > 0),
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds > 0), enabled BOOLEAN NOT NULL DEFAULT TRUE,
  valid_from TIMESTAMPTZ, expires_at TIMESTAMPTZ, UNIQUE (playlist_id, sort_order)
);
CREATE INDEX IF NOT EXISTS playlist_items_asset_idx ON playlist_items(media_asset_id);

CREATE TABLE IF NOT EXISTS device_syncs (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), target_version INTEGER NOT NULL,
  applied_version INTEGER, status VARCHAR(30) NOT NULL, progress INTEGER NOT NULL CHECK (progress BETWEEN 0 AND 100),
  error_message TEXT, started_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS device_syncs_device_started_idx ON device_syncs(device_id, started_at DESC);

CREATE TABLE IF NOT EXISTS device_heartbeats (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), last_seen_at TIMESTAMPTZ NOT NULL,
  playback_status VARCHAR(40), applied_version INTEGER NOT NULL DEFAULT 0, free_storage_bytes BIGINT NOT NULL DEFAULT 0,
  app_version VARCHAR(100)
);
CREATE INDEX IF NOT EXISTS device_heartbeats_device_seen_idx ON device_heartbeats(device_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  device_id TEXT REFERENCES devices(id) ON DELETE SET NULL, action VARCHAR(160) NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_logs_user_idx ON audit_logs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS screen_groups (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name VARCHAR(200) NOT NULL,
  description TEXT, is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS screen_group_members (
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES screen_groups(id) ON DELETE CASCADE,
  screen_id TEXT NOT NULL REFERENCES screens(id) ON DELETE CASCADE, created_by TEXT REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (group_id, screen_id)
);

CREATE TABLE IF NOT EXISTS layouts (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name VARCHAR(200) NOT NULL,
  description TEXT, width INTEGER NOT NULL, height INTEGER NOT NULL, orientation VARCHAR(20) NOT NULL,
  background_color VARCHAR(32) NOT NULL, template VARCHAR(80) NOT NULL, zones JSONB NOT NULL DEFAULT '[]'::jsonb,
  version INTEGER NOT NULL, deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name VARCHAR(200) NOT NULL,
  playlist_id TEXT NOT NULL REFERENCES playlists(id), layout_id TEXT REFERENCES layouts(id),
  screen_ids JSONB NOT NULL DEFAULT '[]'::jsonb, group_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  target_screen_ids JSONB NOT NULL DEFAULT '[]'::jsonb, weekdays JSONB NOT NULL DEFAULT '[]'::jsonb,
  start_date TIMESTAMPTZ NOT NULL, end_date TIMESTAMPTZ, start_time VARCHAR(8) NOT NULL, end_time VARCHAR(8) NOT NULL,
  all_day BOOLEAN NOT NULL, timezone VARCHAR(100) NOT NULL, priority INTEGER NOT NULL, enabled BOOLEAN NOT NULL,
  deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS playback_settings (
  id TEXT PRIMARY KEY, owner_id TEXT REFERENCES users(id), scope VARCHAR(20) NOT NULL CHECK (scope IN ('GLOBAL','GROUP','SCREEN')),
  scope_id TEXT NOT NULL, values JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE(scope, scope_id)
);
CREATE TABLE IF NOT EXISTS cleanup_runs (
  id TEXT PRIMARY KEY, initiated_by TEXT REFERENCES users(id) ON DELETE SET NULL, status VARCHAR(30) NOT NULL,
  eligible_ids JSONB NOT NULL DEFAULT '[]'::jsonb, deleted_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb, started_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS general_settings_drafts (
  id TEXT PRIMARY KEY, scope VARCHAR(20) NOT NULL, scope_id TEXT NOT NULL, overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, updated_by TEXT REFERENCES users(id), UNIQUE(scope, scope_id)
);
CREATE TABLE IF NOT EXISTS general_settings_revisions (
  id TEXT PRIMARY KEY, scope VARCHAR(20) NOT NULL, scope_id TEXT NOT NULL, version INTEGER NOT NULL,
  overrides JSONB NOT NULL DEFAULT '{}'::jsonb, actor_id TEXT REFERENCES users(id), published_at TIMESTAMPTZ NOT NULL,
  UNIQUE(scope, scope_id, version)
);

CREATE TABLE IF NOT EXISTS publish_jobs (
  id TEXT PRIMARY KEY, publisher_id TEXT REFERENCES users(id), source_screen_id TEXT REFERENCES screens(id),
  playlist_id TEXT REFERENCES playlists(id), layout_id TEXT REFERENCES layouts(id), content_version INTEGER NOT NULL,
  playlist_version INTEGER NOT NULL, target_count INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL,
  group_snapshots JSONB NOT NULL DEFAULT '[]'::jsonb, metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS publish_jobs_created_idx ON publish_jobs(created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS publish_targets (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES publish_jobs(id) ON DELETE CASCADE,
  screen_id TEXT NOT NULL REFERENCES screens(id), device_id TEXT NOT NULL REFERENCES devices(id),
  screen_name_snapshot TEXT NOT NULL, target_version INTEGER NOT NULL, playlist_version INTEGER NOT NULL,
  configuration_version INTEGER NOT NULL, attempt_id TEXT, active_version INTEGER, status VARCHAR(30) NOT NULL,
  progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100), files_completed INTEGER NOT NULL DEFAULT 0,
  total_files INTEGER NOT NULL DEFAULT 0, total_bytes BIGINT NOT NULL DEFAULT 0, bytes_downloaded BIGINT NOT NULL DEFAULT 0,
  last_progress_at TIMESTAMPTZ, error_code VARCHAR(100), error_message TEXT, created_at TIMESTAMPTZ NOT NULL,
  configuration_snapshot JSONB, layout_snapshot JSONB, settings_snapshot JSONB, schedule_snapshot JSONB, manifest_snapshot JSONB,
  UNIQUE(job_id, screen_id)
);
CREATE INDEX IF NOT EXISTS publish_targets_screen_version_idx ON publish_targets(screen_id, target_version DESC);
CREATE TABLE IF NOT EXISTS publish_attempts (
  id TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES publish_targets(id) ON DELETE CASCADE, attempt_number INTEGER NOT NULL,
  status VARCHAR(30) NOT NULL, event_sequence INTEGER NOT NULL DEFAULT 0, progress_percent INTEGER NOT NULL DEFAULT 0,
  bytes_downloaded BIGINT NOT NULL DEFAULT 0, total_bytes BIGINT NOT NULL DEFAULT 0, files_completed INTEGER NOT NULL DEFAULT 0,
  total_files INTEGER NOT NULL DEFAULT 0, current_file TEXT, error_code VARCHAR(100), error_message TEXT,
  started_at TIMESTAMPTZ, ready_at TIMESTAMPTZ, activated_at TIMESTAMPTZ, playback_confirmed_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL, UNIQUE(target_id, attempt_number)
);
CREATE TABLE IF NOT EXISTS publish_events (
  id TEXT PRIMARY KEY, event_id TEXT, attempt_id TEXT NOT NULL REFERENCES publish_attempts(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES publish_targets(id) ON DELETE CASCADE, status VARCHAR(30) NOT NULL,
  event_sequence INTEGER NOT NULL, details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(attempt_id, event_id)
);
CREATE INDEX IF NOT EXISTS publish_events_attempt_seq_idx ON publish_events(attempt_id, event_sequence);

CREATE TABLE IF NOT EXISTS settings_publications (
  id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL, actor_id TEXT REFERENCES users(id), scope VARCHAR(20) NOT NULL,
  scope_id TEXT NOT NULL, revision_id TEXT REFERENCES general_settings_revisions(id), created_at TIMESTAMPTZ NOT NULL,
  targets JSONB NOT NULL DEFAULT '[]'::jsonb, UNIQUE(actor_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS device_settings (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE, screen_id TEXT REFERENCES screens(id), publication_id TEXT REFERENCES settings_publications(id),
  desired_version INTEGER NOT NULL DEFAULT 0, received_version INTEGER NOT NULL DEFAULT 0, applied_version INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING', last_seen_at TIMESTAMPTZ, last_applied_at TIMESTAMPTZ,
  error_code VARCHAR(100), error_message TEXT, effective JSONB NOT NULL DEFAULT '{}'::jsonb, unsupported_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE TABLE IF NOT EXISTS device_commands (
  id TEXT PRIMARY KEY, screen_id TEXT NOT NULL REFERENCES screens(id), device_id TEXT NOT NULL REFERENCES devices(id),
  command_type VARCHAR(40) NOT NULL, status VARCHAR(30) NOT NULL, requested_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL, delivered_at TIMESTAMPTZ, acknowledged_at TIMESTAMPTZ, executing_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ, failed_at TIMESTAMPTZ, error_code VARCHAR(100), error_message TEXT
);
CREATE INDEX IF NOT EXISTS device_commands_device_status_idx ON device_commands(device_id, status, requested_at DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'screens_assigned_playlist_fk') THEN
    ALTER TABLE screens ADD CONSTRAINT screens_assigned_playlist_fk FOREIGN KEY (assigned_playlist_id) REFERENCES playlists(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'screens_settings_group_fk') THEN
    ALTER TABLE screens ADD CONSTRAINT screens_settings_group_fk FOREIGN KEY (settings_group_id) REFERENCES screen_groups(id) NOT VALID;
  END IF;
END $$;
