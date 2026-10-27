/**
 * apollo-sequences.connector.test.ts
 *
 * Sequences methods of ApolloConnector. Mocked fetch replays response bodies from
 * __tests__/fixtures:
 *   apollo-*.fixture.json       live responses (scripts/capture-apollo-sequences.mjs, 2026-10-26;
 *                               the account had no sequences/mailboxes, so lists are empty)
 *   apollo-*.docs.fixture.json  200 examples from docs.apollo.io (populated list shapes)
 * Live read-only tests run when APOLLO_API_KEY is set.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ApolloConnector } from '../apollo.connector.js'
import { ConnectorError } from '../../base.js'

const LIVE = !!process.env.APOLLO_API_KEY
const fixture = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')) as { status: number; body: unknown }

const SEQ = '66e9e215ece19801b219997f'           // from the docs add_contact_ids example
const CONTACT_IN = '66e34b81740c50074e3d1bd4'    // added
const CONTACT_SKIPPED = '66e34b81740c50074e3d1bd5' // skipped: contact_not_found
const ACCOUNT = '6630ffa2a7f52601c7578345'

function mockFetch(...responses: Array<{ status: number; body: unknown }>) {
  const fn = vi.fn()
  for (const r of responses) {
    fn.mockResolvedValueOnce(new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status }))
  }
  vi.stubGlobal('fetch', fn)
  return fn
}

async function connected() {
  const c = new ApolloConnector()
  await c.connect({ apiKey: 'test-key' })
  return c
}

afterEach(() => { vi.unstubAllGlobals() })

describe('ApolloConnector sequences (fixtures)', () => {
  it('listSequences maps the docs example and drops archived sequences', async () => {
    const docs = fixture('apollo-sequences-search.docs.fixture.json').body as any
    const live = { ...docs.emailer_campaigns[0], id: 'live-1', name: 'Inbound Great fit', archived: false, active: true }
    const archived = { ...docs.emailer_campaigns[0], archived: true }
    const fetchFn = mockFetch({ status: 200, body: { ...docs, emailer_campaigns: [live, archived] } })
    const seqs = await (await connected()).listSequences()
    expect(seqs).toEqual([{ id: 'live-1', name: 'Inbound Great fit', active: true }])
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe('https://api.apollo.io/api/v1/emailer_campaigns/search')
    expect(init.method).toBe('POST')
    expect(init.headers['x-api-key']).toBe('test-key')
  })

  it('listSequences on the live empty account returns []', async () => {
    mockFetch(fixture('apollo-sequences-search.fixture.json'))
    expect(await (await connected()).listSequences()).toEqual([])
  })

  it('listEmailAccounts maps the docs example; live empty account returns []', async () => {
    mockFetch(fixture('apollo-email-accounts.docs.fixture.json'))
    const accounts = await (await connected()).listEmailAccounts()
    expect(accounts.length).toBeGreaterThan(0)
    expect(accounts[0]).toEqual({ id: ACCOUNT, email: expect.any(String), active: true, isDefault: true })
    mockFetch(fixture('apollo-email-accounts.fixture.json'))
    expect(await (await connected()).listEmailAccounts()).toEqual([])
  })

  it('findContactByEmail returns only an exact, case-insensitive email match', async () => {
    const docs = fixture('apollo-contacts-search.docs.fixture.json').body as any
    const email = docs.contacts[0].email as string
    mockFetch({ status: 200, body: docs })
    const found = await (await connected()).findContactByEmail(email.toUpperCase())
    expect(found).toEqual({ id: docs.contacts[0].id, email, sequenceIds: [] })

    mockFetch({ status: 200, body: docs })
    expect(await (await connected()).findContactByEmail('someone-else@nowhere.test')).toBeNull()
  })

  it('findContactByEmail with no results (live fixture) → null', async () => {
    mockFetch(fixture('apollo-contacts-search.fixture.json'))
    expect(await (await connected()).findContactByEmail('nobody@example.com')).toBeNull()
  })

  it('createContact sends run_dedupe and maps the contact', async () => {
    const fetchFn = mockFetch(fixture('apollo-contact-create.docs.fixture.json'))
    const c = await (await connected()).createContact({ email: 'a@b.co', firstName: 'A', organizationName: 'B' }, 'org:run:start_sequence:create_contact')
    expect(c.id).toBe(CONTACT_IN)
    const body = JSON.parse(fetchFn.mock.calls[0][1].body)
    expect(body).toEqual({ email: 'a@b.co', first_name: 'A', organization_name: 'B', run_dedupe: true })
  })

  it('createContact with a 200 but no contact id → AP_CONTACT_FAILED', async () => {
    mockFetch({ status: 200, body: {} })
    await expect((await connected()).createContact({ email: 'a@b.co' }, 'k')).rejects.toMatchObject({
      name: 'ConnectorError', source: 'apollo', code: 'AP_CONTACT_FAILED',
    })
  })

  it('addContactToSequence: sends the documented query params and returns the campaign status', async () => {
    const fetchFn = mockFetch(fixture('apollo-sequence-add-contacts.docs.fixture.json'))
    const r = await (await connected()).addContactToSequence(CONTACT_IN, SEQ, ACCOUNT, 'k')
    expect(r).toEqual({ contactId: CONTACT_IN, sequenceId: SEQ, campaignStatusId: '68782af181c7f0002159df25' })
    const url = new URL(fetchFn.mock.calls[0][0])
    expect(url.pathname).toBe(`/api/v1/emailer_campaigns/${SEQ}/add_contact_ids`)
    expect(url.searchParams.get('emailer_campaign_id')).toBe(SEQ)
    expect(url.searchParams.getAll('contact_ids[]')).toEqual([CONTACT_IN])
    expect(url.searchParams.get('send_email_from_email_account_id')).toBe(ACCOUNT)
    expect(url.searchParams.get('sequence_unverified_email')).toBe('true')
  })

  it('addContactToSequence: HTTP 200 with the contact in skipped_contact_ids → AP_SEQUENCE_FAILED with the reason', async () => {
    mockFetch(fixture('apollo-sequence-add-contacts.docs.fixture.json'))
    const p = (await connected()).addContactToSequence(CONTACT_SKIPPED, SEQ, ACCOUNT, 'k')
    await expect(p).rejects.toBeInstanceOf(ConnectorError)
    mockFetch(fixture('apollo-sequence-add-contacts.docs.fixture.json'))
    await expect((await connected()).addContactToSequence(CONTACT_SKIPPED, SEQ, ACCOUNT, 'k')).rejects.toMatchObject({
      code: 'AP_SEQUENCE_FAILED', message: expect.stringContaining('contact_not_found'),
    })
  })

  it('addContactToSequence: 422 (e.g. inactive mailbox) → AP_SEQUENCE_FAILED, not retried', async () => {
    const fetchFn = mockFetch({ status: 422, body: { error: 'These mailboxes are no longer active. test@example.com' } })
    await expect((await connected()).addContactToSequence(CONTACT_IN, SEQ, ACCOUNT, 'k')).rejects.toMatchObject({
      code: 'AP_SEQUENCE_FAILED', statusCode: 422,
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('403 (key lacks Sequences scope) → AP_INSUFFICIENT_SCOPE, not retried', async () => {
    const fetchFn = mockFetch({ status: 403, body: { error: 'This API key is not authorized to access api/v1/emailer_campaigns/search.', error_code: 'API_INACCESSIBLE' } })
    await expect((await connected()).listSequences()).rejects.toMatchObject({ code: 'AP_INSUFFICIENT_SCOPE', statusCode: 403 })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('401 → AP_AUTH_FAILED', async () => {
    mockFetch({ status: 401, body: 'Invalid API key.' })
    await expect((await connected()).listEmailAccounts()).rejects.toMatchObject({ code: 'AP_AUTH_FAILED' })
  })

  it('throws AP_NOT_CONNECTED before connect()', async () => {
    await expect(new ApolloConnector().listSequences()).rejects.toMatchObject({ code: 'AP_NOT_CONNECTED' })
  })
})

describe.skipIf(!LIVE)('ApolloConnector sequences (live, read-only)', () => {
  const live = async () => { const c = new ApolloConnector(); await c.connect({ apiKey: process.env.APOLLO_API_KEY! }); return c }

  it('listSequences returns an array', async () => {
    expect(Array.isArray(await (await live()).listSequences())).toBe(true)
  })
  it('listEmailAccounts returns an array', async () => {
    expect(Array.isArray(await (await live()).listEmailAccounts())).toBe(true)
  })
  it('findContactByEmail for an unknown address → null', async () => {
    expect(await (await live()).findContactByEmail('zzz-no-such-contact-autopilot@example.invalid')).toBeNull()
  })
})
