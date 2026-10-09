# Portfolio Analyzer — D1 Recovery Runbook v0.1 (WP-RC01)

**Status:** Offline synthetic rehearsal only. This document does **not** authorize a
Production backup, restore, migration, or deployment. GitHub Issue #41 is the scope
authority; PR #28's squash commit `d866b66ab8a2087a1cdd5fec983a6a78fa50b813`
is the baseline.

## 1. Authority and threat model

The canonical transaction and valuation records live in **Cloudflare D1**.
Browser IndexedDB is a convenience cache, never an independent full backup.
ACTIVE/ARCHIVED Dataset versions and STALE lineage protect accounting history
but do not rescue a deleted/corrupted **database**.

Recovery must preserve **the entire application data graph**, including users,
transaction datasets/transactions (stable `transaction_id`), portfolio state and
settings, valuation snapshots/marks/state and transaction Revision bindings,
market runs/instruments/state, and MCP/scheduled-refresh audit tables.
Audit logs about *data changes* are still a separate requirement and have not
been implemented by this drill.

Incident priorities: restrict destructive access, stop writes, record incident
UTC time / affected environment / current migration version, then identify a
verified restoration source. Never try a destructive Production restore first.

## 2. Cloudflare's built-in Time Travel: useful, not sufficient alone

Cloudflare D1 Time Travel is automatically available to databases using the
current storage subsystem; the applicable recovery history is **7 days on
Workers Free** and **30 days on Workers Paid**. Restore/bookmark actions can
mutate the selected database. Check the actual Workers plan, D1 storage type,
retention and available bookmark **before relying on them**. Do not assume a
particular plan or retention applies to this account.

Official documentation:
- https://developers.cloudflare.com/d1/reference/time-travel/
- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/d1/best-practices/import-export-data/

Time Travel is **not** a durable off-account backup. A bad migration or write
discovered after the retention window, credential compromise, or loss of the
account can defeat reliance on Time Travel alone. Recovery from SQL requires
a **new, isolated database** and verification before any production cutover.

## 3. Execute the zero-cloud synthetic rehearsal

Requires Python 3.10+ with standard-library `sqlite3` enabled. From the repository
root, with no Cloudflare credentials:

```sh
python3 scripts/recovery/offline_drill.py --scenario populated
python3 scripts/recovery/offline_drill.py --scenario empty
python3 -m unittest discover -s tests/recovery -p 'test_*.py' -v
```

The CLI creates a temporary SQLite database from **all current checked-in
migrations**, populates only synthetic rows, exports SQL and a SHA-256
manifest, restores into a **fresh, absent** SQLite file, verifies every
application table, schema hash, row hashes, Revision state, SQLite integrity
and foreign keys, then removes all ephemeral evidence on completion.

For a *human-inspectable synthetic-only* manifest, first create a private
folder **outside the repository**:

```sh
mkdir -p "$HOME/.portfolio-recovery-private"
chmod 700 "$HOME/.portfolio-recovery-private"
python3 scripts/recovery/offline_drill.py --scenario populated \
  --output-dir "$HOME/.portfolio-recovery-private/wp-rc01-fixture"
```

The output directory must **not exist yet**. The script creates it with mode
0700 and writes `synthetic-backup.sql` and `synthetic-manifest.json` at
0600. The manifest has UTC timestamp, source marker
`LOCAL_SYNTHETIC_ONLY`, the SQL SHA-256, per-migration SHA-256, schema hash,
each table's count/content hash, and portfolio/valuation/market revisions.
Do not post the SQL file, even though this rehearsal contains synthetic rows:
it normalizes a workflow in which future backups will contain real records.
The CLI has **no Cloudflare access, remote DB selector or write endpoint**.

**Pass condition:** 38-file existing portfolio test suite remains unaffected,
plus all offline recovery tests pass. No real data, D1 reads/writes, new Cloudflare
resources, Staging deployment, or Production deployment are part of WP-RC01.

## 4. What a future authorized Production backup would entail (DO NOT RUN NOW)

This is an architecture and safety checklist, *not* an action plan already
approved:

1. Confirm correct D1 ID, Workers plan/Time Travel status, UTC snapshot time,
   latest `main` SHA, relevant schema migrations and read-only permissions.
   Arrange maintenance/write consistency as needed.
2. Use a least-privilege dedicated credential in Secret storage; do not paste
   credentials into chat, GitHub issues, CI artifacts or shell history.
3. Under explicit owner authorization, export a **full** D1 SQL dump to a
   private encrypted destination, e.g. via Wrangler's documented
   `d1 export <EXACT_DATABASE_NAME> --remote --output=<PRIVATE_PATH>`.
   **Never default to `portfolio-analyzer-production`** in executable scripts;
   have the operator verify the exact binding, tenant, and environment.
4. Hash the SQL, record UTC capture time, immutable source ID/schema version,
   all required table counts and integrity evidence. Encrypt at rest (for
   example via an approved encrypted volume / reviewed encryption tool),
   test decryptability, and retain access/recovery keys separately.
5. Restore only into a newly-created, isolated and explicitly authorized
   scratch environment, **never existing Staging or Production**. Verify
   schema, rows, relationships, statuses and financial lineage; perform
   authenticated functional smoke tests without exposing personal holdings.
6. Record evidence of successful independent recovery. Then define RPO
   (maximum acceptable missing recent transactions) and RTO (maximum restore
   time), retention, periodic verification and off-account backup location.
   Auto-scheduling or R2 use requires its own cost/security review and approval.

Cloudflare documents SQL import via Wrangler `d1 execute --file`; that is a
database-modifying command. It is **intentionally not automated** here.
Time Travel `restore` is also mutating and is never used by the drill.

## 5. Fail-closed acceptance and traceability

| Condition | Expected behavior |
| --- | --- |
| 2 revisions of a synthetic transaction | Corrected `stable-buy` is preserved across datasets |
| Two economically identical trades | Two distinct `transaction_id` values remain |
| Old active valuation after transaction v2 | Valuation remains bound to transaction v1 (STALE) |
| All migration-created tables | Schema and complete row hashes match fresh restore |
| Corrupted or absent SQL, manifest | Restore rejected; no target created |
| Changed schema/migration digest | Restore rejected |
| Existing target | No overwrite, original bytes unchanged |
| SQL execution error/partial import | No target published; temporary file removed |
| Output inside public Git repository | Rejected before writing |
| Production/Staging-looking output path | Rejected before writing |

**Scope boundaries:** no new data mutation endpoints, API schemas, SQL
access via MCP, changes to transactions, market prices, FX, XIRR, TWR,
`security_cash_flows`, or Cloudflare Access rules. A green CI alone is not
human acceptance; verify reproducible artifacts and source lineage.

**Human acceptance:** review this Runbook, confirm the exact merge-base/main
SHA, inspect the *synthetic* manifest and CI evidence, ensure no backup entered
the public repository/logs, and verify all negative tests. Record results and
independent review under Issue #41 / its Draft PR. Until those gates pass,
WP-RC01 status remains HOLD.

**Following WP (separately scoped):** a user-facing normalized CSV/JSON export,
safe ARCHIVED revision restore, encrypted actual-environment backup schedule,
explicit write audit, branch protection, and Production permission checks.
Do not conflate synthetic drill PASS with a Production readiness PASS.
