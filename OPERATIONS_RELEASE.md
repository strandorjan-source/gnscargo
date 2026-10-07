# GNS Cargo: operations and release controls

## Delivered areas

Atomic `save_cargo_order` saves the order and its complete stop snapshot in one PostgreSQL transaction. New requests have idempotency UUIDs. Edits pass a server-maintained revision. Stop, CMR, Capacity and invoice changes invalidate stale editor snapshots. The creator snapshot is immutable; responsibility is a separate active staff identity.

The internal follow-up modal includes dispatcher assignment, manually recorded transport status, append-only notes, incidents, private documents and append-only database-generated history. Cancellation requires a reason, retains the record and removes it from unbilled/billing report selections. It does not automatically notify carriers or free Capacity reservations. Staff must do those operational actions separately.

The work dashboard has Norwegian-date today/tomorrow, all, delivered-unbilled and cancelled filters, my/unassigned/selected dispatcher filters, search and exception-first ordering. It flags missing vehicle/carrier, destination, customer reference, prices, responsible person, unresolved incidents and missing POD/CMR for delivered orders. Unknown prices are not treated as known zeroes in these checks. No claim of electronic carrier acceptance is made: that separate feature is not connected.

Documents use a private bucket. Staff create explicit, expiring invitations for approved carrier accounts. An invitation UUID alone is insufficient: the logged-in user must match the recipient and still have active approval. Carriers cannot read orders, prices, notes, incidents or history, or other carriers' uploads. Carrier access does not depend on an active Capacity reservation after delivery. Uploads use random immutable paths, no overwrite, file size/type restrictions, finalization after Storage existence/size/type validation, and SHA-256 verification on download. Files are not malware-scanned: do not treat these checks as antivirus.

## Release gate

`npm ci --prefix tests --ignore-scripts` installs locked test dependencies.
`node scripts/release-check.cjs` runs required price, report, admin, order/CMR/privacy/Capacity-handoff and operations DOM tests. A failure aborts the build. Only an explicit application allowlist is copied into `public/`; SQL, tests, runbooks, backup manifests and dependencies are not published. jsPDF 4.2.1 is pinned and copied from the locked dependency to the public vendor directory.

The independent `tests/capacity-booking.cjs` React harness requires the separate Capacity repository and its dependencies. It is retained, but not silently claimed as part of this single-repository build gate. Cargo/Capacity handoff and PostgreSQL integration are covered separately.

SQL tests under `supabase/tests` use synthetic users and rolled-back transactions. They must be run with the authenticated Supabase management connection, not by putting service credentials in browser code, test artifacts or GitHub logs. Storage SQL tests create synthetic metadata only; they do not prove an actual network upload/download has completed.

## Backup and recovery: incomplete until an actual isolated restoration passes

**Production backup configuration and a real database-and-files restoration have not been verified by this change. Do not record them as completed. No paid recovery project or PITR add-on has been enabled.**

The existing Supabase connector provides schema/test operations but not a backup listing/restoration endpoint. Before signing off recovery readiness, the project owner must verify available scheduled backup/PITR restore points and retention in Supabase. Database backups do not include actual Storage object bytes. Copy `cargo-order-documents` files separately to an encrypted, access-controlled destination outside the production project, including withdrawn files that must be retained. Do not store business data backups in this public repository or public CI artifacts.

For a recovery drill:

1. Record the backup timestamp, covered period, responsible operator and intended isolated recovery project. Verify the target is NOT `lpovhfipxoeqqnfnipia`, and disable outbound email/EDI/webhooks in the recovery environment. Do not restore over production to test a backup.
2. Restore the database to that isolated project using the platform's supported backup restore procedure. Restore Storage object bytes separately while keeping the original paths. Restore/test RLS, functions, grants, authentication provider settings and sequence state. Database and file backups must have a consistent cutoff; identify any missing recent files explicitly.
3. Export a document metadata manifest `{ "documents": [{ "storage_path": "order-uuid/document-uuid", "byte_size": 123, "sha256": "..." }] }`. Place the copied bytes under `files/<storage_path>` and run `python scripts/verify_document_backup.py <backup-folder>`. This validates bytes, not database completeness or credentials.
4. Compare order/stops/notes/incidents/history/document counts and pricing sums against the cutoff; verify foreign keys and linked Capacity orders; test a restored CMR/POD download; repeat staff/carrier A/carrier B/disabled-user checks; record elapsed restore time and the recoverable-data cutoff. Only then mark the recovery drill PASS.

The included backup-verifier test uses synthetic files and intentionally corrupted copies. A passing verifier unit test is not a real recovery drill and is not a scheduled backup service.

Official references checked 7 October 2026:
https://supabase.com/docs/guides/platform/backups
https://supabase.com/docs/guides/storage/security/access-control
https://github.com/parallax/jsPDF/releases/tag/v4.2.1
https://vercel.com/docs/deployment-checks
