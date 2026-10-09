"""Offline, synthetic-only goldens and fail-closed recovery regressions."""

from __future__ import annotations

import json
from contextlib import closing
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

from scripts.recovery.offline_drill import (
    EXPECTED_TABLES,
    MANIFEST_NAME,
    ROOT,
    SQL_NAME,
    RecoveryGateError,
    create_synthetic_database,
    database_fingerprint,
    export_synthetic,
    open_existing_readonly,
    restore_validated,
    run_synthetic_drill,
    sha256,
)


class OfflineRecoveryDrillTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wp-rc01-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "synthetic.sqlite"
        self.backup = self.root / "private-evidence"
        self.target = self.root / "fresh-restore.sqlite"

    def make_backup(self, scenario="populated"):
        create_synthetic_database(self.source, scenario)
        return export_synthetic(self.source, self.backup)

    def test_golden_roundtrip_preserves_all_tables_revisions_and_schema(self):
        manifest = self.make_backup()
        actual = restore_validated(self.backup, self.target)
        self.assertEqual(actual["schema_sha256"], manifest["schema_sha256"])
        self.assertEqual(actual["tables"], manifest["tables"])
        self.assertEqual(actual["revisions"], manifest["revisions"])
        self.assertTrue(EXPECTED_TABLES.issubset({x["table"] for x in actual["tables"]}))
        self.assertEqual(len(actual["tables"]), len(EXPECTED_TABLES))
        self.assertEqual(manifest["environment"], "LOCAL_SYNTHETIC_ONLY")
        self.assertEqual(manifest["format"], "portfolio-wp-rc01-synthetic-v0.1")
        self.assertEqual(manifest["sql_sha256"], sha256((self.backup / SQL_NAME).read_bytes()))
        self.assertGreaterEqual(len(manifest["migrations"]), 8)
        if os.name == "posix":
            self.assertEqual((self.backup / SQL_NAME).stat().st_mode & 0o077, 0)
            self.assertEqual((self.backup / MANIFEST_NAME).stat().st_mode & 0o077, 0)
            self.assertEqual(self.backup.stat().st_mode & 0o077, 0)
        with closing(open_existing_readonly(self.target)) as db:
            self.assertEqual(database_fingerprint(db), actual)
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
            # The archived identity was deliberately reused for a corrected trade.
            self.assertEqual(db.execute(
                "SELECT COUNT(*) FROM transactions WHERE transaction_id='stable-buy'"
            ).fetchone()[0], 2)
            # Two economically identical rows are distinct logical transactions.
            duplicates = db.execute(
                "SELECT transaction_id FROM transactions "
                "WHERE dataset_id='ds-v2' AND ticker='0050' ORDER BY source_row_number"
            ).fetchall()
            self.assertEqual(duplicates, [("separate-dup-a",), ("separate-dup-b",)])
            state = db.execute(
                "SELECT active_dataset_id,cloud_revision FROM portfolio_state"
            ).fetchone()
            self.assertEqual(state, ("ds-v2", 2))
            snapshot = db.execute(
                "SELECT transaction_dataset_id,transaction_revision FROM valuation_snapshots "
                "WHERE status='ACTIVE'"
            ).fetchone()
            self.assertEqual(snapshot, ("ds-v1", 1))
            # This bound snapshot is STALE versus the current transaction revision.
            self.assertNotEqual(snapshot[1], state[1])
            self.assertEqual(db.execute(
                "SELECT COUNT(*) FROM market_data_instruments"
            ).fetchone()[0], 1)
            self.assertEqual(db.execute(
                "SELECT COUNT(*) FROM mcp_audit_log"
            ).fetchone()[0], 1)
            self.assertEqual(db.execute(
                "SELECT COUNT(*) FROM market_refresh_jobs"
            ).fetchone()[0], 1)

    def test_empty_database_roundtrip_retains_full_migrated_schema(self):
        manifest = self.make_backup("empty")
        result = restore_validated(self.backup, self.target)
        self.assertEqual(result, {k: manifest[k] for k in
                                  ("schema_sha256", "tables", "revisions")})
        self.assertTrue(all(entry["rows"] == 0 for entry in result["tables"]))
        with open_existing_readonly(self.target) as db:
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_cli_entrypoint_is_ephemeral_and_never_needs_cloud(self):
        self.assertEqual(run_synthetic_drill("populated")["outcome"], "PASS")
        self.assertEqual(run_synthetic_drill("empty")["outcome"], "PASS")

    def test_corrupted_sql_hash_rejected_without_target(self):
        self.make_backup()
        with (self.backup / SQL_NAME).open("ab") as stream:
            stream.write(b"\n-- damaged export\n")
        with self.assertRaisesRegex(RecoveryGateError, "SHA-256 mismatch"):
            restore_validated(self.backup, self.target)
        self.assertFalse(self.target.exists())

    def test_missing_export_rejected_without_target(self):
        self.make_backup()
        (self.backup / SQL_NAME).unlink()
        with self.assertRaisesRegex(RecoveryGateError, "missing"):
            restore_validated(self.backup, self.target)
        self.assertFalse(self.target.exists())

    def test_missing_manifest_rejected_without_target(self):
        self.make_backup()
        (self.backup / MANIFEST_NAME).unlink()
        with self.assertRaisesRegex(RecoveryGateError, "missing"):
            restore_validated(self.backup, self.target)
        self.assertFalse(self.target.exists())

    def test_refuse_export_of_non_synthetic_user_data(self):
        create_synthetic_database(self.source)
        with closing(sqlite3.connect(self.source)) as db:
            db.execute(
                "UPDATE users SET email=? WHERE id='usr_synthetic_fixture'",
                ("not-a-fixture@example.com",),
            )
            db.commit()
        with self.assertRaisesRegex(RecoveryGateError, "Non-synthetic"):
            export_synthetic(self.source, self.backup)
        self.assertFalse(self.backup.exists())

    def test_existing_target_never_overwritten(self):
        self.make_backup()
        self.target.write_bytes(b"already-a-database-do-not-touch")
        with self.assertRaisesRegex(RecoveryGateError, "already exists"):
            restore_validated(self.backup, self.target)
        self.assertEqual(self.target.read_bytes(), b"already-a-database-do-not-touch")

    def test_tampered_row_count_manifest_rejected_without_target(self):
        self.make_backup()
        path = self.backup / MANIFEST_NAME
        data = json.loads(path.read_text("utf-8"))
        data["tables"][0]["rows"] += 1
        path.write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaisesRegex(RecoveryGateError, "differ"):
            restore_validated(self.backup, self.target)
        self.assertFalse(self.target.exists())
        self.assertFalse(list(self.root.glob(".recovery-partial-*")))

    def test_migration_hash_mismatch_rejected(self):
        self.make_backup()
        path = self.backup / MANIFEST_NAME
        data = json.loads(path.read_text("utf-8"))
        data["migrations"][0]["sha256"] = "0" * 64
        path.write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaisesRegex(RecoveryGateError, "Migration lineage"):
            restore_validated(self.backup, self.target)
        self.assertFalse(self.target.exists())

    def test_broken_sql_with_recomputed_checksum_remains_non_destructive(self):
        self.make_backup()
        sql_path = self.backup / SQL_NAME
        sql = sql_path.read_bytes() + b"\nTHIS IS NOT SQL;\n"
        sql_path.write_bytes(sql)
        manifest_path = self.backup / MANIFEST_NAME
        data = json.loads(manifest_path.read_text("utf-8"))
        data["sql_sha256"] = sha256(sql)
        manifest_path.write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaises(sqlite3.Error):
            restore_validated(self.backup, self.target)
        self.assertFalse(self.target.exists())
        self.assertFalse(list(self.root.glob(".recovery-partial-*")))

    def test_never_store_evidence_inside_public_repository(self):
        create_synthetic_database(self.source)
        with self.assertRaisesRegex(RecoveryGateError, "inside the repository"):
            export_synthetic(self.source, ROOT / "wp-rc01-should-not-exist")
        self.assertFalse((ROOT / "wp-rc01-should-not-exist").exists())

    def test_reject_staging_and_production_named_destinations(self):
        create_synthetic_database(self.source)
        for suffix in ("production", "staging"):
            with self.subTest(suffix=suffix):
                p = self.root / f"portfolio-{suffix}-backup"
                with self.assertRaisesRegex(RecoveryGateError, "deployed environment"):
                    export_synthetic(self.source, p)
                self.assertFalse(p.exists())

    def test_preexisting_source_is_not_overwritten(self):
        self.source.write_bytes(b"original-do-not-touch")
        with self.assertRaisesRegex(RecoveryGateError, "existing source"):
            create_synthetic_database(self.source)
        self.assertEqual(self.source.read_bytes(), b"original-do-not-touch")


if __name__ == "__main__":
    unittest.main()
