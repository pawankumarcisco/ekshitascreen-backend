# Legacy state migration baseline

Source: user-supplied legacy `app_state` JSON snapshot.

The source file contains authentication hashes and operational identifiers. It is
not copied into this repository, and this report intentionally excludes record
values and secrets.

## Source counts

| Collection | Count |
|---|---:|
| users | 3 |
| devices | 3 |
| activations | 12 |
| screens | 1 |
| screenConfigurations | 1 |
| mediaAssets | 10 |
| playlists | 9 |
| playlistItems | 17 |
| deviceSyncs | 15 |
| heartbeats | 62 |
| auditLogs | 52 |
| layouts | 0 |
| schedules | 0 |
| screenGroups | 0 |
| screenGroupMembers | 0 |
| publishJobs | 0 |
| publishTargets | 0 |
| publishAttempts | 0 |
| publishEvents | 0 |
| playbackSettings | 0 |
| cleanupRuns | 0 |
| generalSettingsDrafts | 0 |
| generalSettingsRevisions | 0 |
| settingsPublications | 0 |
| deviceSettings | 0 |
| deviceCommands | 0 |

## Source referential checks

All populated relationships below have zero orphan records:

- screens to users and devices
- activations to devices
- screen configurations to screens
- media assets to users
- playlists to screens and creator users
- playlist items to playlists and media assets
- device synchronization records to devices
- heartbeats to devices
- audit logs to nullable users and devices

## Import expectations

- Preserve all three existing users and their bcrypt hashes byte-for-byte.
- Preserve all prefixed text identifiers; do not convert them to generated UUIDs.
- Preserve all timestamps exactly as instants (`TIMESTAMPTZ`).
- Preserve historical activation and synchronization state, including incomplete
  records and nullable completion/applied timestamps.
- Do not synthesize rows for the 14 empty collections.
- Destination counts must exactly match the source counts above after import.
- `app_state` remains unchanged and available for rollback.

## Verification gate

Relational cutover is blocked unless the importer reports:

1. exact source/destination count equality for every collection;
2. zero foreign-key orphans;
3. zero duplicate primary IDs;
4. zero invalid timestamps or required identifiers;
5. identical bcrypt hash strings for every imported user;
6. a committed import-run record tied to the source JSON checksum.
