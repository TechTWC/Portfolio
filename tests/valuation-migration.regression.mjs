import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = mkdtempSync(join(tmpdir(), 'valuation-migration-'))
const database = join(directory, 'database.sqlite')
const migration = (name) => readFileSync(join(process.cwd(), 'migrations', name), 'utf8')
const execute = (sql) => execFileSync('sqlite3', ['-batch', '-noheader', database], {
  input: sql,
  encoding: 'utf8',
}).trim()

try {
  execute(`PRAGMA foreign_keys = ON;\n${migration('0001_initial.sql')}\n${migration('0002_valuation_snapshots.sql')}`)
  execute(`
    PRAGMA foreign_keys = ON;
    INSERT INTO users (id, email) VALUES ('user-1', 'user@example.com');
    INSERT INTO portfolio_datasets (
      id, user_id, revision, status, filename, file_hash, parser_version,
      row_count, earliest_date, latest_date, activated_at
    ) VALUES (
      'dataset-0', 'user-1', 5, 'ARCHIVED', 'transactions-v5.csv', 'transactions-v5',
      'parser-v1', 1, '2026-01-01', '2026-01-01', '2026-06-01T00:00:00Z'
    );
    INSERT INTO portfolio_datasets (
      id, user_id, revision, status, filename, file_hash, parser_version,
      row_count, earliest_date, latest_date, activated_at
    ) VALUES (
      'dataset-1', 'user-1', 6, 'ACTIVE', 'transactions.csv', 'transactions-v6',
      'parser-v1', 1, '2026-01-01', '2026-01-01', '2026-07-01T00:00:00Z'
    );
    INSERT INTO portfolio_state (user_id, active_dataset_id, cloud_revision)
      VALUES ('user-1', 'dataset-1', 6);
    INSERT INTO transactions (
      id, dataset_id, user_id, source_row_number, trade_date, transaction_type,
      ticker, currency, quantity, price, amount_foreign, fx_rate, fee, row_hash
    ) VALUES
    (
      'transaction-physical-0', 'dataset-0', 'user-1', 2, '2026-01-01',
      'SECURITY', 'SPY', 'USD', 1, 500, 500, 32, 0, 'transaction-row-1'
    ),
    (
      'transaction-physical-1', 'dataset-1', 'user-1', 2, '2026-01-01',
      'SECURITY', 'SPY', 'USD', 1, 500, 500, 32, 0, 'transaction-row-1'
    );
    INSERT INTO valuation_snapshots (
      id, user_id, revision, status, valuation_date, filename, file_hash,
      parser_version, mark_count, earliest_mark_date, latest_mark_date, activated_at
    ) VALUES (
      'snapshot-1', 'user-1', 1, 'ACTIVE', '2026-06-30', 'marks.csv', 'same-hash',
      'parser-v1', 2, '2026-06-29', '2026-06-30', '2026-07-01T00:00:00Z'
    );
    INSERT INTO valuation_state (user_id, active_snapshot_id, valuation_revision)
      VALUES ('user-1', 'snapshot-1', 1);
    INSERT INTO valuation_marks (
      id, snapshot_id, user_id, source_row_number, mark_date, mark_type,
      ticker, currency, value, source, row_hash
    ) VALUES
      ('mark-1', 'snapshot-1', 'user-1', 1, '2026-06-29', 'PRICE', 'SPY', 'USD', 600, 'seed', 'row-1'),
      ('mark-2', 'snapshot-1', 'user-1', 2, '2026-06-30', 'FX', '', 'USD', 32, 'seed', 'row-2');
  `)

  execute(`PRAGMA foreign_keys = ON; BEGIN; ${migration('0003_allow_valuation_reparse.sql')} COMMIT;`)
  assert.equal(execute(`
    PRAGMA foreign_keys = ON;
    SELECT
      (SELECT count(*) FROM valuation_snapshots) || '|' ||
      (SELECT group_concat(id, ',') FROM (SELECT id FROM valuation_marks ORDER BY id)) || '|' ||
      (SELECT active_snapshot_id FROM valuation_state WHERE user_id = 'user-1') || '|' ||
      (SELECT count(*) FROM pragma_foreign_key_check);
  `), '1|mark-1,mark-2|snapshot-1|0')

  execute(`
    PRAGMA foreign_keys = ON;
    INSERT INTO valuation_snapshots (
      id, user_id, revision, status, valuation_date, filename, file_hash, parser_version, mark_count
    ) VALUES ('snapshot-2', 'user-1', 2, 'ARCHIVED', '2026-06-30', 'marks.csv', 'same-hash', 'parser-v2', 1);
  `)
  const duplicate = spawnSync('sqlite3', ['-batch', database], {
    input: `PRAGMA foreign_keys = ON; INSERT INTO valuation_snapshots
      (id, user_id, revision, status, valuation_date, filename, file_hash, parser_version, mark_count)
      VALUES ('snapshot-3', 'user-1', 3, 'ARCHIVED', '2026-06-30', 'marks.csv', 'same-hash', 'parser-v2', 1);`,
    encoding: 'utf8',
  })
  assert.notEqual(duplicate.status, 0)
  assert.match(duplicate.stderr, /UNIQUE constraint failed/)

  // Existing deployments have 0003 recorded, so this forward migration must
  // independently preserve their current data and relationships.
  execute(`PRAGMA foreign_keys = ON; BEGIN; ${migration('0004_preserve_valuation_reparse_data.sql')} COMMIT;`)
  assert.equal(execute(`
    PRAGMA foreign_keys = ON;
    SELECT
      (SELECT count(*) FROM valuation_snapshots) || '|' ||
      (SELECT count(*) FROM valuation_marks) || '|' ||
      (SELECT active_snapshot_id FROM valuation_state WHERE user_id = 'user-1') || '|' ||
      (SELECT count(*) FROM pragma_foreign_key_check);
  `), '2|2|snapshot-1|0')

  execute(`PRAGMA foreign_keys = ON; BEGIN; ${migration('0005_transaction_lineage_stale.sql')} COMMIT;`)
  assert.equal(execute(`
    PRAGMA foreign_keys = ON;
    SELECT
      (SELECT group_concat(transaction_id, ',') FROM (
        SELECT transaction_id FROM transactions ORDER BY id
      )) || '|' ||
      (SELECT transaction_dataset_id FROM valuation_snapshots WHERE id = 'snapshot-1') || '|' ||
      (SELECT transaction_revision FROM valuation_snapshots WHERE id = 'snapshot-1') || '|' ||
      (SELECT count(*) FROM valuation_marks) || '|' ||
      (SELECT active_snapshot_id FROM valuation_state WHERE user_id = 'user-1') || '|' ||
      (SELECT count(*) FROM pragma_foreign_key_check);
  `), 'transaction-physical-0,transaction-physical-0|dataset-1|6|2|snapshot-1|0')

  execute(`
    PRAGMA foreign_keys = ON;
    UPDATE portfolio_datasets SET status = 'ARCHIVED' WHERE id = 'dataset-1';
    INSERT INTO portfolio_datasets (
      id, user_id, revision, status, filename, file_hash, parser_version, row_count
    ) VALUES ('dataset-2', 'user-1', 7, 'ACTIVE', 'transactions-v7.csv', 'transactions-v7', 'parser-v1', 1);
    UPDATE portfolio_state
       SET active_dataset_id = 'dataset-2', cloud_revision = 7
     WHERE user_id = 'user-1';
    INSERT INTO valuation_snapshots (
      id, user_id, revision, status, valuation_date, filename, file_hash,
      parser_version, mark_count, transaction_dataset_id, transaction_revision
    ) VALUES (
      'snapshot-3', 'user-1', 3, 'ARCHIVED', '2026-06-30', 'marks.csv',
      'same-hash', 'parser-v2', 1, 'dataset-2', 7
    );
  `)

  const sameBindingDuplicate = spawnSync('sqlite3', ['-batch', database], {
    input: `PRAGMA foreign_keys = ON; INSERT INTO valuation_snapshots
      (id, user_id, revision, status, valuation_date, filename, file_hash,
       parser_version, mark_count, transaction_dataset_id, transaction_revision)
      VALUES ('snapshot-4', 'user-1', 4, 'ARCHIVED', '2026-06-30', 'marks.csv',
      'same-hash', 'parser-v2', 1, 'dataset-2', 7);`,
    encoding: 'utf8',
  })
  assert.notEqual(sameBindingDuplicate.status, 0)
  assert.match(sameBindingDuplicate.stderr, /UNIQUE constraint failed/)

  const missingLineage = spawnSync('sqlite3', ['-batch', database], {
    input: `PRAGMA foreign_keys = ON; INSERT INTO valuation_snapshots
      (id, user_id, revision, status, valuation_date, filename, file_hash,
       parser_version, mark_count)
      VALUES ('snapshot-5', 'user-1', 5, 'ARCHIVED', '2026-06-30', 'marks-new.csv',
      'new-hash', 'parser-v2', 1);`,
    encoding: 'utf8',
  })
  assert.notEqual(missingLineage.status, 0)
  assert.match(missingLineage.stderr, /valid transaction lineage is required/)

  assert.equal(execute(`
    PRAGMA foreign_keys = ON;
    SELECT
      (SELECT transaction_dataset_id FROM valuation_snapshots WHERE id = 'snapshot-1') || '|' ||
      (SELECT active_dataset_id FROM portfolio_state WHERE user_id = 'user-1') || '|' ||
      (SELECT CASE
        WHEN snapshot.transaction_dataset_id = state.active_dataset_id
         AND snapshot.transaction_revision = state.cloud_revision
        THEN 'CURRENT' ELSE 'STALE' END
       FROM valuation_snapshots snapshot
       JOIN valuation_state valuation ON valuation.active_snapshot_id = snapshot.id
       JOIN portfolio_state state ON state.user_id = snapshot.user_id
       WHERE snapshot.id = 'snapshot-1') || '|' ||
      (SELECT count(*) FROM pragma_foreign_key_check);
  `), 'dataset-1|dataset-2|STALE|0')

  console.log('valuation migration regression: passed')
} finally {
  rmSync(directory, { force: true, recursive: true })
}
