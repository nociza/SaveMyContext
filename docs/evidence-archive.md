# Cold evidence archive

SMC keeps normalized conversations, messages, projects, history, and search on
local SQLite. An optional archive moves browser `sync_events.raw_capture` and
`chat_messages.raw_payload` into immutable gzip-compressed, optionally age-encrypted JSON
packs. These packs are evidence, not a second search index. Quarantined captures
stay inline for review and count against the admission limit. Legacy standalone
`source_captures` are not migrated by this browser-evidence worker.

## Durability and availability

1. Ingestion atomically commits normalized state and raw JSON in SQLite.
2. The background worker selects a bounded batch without holding a write lock.
3. It canonicalizes JSON, deduplicates by SHA-256, compresses, and optionally encrypts in
   memory. The archive preserves JSON values, not original HTTP wire formatting.
4. The receiver verifies the mounted volume UUID and stored-byte checksum, writes
   a private temporary file, fsyncs, and atomically links without overwriting.
5. The sender independently reads back, decodes, and verifies the complete pack.
6. One SQLite transaction records the catalog and replaces only matching raw
   values with references. A concurrent edit is never cleared.

Raw columns are the durable queue; there are no extra plaintext spool files.
The default admission cap is 256 MiB of inline browser/quarantine evidence.
When full, the entire new capture rolls back with HTTP 503 / Retry-After, so a
client must retry rather than assume success. NAS outages do not affect normal
reading/search; full context exports explicitly fail with 503 when required
evidence is unavailable. No evidence is silently dropped. A crash after upload
can leave a harmless unreferenced encrypted pack; automatic garbage collection
is deliberately absent.

## Configuration

Set `SAVEMYCONTEXT_EVIDENCE_CONFIG` to a protected JSON file readable by the
application user. This feature requires workspace mode and local SQLite.

```json
{
  "encryption": "age",
  "age": "/usr/bin/age",
  "recipient": "<dedicated archive age public recipient>",
  "identity": "/protected/archive.agekey",
  "transport_command": ["/usr/bin/ssh", "-F", "/protected/archive.ssh", "smc-evidence", "smc-evidence-v1"]
}
```

Encryption remains the default for existing installations. For an explicitly
unencrypted archive, set `"encryption": "none"`; no age binary, recipient, or
identity is needed for new writes or plaintext reads. Packs are then ordinary
`.json.gz` files readable with gzip/JSON tools. Anyone with file access can read
them. Private permissions and SSH protect access/transport, not data at rest.
Unknown encryption modes are rejected, never silently downgraded.

Receivers support both `.json.gz.age` and `.json.gz`, return the encoding, and
verify stored-byte hashes. Install the encoding-aware receiver before enabling
plaintext writes. Mixed archives retain their old identity until migration ends.

## Explicit conversion to plaintext

Take a consistent SQLite checkpoint and inventory **all** encrypted pack filenames
under the verified archive root, including orphan/canary packs. Save their 64-character
hash stems as a private JSON array. Use a configuration with `encryption=none`
and the old identity temporarily available. Preview, then explicitly apply:

```sh
python -m app.evidence.migrate_plaintext --database /private/workspace.sqlite \
  --config /private/archive.json --pack-list /private/encrypted-packs.json
# Repeat with --apply after reviewing the bounded inventory.
```

Conversion independently reads/decrypts each old pack and verifies its gzip
replacement before transactionally updating only `evidence_objects.pack_hash`.
References, payload hashes, timestamps, and source history do not change. A
concurrent catalog edit aborts that pack; retries are safe and deterministic.
Encrypted files are never deleted. Once every catalog pack has been verified
with a key-free config, remove `identity` and `recipient` from active config.
Retain recovery material for historical encrypted snapshots; conversion does
not rewrite historical Git backups. Roll back only to mixed-format-aware code
after plaintext catalog pointers exist.

Use a dedicated SSH key restricted to the fixed receiver command, without
forwarding, shell, PTY, or other capabilities. Pin the receiver host key. The
receiver is the stdlib-only `app/evidence/receiver.py` and needs a fixed config:

```json
{
  "mount": "/Volumes/Example",
  "volume_uuid": "<verified volume UUID>",
  "relative_root": "Data/Archives/SaveMyContext"
}
```

Provision the root explicitly with owner-only access. The receiver will not
create a missing mount/root, follow archive-root symlinks, overwrite objects,
execute caller commands, or delete files. The decryption identity is available
to SMC for explicit evidence reads; this is at-rest protection, not protection
against a compromised application host. Keep an independently recoverable copy
of that identity in protected operator storage. Never commit it or captures.

## Recovery and operations

Fleet-managed storage backups cover the archive; SMC adds no competing backup
schedule. A complete recovery requires the SQLite backup and referenced packs,
plus the archive identity only when those packs are encrypted. Restore SQLite locally, configure a
receiver pointing at the restored archive, and verify full context exports.
The `evidence_objects` table maps content hashes to stored-byte pack hashes. Each
pack also carries source row identifiers/timestamps for provenance.

`python -m app.evidence.worker --batches 1` performs one bounded transfer using
the configured database. The application performs these transfers automatically
(one second between active batches; sixty seconds on idle/failure). Only generic
failure diagnostics are logged, never evidence or command stderr.

Full `/api/v1/context/export/{session_id}` hydrates archived evidence without
writing it back to SQLite. Normal message responses expose `evidence_ref` when
raw payloads have moved. Offline `app.workspace.capture_preview` accepts
`--evidence-config`; a missing archive fails explicitly rather than producing an
incomplete repair preview.

Migration is additive and resumable. Take a SQLite-consistent checkpoint first,
then migrate, validate normalized record digests and archive round trips, and
compact SQLite only in a separate controlled maintenance step. Do not roll back
to code that cannot read references once evidence has moved. Disable the archive
worker with `SAVEMYCONTEXT_EVIDENCE_WORKER=false`, preserving the configuration
and resolver for existing references. Do not
delete old snapshots or unreferenced packs automatically.

Parquet is not needed for opaque raw evidence. A future structured analytics
export can use it independently without changing this archive contract.
