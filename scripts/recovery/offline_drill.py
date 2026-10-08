#!/usr/bin/env python3
"""WP-RC01: offline SQLite recovery drill; uses only synthetic data.

This deliberately has NO Cloudflare credentials, network operations, or remote
database selector. It is NOT a Production backup or restoration command.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import sqlite3
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FORMAT = "portfolio-wp-rc01-synthetic-v0.1"
SQL_NAME = "synthetic-backup.sql"
MANIFEST_NAME = "synthetic-manifest.json"
EXPECTED_TABLES = frozenset({
    "users", "portfolio_datasets", "portfolio_state", "transactions",
    "portfolio_settings", "valuation_snapshots", "valuation_state",
    "valuation_marks", "market_data_runs", "market_state",
    "activation_guards", "market_data_instruments", "mcp_audit_log",
    "market_refresh_jobs",
})


class RecoveryGateError(RuntimeError):
    """The offline recovery exercise refused to continue."""


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    if isinstance(value, bytes):
        return {"blob_base64": base64.b64encode(value).decode("ascii")}
    if isinstance(value, tuple):
        return [encoded(x) for x in value]
    return value


def canonical_hash(value) -> str:
    return sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                             separators=(",", ":")).encode("utf-8"))


def migration_manifest(root: Path = ROOT) -> list[dict[str, str]]:
    paths = sorted((root / "migrations").glob("[0-9][0-9][0-9][0-9]_*.sql"))
    if len(paths) < 8 or [p.name[:4] for p in paths[:8]] != [
        f"{i:04d}" for i in range(1, 9)
    ]:
        raise RecoveryGateError("Expected migration series 0001–0008 is unavailable")
    return [{"file": p.name, "sha256": sha256(p.read_bytes())} for p in paths]


def open_existing_readonly(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise RecoveryGateError("Source database is missing")
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    connection.execute("PRAGMA query_only=ON")
    return connection


def names(connection: sqlite3.Connection) -> list[str]:
    rows = connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()
    result = [row[0] for row in rows]
    if not EXPECTED_TABLES.issubset(result):
        raise RecoveryGateError("Database is missing required application tables")
    return result


def database_fingerprint(connection: sqlite3.Connection) -> dict:
    table_names = names(connection)
    schema = connection.execute(
        "SELECT type, name, tbl_name, sql FROM sqlite_master "
        "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    ).fetchall()
    tables = []
    for name in table_names:
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            raise RecoveryGateError("Unsupported table identifier")
        rows = connection.execute(f'SELECT * FROM "{name}"').fetchall()
        ordered = sorted(
            json.dumps(encoded(tuple(row)), sort_keys=True, ensure_ascii=False,
                       separators=(",", ":"))
            for row in rows
        )
        tables.append({
            "table": name,
            "rows": len(rows),
            "sha256": canonical_hash(ordered),
        })
    revisions = {
        "transaction": connection.execute(
            "SELECT cloud_revision FROM portfolio_state ORDER BY user_id"
        ).fetchall(),
        "valuation": connection.execute(
            "SELECT valuation_revision FROM valuation_state ORDER BY user_id"
        ).fetchall(),
        "market": connection.execute(
            "SELECT market_revision FROM market_state ORDER BY user_id"
        ).fetchall(),
    }
    return {
        "schema_sha256": canonical_hash([encoded(tuple(row)) for row in schema]),
        "tables": tables,
        "revisions": revisions,
    }


def create_synthetic_database(path: Path, scenario: str = "populated",
                              root: Path = ROOT) -> None:
    """Create a new disposable SQLite DB using every checked-in migration."""
    if scenario not in ("populated", "empty"):
        raise RecoveryGateError("Unknown synthetic scenario")
    if path.exists():
        raise RecoveryGateError("Will not overwrite an existing source")
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as db:
        db.execute("PRAGMA foreign_keys=ON")
        for item in migration_manifest(root):
            db.executescript((root / "migrations" / item["file"]).read_text("utf-8"))
        if scenario == "populated":
            insert_synthetic_rows(db)
        if db.execute("PRAGMA foreign_key_check").fetchall():
            raise RecoveryGateError("Invalid synthetic foreign keys")
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RecoveryGateError("Synthetic database integrity failed")
        db.commit()


def insert_synthetic_rows(db: sqlite3.Connection) -> None:
    """Synthetic only: two transaction revisions and a deliberately stale mark."""
    u = "usr_synthetic_fixture"
    db.execute("INSERT INTO users (id,email) VALUES (?,?)", (u, "fixture@invalid.example"))
    db.executemany(
        "INSERT INTO portfolio_datasets "
        "(id,user_id,revision,status,filename,file_hash,parser_version,row_count,earliest_date,latest_date) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)", [
            ("ds-v1", u, 1, "ARCHIVED", "synthetic-v1.csv", "fixture-file-1",
             "parser-v1", 1, "2026-01-02", "2026-01-02"),
            ("ds-v2", u, 2, "ACTIVE", "synthetic-v2.csv", "fixture-file-2",
             "parser-v1", 3, "2026-01-02", "2026-01-03"),
        ],
    )
    transaction_columns = (
        "id,dataset_id,user_id,transaction_id,source_row_number,trade_date,"
        "transaction_type,ticker,currency,quantity,price,amount_foreign,fx_rate,fee,row_hash"
    )
    db.executemany(
        f"INSERT INTO transactions ({transaction_columns}) VALUES ({','.join('?' for _ in range(15))})",
        [
            ("row-old", "ds-v1", u, "stable-buy", 1, "2026-01-02",
             "SECURITY", "2330", "TWD", 10, 100, 1000, 1, 0, "row-hash-old"),
            ("row-new", "ds-v2", u, "stable-buy", 1, "2026-01-02",
             "SECURITY", "2330", "TWD", 12, 110, 1320, 1, 0, "row-hash-new"),
            ("row-dup-a", "ds-v2", u, "separate-dup-a", 2, "2026-01-03",
             "SECURITY", "0050", "TWD", 1, 50, 50, 1, 0, "row-hash-dup-a"),
            ("row-dup-b", "ds-v2", u, "separate-dup-b", 3, "2026-01-03",
             "SECURITY", "0050", "TWD", 1, 50, 50, 1, 0, "row-hash-dup-b"),
        ],
    )
    db.execute(
        "INSERT INTO portfolio_state (user_id,active_dataset_id,cloud_revision) VALUES (?,?,?)",
        (u, "ds-v2", 2),
    )
    db.execute("INSERT INTO portfolio_settings (user_id) VALUES (?)", (u,))
    db.execute(
        "INSERT INTO valuation_snapshots "
        "(id,user_id,revision,status,valuation_date,filename,file_hash,parser_version,"
        "mark_count,transaction_dataset_id,transaction_revision) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        ("valuation-v1", u, 1, "ACTIVE", "2026-01-03", "marks.csv", "fixture-marks",
         "valuation-v1", 1, "ds-v1", 1),
    )
    db.execute(
        "INSERT INTO valuation_state (user_id,active_snapshot_id,valuation_revision) "
        "VALUES (?,?,?)", (u, "valuation-v1", 1),
    )
    db.execute(
        "INSERT INTO valuation_marks "
        "(id,snapshot_id,user_id,source_row_number,mark_date,mark_type,ticker,"
        "currency,value,source,row_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        ("mark-1", "valuation-v1", u, 1, "2026-01-03", "PRICE",
         "2330", "TWD", 120, "SYNTHETIC", "mark-row-hash"),
    )
    db.execute(
        "INSERT INTO market_data_runs "
        "(id,user_id,revision,status,provider,data_version,transaction_dataset_id,"
        "transaction_revision,instrument_count,bar_count,fetched_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        ("market-v1", u, 1, "ACTIVE", "SYNTHETIC", "synthetic-v1", "ds-v1",
         1, 1, 1, "2026-01-03T12:00:00Z"),
    )
    db.execute(
        "INSERT INTO market_state (user_id,active_run_id,market_revision) "
        "VALUES (?,?,?)", (u, "market-v1", 1),
    )
    db.execute(
        "INSERT INTO market_data_instruments "
        "(id,run_id,user_id,instrument_type,ticker,currency,provider_symbol,"
        "exchange_timezone,bar_count,earliest_bar_date,latest_bar_date,"
        "latest_raw_close,series_hash,bars_json) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ("series-1", "market-v1", u, "SECURITY", "2330", "TWD", "2330.TW",
         "Asia/Taipei", 1, "2026-01-03", "2026-01-03", 120,
         "synthetic-series-hash", '[{"date":"2026-01-03","rawClose":120}]'),
    )
    db.execute(
        "INSERT INTO mcp_audit_log "
        "(id,request_id,user_id,authenticated_email,tool,target,success,"
        "duration_ms,returned_row_count) VALUES (?,?,?,?,?,?,?,?,?)",
        ("audit-1", "fixture-request", u, "fixture@invalid.example",
         "query_data", "portfolio_snapshot", 1, 12, 1),
    )
    db.execute(
        "INSERT INTO market_refresh_jobs "
        "(id,user_id,trigger_type,scheduled_for,status,attempt_count,"
        "market_revision_before,market_revision_after,valuation_revision_before,"
        "valuation_revision_after) VALUES (?,?,?,?,?,?,?,?,?,?)",
        ("refresh-1", u, "SCHEDULED", "2026-01-04", "SUCCEEDED",
         1, 0, 1, 0, 1),
    )


def private_output_directory(directory: Path, root: Path = ROOT) -> None:
    target = directory.resolve()
    repo = root.resolve()
    if target == repo or repo in target.parents:
        raise RecoveryGateError("Refusing to save a SQL backup inside the repository")
    if any(re.search(r"(?:^|[-_])(?:production|staging)(?:$|[-_])",
                     p.lower()) for p in target.parts):
        raise RecoveryGateError("Destination looks like a deployed environment")
    if directory.exists():
        raise RecoveryGateError("Evidence folder already exists; refuse to overwrite")
    directory.mkdir(mode=0o700, parents=False)


def write_private_file(path: Path, content: bytes) -> None:
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
    except Exception:
        path.unlink(missing_ok=True)
        raise


def export_synthetic(source: Path, evidence: Path, root: Path = ROOT) -> dict:
    """Never accepts a Cloudflare endpoint; source is a local SQLite file."""
    private_output_directory(evidence, root)
    try:
        with open_existing_readonly(source) as db:
            fingerprint = database_fingerprint(db)
            dump = ("\n".join(db.iterdump()) + "\n").encode("utf-8")
        manifest = {
            "format": FORMAT,
            "environment": "LOCAL_SYNTHETIC_ONLY",
            "created_at_utc": datetime.now(timezone.utc).isoformat(),
            "migrations": migration_manifest(root),
            "sql_file": SQL_NAME,
            "sql_sha256": sha256(dump),
            **fingerprint,
        }
        write_private_file(evidence / SQL_NAME, dump)
        write_private_file(evidence / MANIFEST_NAME,
                           (json.dumps(manifest, sort_keys=True, indent=2) + "\n").encode("utf-8"))
        return manifest
    except Exception:
        # Reject partial evidence rather than mistaking it for a valid backup.
        for f in (evidence / SQL_NAME, evidence / MANIFEST_NAME):
            f.unlink(missing_ok=True)
        evidence.rmdir()
        raise


def restore_validated(evidence: Path, target: Path, root: Path = ROOT) -> dict:
    """Restore ONLY into an absent local SQLite path, never a remote D1 database."""
    if target.exists():
        raise RecoveryGateError("Recovery target already exists; refusing overwrite")
    if not target.parent.is_dir():
        raise RecoveryGateError("Recovery target parent must already exist")
    if target.parent.resolve() == root.resolve() or root.resolve() in target.parent.resolve().parents:
        raise RecoveryGateError("Recovery target must be outside repository")
    manifest_path = evidence / MANIFEST_NAME
    sql_path = evidence / SQL_NAME
    if not manifest_path.is_file() or not sql_path.is_file():
        raise RecoveryGateError("Backup SQL or manifest is missing")
    manifest = json.loads(manifest_path.read_text("utf-8"))
    if (manifest.get("format") != FORMAT or
            manifest.get("environment") != "LOCAL_SYNTHETIC_ONLY" or
            manifest.get("sql_file") != SQL_NAME):
        raise RecoveryGateError("Invalid synthetic recovery manifest")
    if manifest.get("migrations") != migration_manifest(root):
        raise RecoveryGateError("Migration lineage does not match this repository")
    sql = sql_path.read_bytes()
    if sha256(sql) != manifest.get("sql_sha256"):
        raise RecoveryGateError("Backup SHA-256 mismatch")
    # A same-directory temporary file permits an atomic create without replacing target.
    fd, temporary = tempfile.mkstemp(prefix=".recovery-partial-", suffix=".sqlite",
                                    dir=target.parent)
    os.close(fd)
    partial = Path(temporary)
    try:
        with sqlite3.connect(partial) as db:
            db.execute("PRAGMA foreign_keys=OFF")
            db.executescript(sql.decode("utf-8"))
            db.execute("PRAGMA foreign_keys=ON")
            if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise RecoveryGateError("SQLite integrity check failed")
            if db.execute("PRAGMA foreign_key_check").fetchall():
                raise RecoveryGateError("Foreign-key validation failed")
            actual = database_fingerprint(db)
        expected = {key: manifest[key] for key in ("schema_sha256", "tables", "revisions")}
        if actual != expected:
            raise RecoveryGateError("Restored schema, row data, or revisions differ")
        os.link(partial, target)  # Atomic no-overwrite; FileExistsError fails closed.
        return actual
    finally:
        partial.unlink(missing_ok=True)


def run_synthetic_drill(scenario: str = "populated", output_dir: Path | None = None) -> dict:
    # No --source, --remote, --database-name or --credentials switch exists.
    with tempfile.TemporaryDirectory(prefix="portfolio-wp-rc01-") as temp:
        scratch = Path(temp)
        source = scratch / "fixture.sqlite"
        create_synthetic_database(source, scenario)
        evidence = output_dir if output_dir is not None else scratch / "evidence"
        export_synthetic(source, evidence)
        # Never restore into the fixture source or any existing database.
        restored = scratch / "restored.sqlite"
        fingerprint = restore_validated(evidence, restored)
        with open_existing_readonly(restored) as db:
            if database_fingerprint(db) != fingerprint:
                raise RecoveryGateError("Final read-only verification failed")
        return {
            "scenario": scenario,
            "outcome": "PASS",
            "table_count": len(fingerprint["tables"]),
            "row_count": sum(x["rows"] for x in fingerprint["tables"]),
            "evidence": "ephemeral" if output_dir is None else str(output_dir),
        }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", choices=("empty", "populated"), default="populated")
    parser.add_argument("--output-dir", type=Path, default=None,
                        help="New private directory OUTSIDE the repository; synthetic evidence only")
    args = parser.parse_args()
    try:
        result = run_synthetic_drill(args.scenario, args.output_dir)
    except (RecoveryGateError, sqlite3.Error, OSError, ValueError, KeyError, UnicodeError) as error:
        # Never print SQL statements, rows, absolute file contents, or credentials.
        parser.exit(1, f"WP-RC01: FAIL ({type(error).__name__})\n")
    print(f"WP-RC01: PASS ({result['scenario']}, "
          f"{result['table_count']} tables, {result['row_count']} synthetic rows)")


if __name__ == "__main__":
    main()
