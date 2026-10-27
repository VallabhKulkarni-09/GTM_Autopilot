import { test, expect, type BrowserContext } from '@playwright/test'

/**
 * Plants a Supabase session cookie the @supabase/ssr client accepts. The stub server
 * validates it (GET /auth/v1/user). The access token value doubles as the role selector.
 */
/** Token flags read by the stub: "setup" = setup unfinished, "ready" = every required step done. */
async function signIn(context: BrowserContext, role: 'admin' | 'member' | 'admin-aimodel' | 'admin-noapollo' | 'admin-setup' | 'admin-setup-ready' | 'member-setup') {
  const now = Math.floor(Date.now() / 1000)
  const payload = Buffer.from(JSON.stringify({ sub: 'u', role: 'authenticated', exp: now + 3600 })).toString('base64url')
  const accessToken = `eyJhbGciOiJIUzI1NiJ9.${payload}.${role}`
  const session = {
    access_token: accessToken, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600,
    refresh_token: 'r', user: { id: 'u', aud: 'authenticated', email: `${role}@example.com` },
  }
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`
  // Cookie name = sb-<first label of SUPABASE_URL host>-auth-token → host is 127.0.0.1
  await context.addCookies([{ name: 'sb-127-auth-token', value, domain: 'localhost', path: '/' }])
}

test.describe('Connections page', () => {
  test('admin sees all three connections with plain-language status', async ({ page, context }) => {
    await signIn(context, 'admin')
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'HubSpot' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Salesforce' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Apollo' })).toBeVisible()
    await expect(page.getByText('1 of 3 tools connected')).toBeVisible()
    await expect(page.getByText('Needs attention')).toBeVisible()
    await expect(page.getByText('https://autopilot.example.com/webhooks/hubspot')).toBeVisible()
    await expect(page.getByText('HubSpot account 4242')).toBeVisible()
    // No out-of-scope connectors (scoped to the page body: the sidebar has an "Outreach" settings page)
    await expect(page.getByRole('main').getByText(/Outreach|Salesloft|Clearbit|ZoomInfo/)).toHaveCount(0)
  })

  test('a rejected Apollo key shows what went wrong and how to fix it', async ({ page, context }) => {
    await signIn(context, 'admin')
    await page.goto('/settings')
    const apollo = page.getByRole('region', { name: 'Apollo', exact: true })
    await apollo.getByRole('button', { name: 'Update details for Apollo' }).click()
    await apollo.getByRole('textbox', { name: 'API key', exact: true }).fill('bad')
    await apollo.getByRole('button', { name: 'Test connection' }).click()
    await expect(apollo.getByText('Apollo did not accept the API key.')).toBeVisible()
    await expect(apollo.getByText(/How to fix: In Apollo → Settings/)).toBeVisible()
  })

  test('saving goes through the same-origin proxy with the server-side token', async ({ page, context, request }) => {
    await signIn(context, 'admin')
    await page.goto('/settings')
    const sf = page.getByRole('region', { name: 'Salesforce', exact: true })
    await sf.getByRole('textbox', { name: 'Salesforce URL', exact: true }).fill('https://acme.my.salesforce.com')
    await sf.getByRole('textbox', { name: 'Consumer key', exact: true }).fill('ck')
    await sf.getByRole('textbox', { name: 'Consumer secret', exact: true }).fill('cs')
    await sf.getByRole('button', { name: 'Save' }).click()
    await expect(sf.getByText('Salesforce is connected.')).toBeVisible()

    const state = await (await request.get('http://127.0.0.1:3199/__state')).json()
    const post = state.connectorPosts.find((p: any) => p.name === 'salesforce' && p.kind === 'save')
    expect(post.values).toMatchObject({ instanceUrl: 'https://acme.my.salesforce.com', clientId: 'ck', clientSecret: 'cs', sandbox: false })
    expect(post.auth).toMatch(/^Bearer eyJ/)
  })

  test('member sees status but cannot change connections', async ({ page, context }) => {
    await signIn(context, 'member')
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'Salesforce' })).toBeVisible()
    await expect(page.getByRole('button', { name: /^(Set up|Update details) for/ })).toHaveCount(0)
    await expect(page.getByText('Ask an admin to connect Salesforce.')).toBeVisible()
  })
})

test.describe('Ideal customer page', () => {
  test('admin edits chips and saves through the proxy with the current version', async ({ page, context, request }) => {
    await signIn(context, 'admin')
    await page.goto('/ideal-customer')
    const industries = page.getByRole('list', { name: 'Industries' })
    await expect(industries.getByText('saas')).toBeVisible()
    await page.getByRole('button', { name: 'Remove saas' }).click()
    await page.getByRole('textbox', { name: 'Industries' }).fill('Fintech')
    await page.getByRole('textbox', { name: 'Industries' }).press('Enter')
    await expect(industries.getByText('fintech')).toBeVisible()
    await page.getByRole('textbox', { name: 'Countries' }).fill('de')
    await page.getByRole('textbox', { name: 'Countries' }).press('Enter')
    await expect(page.getByRole('list', { name: 'Countries' }).getByText('DE')).toBeVisible()
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByRole('status')).toContainText('Saved')
    const state = await (await request.get('http://127.0.0.1:3199/__state')).json()
    const put = state.icpPuts.at(-1)
    expect(put.version).toBe(4)
    expect(put.config.industries).toEqual(['software', 'fintech'])
    expect(put.config.countries).toEqual(['US', 'GB', 'DE'])
    expect(put.auth).toContain('admin')
  })

  test('validation problems are listed in plain language', async ({ page, context }) => {
    await signIn(context, 'admin')
    await page.goto('/ideal-customer')
    await page.getByLabel('Good fit at score').fill('90')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'Please fix' })).toContainText('cannot be higher than the "Great fit" score')
  })

  test('"Would this lead qualify?" shows the fit label and reasons, using unsaved edits', async ({ page, context, request }) => {
    await signIn(context, 'member')
    await page.goto('/ideal-customer')
    await page.getByLabel('Work email').fill('jane@acme.com')
    await page.getByLabel('Industry', { exact: true }).fill('Software')
    await page.getByRole('spinbutton', { name: 'Employees' }).fill('250')
    await page.getByRole('button', { name: 'Check this lead' }).click()
    await expect(page.getByRole('region', { name: 'Would this lead qualify?' }).getByText(/^Great fit/)).toBeVisible()
    await expect(page.getByText('Company size is in your ideal range')).toBeVisible()
    const state = await (await request.get('http://127.0.0.1:3199/__state')).json()
    const pv = state.icpPreviews.at(-1)
    expect(pv.config.industries).toEqual(['saas', 'software'])
    expect(pv.company.employee_count).toBe(250)
    await page.getByLabel('Work email').fill('jane@gmail.com')
    await page.getByRole('button', { name: 'Check this lead' }).click()
    await expect(page.getByRole('region', { name: 'Would this lead qualify?' }).getByText(/^Not a fit/)).toBeVisible()
    await expect(page.getByText('Uses a personal email address (e.g. Gmail)')).toBeVisible()
  })

  test('member sees settings read-only', async ({ page, context }) => {
    await signIn(context, 'member')
    await page.goto('/ideal-customer')
    await expect(page.getByText('Only admins can change these settings.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Remove / })).toHaveCount(0)
  })
})

test.describe('Reps & territories page', () => {
  const lastCall = async (request: import('@playwright/test').APIRequestContext) =>
    (await (await request.get('http://127.0.0.1:3199/__state')).json()).repCalls.at(-1)

  test('admin imports reps, pauses a rep and changes capacity', async ({ page, context, request }) => {
    await signIn(context, 'admin')
    await page.goto('/reps')
    await expect(page.getByRole('cell', { name: 'alice@acme.com' })).toBeVisible()
    await page.getByRole('button', { name: 'Import from Salesforce' }).click()
    await expect(page.getByRole('status')).toContainText('1 new, 2 updated')
    expect(await lastCall(request)).toMatchObject({ method: 'POST', url: '/api/reps/import' })

    await page.getByRole('checkbox', { name: 'Alice Ng is taking new leads' }).click()
    await expect(page.getByRole('status')).toContainText('Alice Ng will not receive new leads')
    expect(await lastCall(request)).toMatchObject({ method: 'PATCH', url: '/api/reps/11111111-1111-4111-8111-111111111111', body: { available: false } })

    await page.getByLabel('Most open leads a rep can have').fill('12')
    await page.getByRole('region', { name: 'How many leads per rep' }).getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('region', { name: 'How many leads per rep' }).getByRole('status')).toHaveText('Saved.')
    expect(await lastCall(request)).toMatchObject({ method: 'PUT', body: { maxOpenLeadsPerRep: 12, version: 2 } })
  })

  test('territories show in plain language and can be created with chosen reps', async ({ page, context, request }) => {
    await signIn(context, 'admin')
    await page.goto('/reps')
    const list = page.getByRole('list', { name: 'Territories' })
    await expect(list.getByText('From: US, CA')).toBeVisible()
    await expect(list.getByText('Goes to: Alice Ng')).toBeVisible()
    await expect(list.getByText('From: Everywhere')).toBeVisible()

    await page.getByRole('button', { name: 'Add territory' }).click()
    const form = page.getByRole('form', { name: 'New territory' })
    await form.getByLabel('Name').fill('DACH')
    await form.getByRole('textbox', { name: 'Countries' }).fill('de, at, ch')
    await form.getByRole('textbox', { name: 'Countries' }).press('Enter')
    await form.getByLabel('Only these reps').check()
    await form.getByLabel('Bob Ruiz').check()
    await form.getByRole('button', { name: 'Save territory' }).click()
    await expect(page.getByRole('status')).toContainText('Territory "DACH" saved')
    expect(await lastCall(request)).toMatchObject({
      method: 'POST', url: '/api/territories',
      body: { name: 'DACH', countries: ['DE', 'AT', 'CH'], repIds: ['22222222-2222-4222-8222-222222222222'] },
    })
  })

  test('server validation errors are shown', async ({ page, context }) => {
    await signIn(context, 'admin')
    await page.goto('/reps')
    await page.getByRole('button', { name: 'Add territory' }).click()
    const form = page.getByRole('form', { name: 'New territory' })
    await form.getByLabel('Name').fill('EMEA')
    await form.getByLabel('Everywhere').check()
    await form.getByRole('button', { name: 'Save territory' }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'already a territory' })).toBeVisible()
  })

  test('member sees reps and territories read-only', async ({ page, context }) => {
    await signIn(context, 'member')
    await page.goto('/reps')
    await expect(page.getByRole('cell', { name: 'bob@acme.com' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Import from Salesforce' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Add territory' })).toHaveCount(0)
    await expect(page.getByRole('checkbox', { name: 'Alice Ng is taking new leads' })).toBeDisabled()
  })
})

test.describe('Outreach page', () => {
  const lastPut = async (request: import('@playwright/test').APIRequestContext) =>
    (await (await request.get('http://127.0.0.1:3199/__state')).json()).outreachPuts.at(-1)

  test('admin picks a mailbox and a sequence per fit level, saved with the current version', async ({ page, context, request }) => {
    await signIn(context, 'admin')
    await page.goto('/outreach')
    await expect(page.getByRole('heading', { name: 'Outreach', level: 1 })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Outreach' })).toBeVisible()

    const mailbox = page.getByLabel('Mailbox')
    await expect(mailbox.locator('option', { hasText: 'old@acme.com (disconnected in Apollo)' })).toBeDisabled()
    await mailbox.selectOption({ label: 'sdr@acme.com (default)' })

    const great = page.getByLabel('Great fit leads')
    await expect(great).toHaveValue('')
    await expect(great.locator('option', { hasText: 'Old webinar follow-up (paused in Apollo)' })).toHaveCount(1)
    await great.selectOption({ label: 'Inbound – Great fit' })
    await expect(page.getByLabel('Good fit leads')).toHaveValue('__manual__')

    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Saved. New leads will use these settings.')).toBeVisible()
    const put = await lastPut(request)
    expect(put).toMatchObject({
      version: 5,
      config: {
        email_account: { id: 'acct-1', email: 'sdr@acme.com' },
        tiers: { tier_1: { mode: 'sequence', sequence_id: 'seq-great', sequence_name: 'Inbound – Great fit' }, tier_2: { mode: 'manual' } },
      },
    })
    expect(put.auth).toContain('admin')
  })

  test('server validation issues are listed in plain language', async ({ page, context }) => {
    await signIn(context, 'admin')
    await page.goto('/outreach')
    await page.getByLabel('Great fit leads').selectOption({ label: 'Inbound – Great fit' })
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('main').getByRole('alert')).toContainText('Pick the mailbox Apollo should send from.')
  })

  test('Apollo not connected: explains what to do and nothing can be changed', async ({ page, context }) => {
    await signIn(context, 'admin-noapollo')
    await page.goto('/outreach')
    await expect(page.getByText('Connect Apollo on the Connections page first')).toBeVisible()
    await expect(page.getByLabel('Great fit leads')).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  test('member sees outreach settings read-only', async ({ page, context }) => {
    await signIn(context, 'member')
    await page.goto('/outreach')
    await expect(page.getByLabel('Mailbox')).toBeDisabled()
    await expect(page.getByLabel('Good fit leads')).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0)
    await expect(page.getByText('Only admins can change outreach settings.')).toBeVisible()
  })
})

test.describe('Approvals and needs attention', () => {
  const lastDecision = async (request: import('@playwright/test').APIRequestContext) =>
    (await (await request.get('http://127.0.0.1:3199/__state')).json()).decisions.at(-1)

  test('overview shows what needs a person, in plain language', async ({ page, context }) => {
    await signIn(context, 'member')
    await page.goto('/dashboard')
    const card = page.getByRole('region', { name: 'Needs attention' })
    await expect(card).toBeVisible()
    await expect(card.getByText('5 leads')).toBeVisible()
    await expect(card.getByRole('heading', { name: /Waiting for a decision/ })).toBeVisible()
    await expect(card.getByText('No sequence chosen for this fit level')).toBeVisible()
    await expect(card.getByRole('link', { name: 'Dee Fox' })).toHaveAttribute('href', '/leads/lead-e')
    await expect(card.getByRole('link', { name: 'Review on the Approvals page' })).toHaveAttribute('href', '/approvals')
  })

  test('admin assigns a rep to a routing review; the button waits for a rep', async ({ page, context, request }) => {
    await signIn(context, 'admin')
    await page.goto('/approvals')
    const card = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Ana Lee' }) })
    await expect(card.getByText('No territory covers this lead’s country')).toBeVisible()
    await expect(card.getByText('Response time missed')).toBeVisible()
    const assign = card.getByRole('button', { name: 'Assign', exact: true })
    await expect(assign).toBeDisabled()
    await card.getByLabel('Assign to').selectOption({ label: 'Bob Ruiz (away)' })
    await card.getByLabel('Note (optional)').fill('Covering EMEA this week')
    await assign.click()
    await expect(card.getByText('Approved. The lead is moving again.')).toBeVisible()
    expect(await lastDecision(request)).toMatchObject({
      playId: '55555555-5555-4555-8555-555555555555', action: 'approve',
      body: { repId: '22222222-2222-4222-8222-222222222222', note: 'Covering EMEA this week' },
    })
  })

  test('a sequence review can be rejected; a conflict is explained', async ({ page, context, request }) => {
    await signIn(context, 'admin')
    await page.goto('/approvals')
    const seq = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Ben Ode' }) })
    await expect(seq.getByText('Sequence: Inbound – Great fit')).toBeVisible()
    await seq.getByRole('button', { name: 'No sequence, rep follows up' }).click()
    await expect(seq.getByText('Rejected. The lead is moving again.')).toBeVisible()
    expect(await lastDecision(request)).toMatchObject({ playId: '66666666-6666-4666-8666-666666666666', action: 'reject', body: {} })

    const decided = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Cy Park' }) })
    await expect(decided.getByText('Suggested rep: Alice Ng')).toBeVisible()
    await decided.getByRole('button', { name: 'Assign', exact: true }).click()   // suggestion is enough
    await expect(decided.getByRole('alert')).toHaveText('Someone already rejected this lead.')
  })

  test('member sees approvals read-only', async ({ page, context }) => {
    await signIn(context, 'member')
    await page.goto('/approvals')
    await expect(page.getByRole('heading', { name: 'Ana Lee' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Assign', exact: true })).toHaveCount(0)
    await expect(page.getByText('Only admins can approve or reject.').first()).toBeVisible()
  })
})

test.describe('Lead timeline', () => {
  const ASSIGNED = '/leads/88888888-8888-4888-8888-888888888888'

  test('tells the story in plain language, with a status summary and fit label', async ({ page, context }) => {
    await signIn(context, 'member')
    await page.goto(ASSIGNED)
    await expect(page.getByRole('heading', { name: 'Jo Rivera' })).toBeVisible()

    const status = page.getByRole('region', { name: 'Where this lead is now' })
    await expect(status.getByText('Assigned to Alice Ng')).toBeVisible()
    await expect(status.getByText(/First contact is due in \d+ min/)).toBeVisible()

    const timeline = page.getByRole('list', { name: 'Timeline' })
    await expect(timeline.getByText('Form submitted in HubSpot')).toBeVisible()
    await expect(timeline.getByText('Apollo is not connected, so no company details were looked up.')).toBeVisible()
    await expect(timeline.getByText('Scored as Great fit')).toBeVisible()
    await expect(timeline.getByText('Company size is in your ideal range')).toBeVisible()
    await expect(timeline.getByText('Picked Alice Ng as the owner')).toBeVisible()
    await expect(timeline.getByText('Territory: North america')).toBeVisible()
    await expect(timeline.getByText('Assigned to Alice Ng in Salesforce')).toBeVisible()
    await expect(timeline.getByText('Setting up follow-up failed')).toBeVisible()
    await expect(timeline.getByText('No sequence is chosen for this fit level. Pick one on the Outreach page.')).toBeVisible()
    await expect(timeline.getByText(/No sequence chosen for this fit level\. It is listed under Needs attention/)).toBeVisible()

    const details = page.getByRole('region', { name: 'Details' })
    await expect(details.getByText('Great fit')).toBeVisible()
    await expect(details.getByText('Alice Ng')).toBeVisible()

    // No raw machine names until the reader asks for them
    await expect(page.getByText(/webhook_received|action_execution_|OUTREACH_TIER_NOT_SET|00T5g00000TASK1/)).toHaveCount(0)
  })

  test('Developer details reveals event types, codes and external IDs', async ({ page, context }) => {
    await signIn(context, 'member')
    await page.goto(ASSIGNED)
    const toggle = page.getByRole('button', { name: 'Developer details' })
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText('webhook_received', { exact: true })).toBeVisible()
    await expect(page.getByText('salesforce: 00T5g00000TASK1')).toBeVisible()
    await expect(page.getByText('OUTREACH_TIER_NOT_SET', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('org:run-1:assign').first()).toBeVisible()
    await toggle.click()
    await expect(page.getByText('webhook_received', { exact: true })).toHaveCount(0)
  })

  test('a lead with no events yet explains what will happen', async ({ page, context }) => {
    await signIn(context, 'member')
    await page.goto('/leads/99999999-9999-4999-8999-999999999999')
    await expect(page.getByText('Waiting to be processed')).toBeVisible()
    await expect(page.getByText('Nothing has happened yet. Steps appear here as soon as the form submission is processed.')).toBeVisible()
    await expect(page.getByText('Not scored yet')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Developer details' })).toHaveCount(0)
  })

  test('a paused lead points to Approvals; an unknown step is shown, not hidden', async ({ page, context }) => {
    await signIn(context, 'member')
    await page.goto('/leads/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    const status = page.getByRole('region', { name: 'Where this lead is now' })
    await expect(status.getByText('Waiting for a person to decide')).toBeVisible()
    await expect(status.getByRole('link', { name: 'Open Approvals' })).toHaveAttribute('href', '/approvals')
    await expect(page.getByText('Needs a person to pick the rep')).toBeVisible()
    await expect(page.getByText('No territory covers this lead’s country')).toBeVisible()
    await expect(page.getByText('Unrecognised step')).toBeVisible()
    await expect(page.getByRole('region', { name: 'Details' }).getByText('Good fit')).toBeVisible()
  })

  test('a lead from another workspace shows not found', async ({ page, context }) => {
    await signIn(context, 'member')
    await page.goto('/leads/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    await expect(page.getByRole('alert').getByText('Lead not found')).toBeVisible()
  })
})

test.describe('Setup wizard', () => {
  test('an admin with unfinished setup lands on the checklist from Overview', async ({ page, context }) => {
    await signIn(context, 'admin-setup')
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/setup$/)
    await expect(page.getByRole('heading', { name: 'Set up Acme Sales' })).toBeVisible()
    await expect(page.getByRole('status').getByText('2 of 4 required steps done')).toBeVisible()

    const steps = page.getByRole('list', { name: 'Setup steps' })
    await expect(steps.getByText('Done: Connected')).toBeVisible()
    await expect(steps.getByText('Not done: Not connected')).toBeVisible()
    await expect(steps.getByText('Needs attention: the last check failed')).toBeVisible()
    await expect(steps.getByText('2 of 3 reps are taking leads')).toBeVisible()
    await expect(steps.getByText('Using the starting settings')).toBeVisible()
    await expect(steps.getByText('1 of 2 fit levels set')).toBeVisible()
    await expect(steps.getByText('Recommended')).toHaveCount(3)
    await expect(steps.getByRole('link', { name: 'Open Reps & territories' })).toHaveAttribute('href', '/reps')

    await expect(page.getByRole('button', { name: 'Finish setup' })).toBeDisabled()
    await expect(page.getByText('Still to do: Connect Salesforce, Send a test lead')).toBeVisible()
  })

  test('Skip for now goes to Overview and keeps a way back', async ({ page, context }) => {
    await signIn(context, 'admin-setup')
    await page.goto('/setup')
    await page.getByRole('button', { name: 'Skip for now' }).click()
    await expect(page).toHaveURL(/\/dashboard$/)
    const finish = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Finish setup' })
    await expect(finish).toHaveAttribute('href', '/setup')
    // Same browser session: Overview no longer redirects
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/dashboard$/)
  })

  test('send a test lead, watch it arrive, then remove it', async ({ page, context, request }) => {
    await signIn(context, 'admin-setup')
    await page.goto('/setup')
    const form = page.getByRole('form', { name: 'Send a test lead' })
    await expect(form.getByRole('textbox', { name: 'Work email' })).toHaveValue('admin@example.com')
    await expect(form.getByText(/This runs the real process/)).toBeVisible()
    await form.getByRole('textbox', { name: 'Work email' }).fill('jo@acme.example')
    await form.getByRole('textbox', { name: /Job title/ }).fill('VP Sales')
    await form.getByRole('button', { name: 'Send test lead' }).click()

    await expect(page.getByRole('status').getByText('Your test lead arrived. Open it to see each step.')).toBeVisible({ timeout: 10_000 })
    const list = page.getByRole('region', { name: 'Your test leads' })
    await expect(list.getByText('Assigning a rep · Great fit · Owner: Alice Ng')).toBeVisible()
    await expect(list.getByRole('link', { name: 'See what happened to Test Lead' })).toHaveAttribute('href', '/leads/cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    // Checklist refreshed: the test-lead step is done
    await expect(page.getByText('Done: 1 sent')).toBeVisible()

    const state = await (await request.get('http://127.0.0.1:3199/__state')).json()
    const post = state.testLeadPosts.at(-1)
    expect(post).toMatchObject({ email: 'jo@acme.example', firstName: 'Test', lastName: 'Lead', title: 'VP Sales' })
    expect(post.auth).toMatch(/^Bearer eyJ/)
    expect(post).not.toHaveProperty('organizationId')

    await list.getByRole('button', { name: 'Remove test leads…' }).click()
    const confirm = page.getByRole('group', { name: 'Confirm removing test leads' })
    await expect(confirm.getByText(/Anything they created in Salesforce or Apollo stays there/)).toBeVisible()
    await confirm.getByRole('button', { name: 'Remove test leads' }).click()
    await expect(page.getByText('Removed 1 test lead.')).toBeVisible()
    await expect(page.getByRole('region', { name: 'Your test leads' })).toHaveCount(0)
  })

  test('finishing setup when every required step is done goes to Overview', async ({ page, context }) => {
    await signIn(context, 'admin-setup-ready')
    await page.goto('/setup')
    await page.getByRole('button', { name: 'Finish setup' }).click()
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Finish setup' })).toHaveCount(0)
  })

  test('members see a note instead of the wizard', async ({ page, context }) => {
    await signIn(context, 'member-setup')
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.getByText('An admin is still setting up this workspace.', { exact: false })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Finish setup' })).toHaveCount(0)
    await page.goto('/setup')
    await expect(page).toHaveURL(/\/dashboard$/)
  })

  test('a test lead is labelled on its timeline', async ({ page, context }) => {
    await signIn(context, 'member')
    await page.goto('/leads/cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    await expect(page.getByRole('heading', { name: /Test Lead/ }).getByText('Test lead')).toBeVisible()
    await expect(page.getByText('Test lead sent from the setup page')).toBeVisible()
    await expect(page.getByText('Form submitted in HubSpot')).toHaveCount(0)
  })
})

test.describe('AI model settings', () => {
  test('admin connects Ollama: loads models, picks one, saves', async ({ page, context, request }) => {
    await signIn(context, 'admin')
    await page.goto('/settings')
    const card = page.getByRole('region', { name: /AI model/ })
    await expect(card.getByText('Not set up')).toBeVisible()
    await card.getByRole('button', { name: 'Set up for AI model' }).click()
    await expect(card.getByLabel('Server address')).toHaveValue('http://host.docker.internal:11434')
    await card.getByRole('button', { name: 'Load models' }).click()
    await expect(card.getByText('Found 2 models.')).toBeVisible()
    await card.getByRole('button', { name: 'qwen2.5:1.5b' }).click()
    await expect(card.getByLabel('Model', { exact: true })).toHaveValue('qwen2.5:1.5b')
    await card.getByRole('button', { name: 'Test connection' }).click()
    await expect(card.getByText('Connection works. The model answered in 1.1 s.')).toBeVisible()
    await expect(card.getByText(/did not follow the answer format/)).toBeVisible()
    await card.getByRole('button', { name: 'Save' }).click()
    await expect(card.getByText('Saved. The model answered in 0.8 s.')).toBeVisible()
    const state = await (await request.get('http://127.0.0.1:3199/__state')).json()
    const put = state.aiModelCalls.find((c: { method: string }) => c.method === 'PUT')
    expect(put.body).toEqual({ provider: 'ollama', baseUrl: 'http://host.docker.internal:11434', model: 'qwen2.5:1.5b' })
  })

  test('cloud provider needs the data consent box before Save; unreachable server shows a fix', async ({ page, context }) => {
    await signIn(context, 'admin')
    await page.goto('/settings')
    const card = page.getByRole('region', { name: /AI model/ })
    await card.getByRole('button', { name: 'Set up for AI model' }).click()
    await card.getByLabel('Server address').fill('http://nowhere.example:11434')
    await card.getByRole('button', { name: 'Load models' }).click()
    await expect(card.getByRole('alert')).toContainText('Could not reach the model server.')
    await expect(card.getByRole('alert')).toContainText('How to fix:')
    await card.getByLabel('Where the model runs').selectOption('anthropic')
    await expect(card.getByLabel('Server address')).toHaveCount(0)
    await card.getByLabel('API key').fill('ak-test')
    await card.getByLabel('Model', { exact: true }).fill('claude-x')
    const save = card.getByRole('button', { name: 'Save' })
    await expect(save).toBeDisabled()
    await card.getByLabel(/lead details .* will be sent to Anthropic/).check()
    await expect(save).toBeEnabled()
  })

  test('member sees the AI model card read-only', async ({ page, context }) => {
    await signIn(context, 'member')
    await page.goto('/settings')
    const card = page.getByRole('region', { name: /AI model/ })
    await expect(card.getByText('Ask an admin to set up an AI model.')).toBeVisible()
    await expect(card.getByRole('button', { name: /Set up/ })).toHaveCount(0)
  })
})

test('admin runs the test leads, sees agreement vs rules, then turns AI fit decisions on', async ({ page, context, request }) => {
  await signIn(context, 'admin-aimodel')
  await page.goto('/settings')
  const card = page.getByRole('region', { name: /AI model/ })
  await expect(card.getByText('qwen2.5:1.5b · Lead data stays on your machine', { exact: false })).toBeVisible()
  const panel = card.getByRole('group', { name: 'Use AI to decide fit' })
  await expect(panel.getByRole('button', { name: 'Turn on' })).toBeDisabled()
  await panel.getByRole('button', { name: 'Run test leads' }).click()
  await expect(panel.getByText(/Running test leads… 12 of 45 done/)).toBeVisible()
  await expect(panel.getByText(/matched the expected answer on/)).toBeVisible({ timeout: 15_000 })
  await expect(panel).toContainText('30 of 45')
  await expect(panel).toContainText('Your rules alone: 39 of 45')
  await expect(panel).toContainText('Ignored 3 of 4 forms that tried to instruct the AI')
  await panel.getByRole('button', { name: /Show the 1 test leads/ }).click()
  await expect(panel).toContainText('Every signal present: expected Great fit, model said Good fit')
  const fit = panel
  const routing = panel.getByRole('group', { name: 'Use AI to read countries for routing' })
  await expect(routing).toContainText('Routed 19 of 20 test leads correctly')
  await expect(routing).toContainText('Your rules alone: 15 of 20')
  await fit.getByRole('button', { name: 'Turn on' }).last().click()   // the fit switch's button comes after the routing section
  await expect(fit.getByRole('button', { name: 'Turn off' })).toBeVisible()
  await routing.getByRole('button', { name: 'Turn on' }).click()
  await expect(routing.getByText('On', { exact: true })).toBeVisible()
  const state = await (await request.get('http://127.0.0.1:3199/__state')).json()
  expect(state.aiAgentOn).toBe(true)
  expect(state.aiRoutingOn).toBe(true)
})

test('Google Gemini is a cloud choice with consent; a public "Other server" address also asks for consent', async ({ page, context, request }) => {
  await signIn(context, 'admin')
  await page.goto('/settings')
  const card = page.getByRole('region', { name: /AI model/ })
  await card.getByRole('button', { name: 'Set up for AI model' }).click()
  await card.getByLabel('Where the model runs').selectOption('gemini')
  await expect(card.getByText(/aistudio\.google\.com/)).toBeVisible()
  await expect(card.getByLabel('Server address')).toHaveCount(0)
  await expect(card.getByLabel(/will be sent to Google Gemini/)).toBeVisible()

  await card.getByLabel('Where the model runs').selectOption('openai_compatible')
  await expect(card.getByLabel(/will be sent to/)).toHaveCount(0)
  await card.getByLabel('Server address').fill('https://generativelanguage.googleapis.com/v1beta/openai')
  await card.getByLabel('Model', { exact: true }).fill('gemini-3.5-flash-lite')
  await card.getByRole('button', { name: 'Save' }).click()
  await expect(card.getByRole('alert')).toContainText('on the internet, not your own network')
  const box = card.getByLabel(/which is on the internet, not my own network/)
  await expect(card.getByRole('button', { name: 'Save' })).toBeDisabled()
  await box.check()
  await card.getByRole('button', { name: 'Save' }).click()
  await expect(card.getByText(/^Saved\./)).toBeVisible()
  const state = await (await request.get('http://127.0.0.1:3199/__state')).json()
  const puts = state.aiModelCalls.filter((c: { method: string }) => c.method === 'PUT')
  expect(puts.at(-1).body).toMatchObject({ provider: 'openai_compatible', consent: true })
})
