# PostgreSQL relational refactor: phase 1 persistence audit

## Scope and safety baseline

This document records the pre-refactor persistence behavior of `server.ts`. The
legacy `app_state` table remains the source of truth until relational import,
reconciliation, and integration tests pass. No migration may truncate or delete
`app_state`. Production cutover and deployment are deliberately out of scope for
automatic execution.

## Current architecture

- `loadDB()` synchronously loads `storage/screencast-db.json` before PostgreSQL is
  initialized and creates seed users when the file is absent.
- `initializePostgres()` creates/loads one `app_state` row and replaces the
  in-memory `db` object with its `data` JSONB value.
- Every request reads and mutates the process-global `db: DBState` object.
- `saveDB()` serializes the complete state. With PostgreSQL enabled, writes are
  debounced for 100 ms and chained, but the calling request does not await the
  database commit.
- `logAudit()` mutates audit history and calls `saveDB()` independently, so a
  business operation and its audit event are not atomic.
- PostgreSQL is therefore a whole-state snapshot store, not the transactional
  system of record. Concurrent server processes can overwrite each other.

## Persisted collections (26)

| DBState key | Relational table | Principal relationships | Flexible JSONB candidates |
|---|---|---|---|
| `users` | `users` | — | none |
| `devices` | `devices` | — | none |
| `activations` | `device_activations` | device | none |
| `screens` | `screens` | device, assigned user, assigned playlist, settings group | none |
| `screenConfigurations` | `screen_configurations` | screen | none |
| `mediaAssets` | `media_assets` | owner user | provider metadata only |
| `playlists` | `playlists` | screen, owner/creator user | none |
| `playlistItems` | `playlist_items` | playlist, media asset | none |
| `deviceSyncs` | `device_syncs` | device | none |
| `heartbeats` | `device_heartbeats` | device | none |
| `auditLogs` | `audit_logs` | nullable user/device | `details` |
| `screenGroups` | `screen_groups` | owner user | none |
| `screenGroupMembers` | `screen_group_members` | group, screen, creator user | none |
| `publishJobs` | `publish_jobs` | publisher/owner, source screen, playlist, layout | group snapshots |
| `publishTargets` | `publish_targets` | job, screen, device, attempt | immutable configuration/layout/settings/schedule/manifest snapshots |
| `publishAttempts` | `publish_attempts` | target | none |
| `publishEvents` | `publish_events` | attempt, target | `details` |
| `layouts` | `layouts` | owner user | `zones` |
| `schedules` | `schedules` | owner, playlist, optional layout | target ID arrays and weekdays during compatibility phase |
| `playbackSettings` | `playback_settings` | owner; polymorphic scope | `values` |
| `cleanupRuns` | `cleanup_runs` | initiating user | eligible/deleted IDs and errors |
| `generalSettingsDrafts` | `general_settings_drafts` | updater; polymorphic scope | `overrides` |
| `generalSettingsRevisions` | `general_settings_revisions` | actor; polymorphic scope | `overrides` |
| `settingsPublications` | `settings_publications` | actor, revision | target delivery snapshot |
| `deviceSettings` | `device_settings` | device, publication | effective configuration and unsupported capabilities |
| `deviceCommands` | `device_commands` | screen, device, requester | none |

## Read and mutation dependency map

### Authentication and users

- Login reads users by case-insensitive email, verifies the existing bcrypt hash,
  and appends an audit event.
- User create/update/delete requires a case-insensitive unique email and checks
  screen/media ownership before deletion.
- Required transaction boundary: user mutation plus audit event.

### Device activation and screen registration

- Activation request upserts a device, cancels prior pending activations, inserts
  a new activation, logs an audit event, then emits WebSocket events.
- Screen registration consumes an activation, updates its device, inserts the
  screen, configuration, draft playlist and optional playlist items, and logs an
  audit event.
- Required transaction boundaries: the entire activation request; the entire
  screen registration workflow. WebSocket emission occurs only after commit.

### Content and media

- Media upload performs external/local binary storage before inserting metadata.
  Database failure requires compensating file/provider cleanup.
- Media deletion checks published playlists and retained manifests, removes the
  binary, then removes the asset and draft references.
- Playlist item replacement is delete-and-reinsert plus playlist version update.
- Required transaction boundaries: metadata/item changes plus audit events.

### Publishing and device synchronization

- Publishing reads playlist/configuration/layout/settings/schedule state, creates
  a job and one target per resolved screen, supersedes older targets, creates
  attempts and immutable delivery snapshots.
- Retry, cancel and rollback modify jobs, targets and attempts together.
- Device sync enforces idempotent event IDs, monotonic sequence/status progress,
  updates attempt and target rows, inserts an event and audit entry.
- Required transaction isolation: row locks on target/attempt; unique
  `(attempt_id,event_id)`; job creation and all targets in one transaction.

### Settings and remote commands

- General settings draft/publish updates draft/revision/publication/device
  delivery state and may update screen group assignment.
- Device command delivery/ack/completion is a state machine with timestamps.
- Required transaction boundaries: settings publication; each command transition
  with its audit event. WebSocket emission occurs only after commit.

### Monitoring, history and cleanup

- Heartbeats update the device and append bounded in-memory history.
- Audit logs, heartbeats and publication events are currently truncated in
  memory. Relational storage will retain history and expose bounded pagination.
- Cleanup marks media records after deleting provider/local objects and records a
  cleanup run. External deletion cannot be part of a SQL transaction, so it needs
  an explicit resumable state machine.

## Required constraints and indexes

- Case-insensitive unique user email (`lower(email)`).
- Unique device UID and one screen per device.
- Unique active/pending activation rules by device; unique activation code/hash.
- One configuration per screen; valid dimensions, rotation, durations and version.
- Unique playlist item ordering per playlist.
- Unique screen-group membership.
- Unique publication idempotency keys per actor and unique settings revision
  `(scope, scope_id, version)`.
- Unique publish event `(attempt_id, event_id)` when `event_id` is present.
- State/check constraints for roles, statuses, scopes, orientation, fit mode,
  progress percentages and non-negative counters.
- Pagination indexes: audit `(created_at DESC,id DESC)`, heartbeat
  `(device_id,last_seen_at DESC)`, media `(user_id,created_at DESC)`, playlists
  `(screen_id,status,version DESC)` and publications `(owner_id,created_at DESC)`.

## Compatibility hazards

1. Express handlers are currently synchronous. Repository calls make middleware
   and nearly every handler asynchronous; rejected promises must reach the error
   handler.
2. Several responses enrich records from multiple collections. Repository query
   mappers must preserve current camelCase properties and nullable values.
3. Publication targets intentionally store immutable JSON snapshots. Normalizing
   those snapshots would change historical/device behavior and is not planned.
4. The existing 100 ms save debounce can acknowledge a request before persistence.
   Cutover must remove this behavior, not reproduce it.
5. Seed creation must run only when both relational users and legacy state are
   empty. It must never replace imported users or bcrypt hashes.
6. A mixed-mode process must not dual-write silently. Import is offline or under
   an advisory lock, and relational mode is enabled only after reconciliation.

## Implementation phases and gates

1. **Audit (this document):** inventory all 26 collections and mutation paths.
2. **Schema:** checked-in, versioned, forward-only SQL; no destructive recreation.
3. **Importer:** transactionally import `app_state`, retain it unchanged, record a
   checksum/import run, and support safe idempotent reruns.
4. **Verification:** counts, orphan queries, identifier/timestamp validation and a
   machine-readable plus Markdown report. Any discrepancy blocks cutover.
5. **Repositories/services:** migrate feature slices behind the existing API,
   starting with auth/users, then registration, content, publishing/settings,
   monitoring and audit.
6. **Integration tests:** run each feature and restart-persistence scenario against
   a disposable PostgreSQL database.
7. **Cutover:** backup, maintenance window, importer, verification, tests, service
   switch. Keep the previous build and `app_state` for rollback.

## Definition of done

The refactor is not complete until all `db.*`, `loadDB()`, `saveDB()` and
whole-state save scheduling have been removed from runtime paths; reconciliation
reports zero unexplained differences; integration tests pass; and rollback has
been rehearsed. Presence of relational tables alone is not a completed migration.
