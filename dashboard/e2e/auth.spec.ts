import { test, expect } from '@playwright/test'

test.describe('Signed-out visitor', () => {
  for (const path of ['/dashboard', '/leads', '/settings', '/team']) {
    test(`${path} redirects to the sign-in page`, async ({ page }) => {
      await page.goto(path)
      await expect(page).toHaveURL(/\/login$/)
      await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
    })
  }

  test('sign-in form validates the email in plain language', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Work email').fill('not-an-email')
    await page.getByRole('button', { name: 'Continue with email' }).click()
    await expect(page.locator('#email-error')).toHaveText('Please enter a valid email address.')
  })

  test('API proxy refuses unauthenticated calls with JSON, never forwarding them', async ({ request }) => {
    const res = await request.get('/api/leads')
    expect(res.status()).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'MISSING_TOKEN' })
  })
})

test.describe('Sign-in link handling', () => {
  test('a link that lands on another page is forwarded to the callback, not dropped', async ({ page }) => {
    await page.goto('/?code=abc123')
    // Stub has no token endpoint, so the exchange fails — but the user must see why.
    await expect(page).toHaveURL(/\/login\?error=link_/)
    await expect(page.getByRole('alert').filter({ hasText: 'sign-in link' })).toBeVisible()
  })

  test('expired links from Supabase show a plain-language message', async ({ page }) => {
    await page.goto('/auth/callback?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired')
    await expect(page).toHaveURL(/\/login\?error=link_expired/)
    await expect(page.getByRole('alert').filter({ hasText: 'expired' })).toBeVisible()
  })

  test('opening the link in another browser explains what to do', async ({ page }) => {
    await page.goto('/login?error=link_other_browser')
    await expect(page.getByRole('alert').filter({ hasText: 'different browser' })).toBeVisible()
  })
})
