/**
 * migrate-lib.js — pure migration runner logic (unit-tested with a mocked pg client).
 *
 * Ledger: schema_migrations(filename PK, checksum, applied_at).
 *  - Each file runs exactly once.
 *  - Files run inside a transaction, EXCEPT files containing `ALTER TYPE ... ADD VALUE`
 *    (new enum values cannot be used in the transaction that adds them).
 *  - A changed checksum on an already-applied file is an error (never silently re-run).
 *  - An existing database with no ledger must be baselined explicitly (--baseline NNN).
 */

import crypto from 'crypto'

export const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   TEXT PRIMARY KEY,
  checksum   TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`

/** Forward SQL only: everything before the `-- ROLLBACK` marker. */
export function forwardSql(sql) {
  return sql.split('-- ROLLBACK')[0].trim()
}

export function checksum(sql) {
  return crypto.createHash('sha256').update(forwardSql(sql)).digest('hex')
}

/**
 * TLS settings for a connection string. Supabase requires TLS; a local Postgres (CI, a
 * self-hosted `supabase start`, docker) usually has none. Same rule as src/workflows/checkpointer.ts.
 */
export function sslFor(url) {
  return /@(localhost|127\.0\.0\.1|postgres|db)(:|\/)/.test(url) || /sslmode=disable/.test(url)
    ? false
    : { rejectUnauthorized: false }
}

export function needsNoTransaction(sql) {
  return /ALTER\s+TYPE[\s\S]*?ADD\s+VALUE/i.test(forwardSql(sql))
}

export class MigrationError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * @param client   pg-like client: { query(text, params?) => Promise<{ rows }> }
 * @param files    [{ filename, sql }] sorted ascending
 * @param options  { baseline?: string (e.g. '024'), log?: (msg) => void }
 * @returns        { applied: string[], skipped: string[], baselined: string[] }
 */
export async function runMigrations(client, files, options = {}) {
  const log = options.log ?? (() => {})
  await client.query(LEDGER_DDL)

  const { rows } = await client.query('SELECT filename, checksum FROM schema_migrations')
  const ledger = new Map(rows.map(r => [r.filename, r.checksum]))
  const result = { applied: [], skipped: [], baselined: [] }

  // Existing database created before the ledger existed: refuse to guess.
  if (ledger.size === 0 && !options.baseline) {
    const { rows: existing } = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organizations'`,
    )
    if (existing.length > 0) {
      throw new MigrationError(
        'BASELINE_REQUIRED',
        'This database already has tables but no migration ledger. ' +
        'Mark the migrations it already has as applied with: npm run migrate -- --baseline <last-applied-number> (e.g. 024)',
      )
    }
  }

  for (const { filename, sql } of files) {
    const sum = checksum(sql)
    const recorded = ledger.get(filename)

    if (recorded) {
      if (recorded !== sum) {
        throw new MigrationError(
          'CHECKSUM_MISMATCH',
          `${filename} was already applied but its contents changed. Write a new migration instead of editing an applied one.`,
        )
      }
      result.skipped.push(filename)
      continue
    }

    if (options.baseline && filename.slice(0, options.baseline.length) <= options.baseline) {
      await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [filename, sum])
      result.baselined.push(filename)
      log(`⟳ ${filename} marked as already applied (baseline)`)
      continue
    }

    const body = forwardSql(sql)
    const inTx = !needsNoTransaction(sql)
    log(`▶ ${filename}${inTx ? '' : ' (no transaction: enum change)'}`)
    try {
      if (inTx) await client.query('BEGIN')
      await client.query(body)
      await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [filename, sum])
      if (inTx) await client.query('COMMIT')
    } catch (err) {
      if (inTx) await client.query('ROLLBACK').catch(() => {})
      throw new MigrationError('MIGRATION_FAILED', `${filename} failed: ${err.message}`)
    }
    result.applied.push(filename)
  }

  return result
}
