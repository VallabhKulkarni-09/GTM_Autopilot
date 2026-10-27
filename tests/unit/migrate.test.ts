import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain JS module without type declarations
import { runMigrations, checksum, needsNoTransaction, sslFor } from '../../db/migrate-lib.js'

type Call = { text: string; params?: unknown[] }

function mockClient(opts: { ledger?: { filename: string; checksum: string }[]; hasTables?: boolean; failOn?: string } = {}) {
  const calls: Call[] = []
  return {
    calls,
    async query(text: string, params?: unknown[]) {
      calls.push({ text, params })
      if (text.startsWith('SELECT filename, checksum')) return { rows: opts.ledger ?? [] }
      if (text.includes("table_name = 'organizations'")) return { rows: opts.hasTables ? [{}] : [] }
      if (opts.failOn && text === opts.failOn) throw new Error('boom')
      return { rows: [] }
    },
  }
}

const A = { filename: '001_a.sql', sql: 'CREATE TABLE a (id int);\n-- ROLLBACK\nDROP TABLE a;' }
const B = { filename: '002_b.sql', sql: "ALTER TYPE t ADD VALUE IF NOT EXISTS 'x';" }

describe('runMigrations', () => {
  it('applies new files and records checksums', async () => {
    const c = mockClient()
    const r = await runMigrations(c, [A, B])
    expect(r.applied).toEqual(['001_a.sql', '002_b.sql'])
    const inserts = c.calls.filter(x => x.text.startsWith('INSERT INTO schema_migrations'))
    expect(inserts[0].params).toEqual(['001_a.sql', checksum(A.sql)])
    // Rollback section is never executed
    expect(c.calls.some(x => x.text.includes('DROP TABLE a'))).toBe(false)
  })

  it('skips files already in the ledger', async () => {
    const c = mockClient({ ledger: [{ filename: '001_a.sql', checksum: checksum(A.sql) }] })
    const r = await runMigrations(c, [A, B])
    expect(r.skipped).toEqual(['001_a.sql'])
    expect(r.applied).toEqual(['002_b.sql'])
  })

  it('runs enum changes outside a transaction', async () => {
    expect(needsNoTransaction(B.sql)).toBe(true)
    expect(needsNoTransaction(A.sql)).toBe(false)
    const c = mockClient()
    await runMigrations(c, [B])
    expect(c.calls.some(x => x.text === 'BEGIN')).toBe(false)
  })

  it('stops on failure, rolls back, and does not record the failed file', async () => {
    const c = mockClient({ failOn: 'CREATE TABLE a (id int);' })
    await expect(runMigrations(c, [A, B])).rejects.toMatchObject({ code: 'MIGRATION_FAILED' })
    expect(c.calls.some(x => x.text === 'ROLLBACK')).toBe(true)
    expect(c.calls.some(x => x.text.startsWith('INSERT INTO schema_migrations'))).toBe(false)
    expect(c.calls.some(x => x.text.includes("ADD VALUE"))).toBe(false)
  })

  it('refuses a changed checksum on an applied file', async () => {
    const c = mockClient({ ledger: [{ filename: '001_a.sql', checksum: 'old' }] })
    await expect(runMigrations(c, [A])).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' })
  })

  it('requires an explicit baseline for an existing database without a ledger', async () => {
    const c = mockClient({ hasTables: true })
    await expect(runMigrations(c, [A])).rejects.toMatchObject({ code: 'BASELINE_REQUIRED' })
  })

  it('baselines files up to the given number without executing them', async () => {
    const c = mockClient({ hasTables: true })
    const r = await runMigrations(c, [A, B], { baseline: '001' })
    expect(r.baselined).toEqual(['001_a.sql'])
    expect(r.applied).toEqual(['002_b.sql'])
    expect(c.calls.some(x => x.text.startsWith('CREATE TABLE a'))).toBe(false)
  })
})

describe('sslFor', () => {
  it('Supabase hosts use TLS', () => {
    expect(sslFor('postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres')).toEqual({ rejectUnauthorized: false })
    expect(sslFor('postgresql://postgres.abc:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres')).toEqual({ rejectUnauthorized: false })
  })
  it('local Postgres (CI, supabase start, docker) does not', () => {
    expect(sslFor('postgresql://postgres:postgres@127.0.0.1:54322/postgres')).toBe(false)
    expect(sslFor('postgresql://postgres:postgres@localhost:5432/postgres')).toBe(false)
    expect(sslFor('postgresql://postgres:postgres@db:5432/postgres')).toBe(false)
    expect(sslFor('postgresql://u:p@example.internal:5432/x?sslmode=disable')).toBe(false)
  })
})
