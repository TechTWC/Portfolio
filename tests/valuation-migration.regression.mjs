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

  console.log('valuation migration regression: passed')
} finally {
  rmSync(directory, { force: true, recursive: true })
}
