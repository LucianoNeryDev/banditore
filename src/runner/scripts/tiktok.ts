import type { Page } from 'playwright-core'
import type { Profiles } from '../browser.js'
import { ScriptError, type Script, type ScriptContext } from '../executor.js'
import { totp } from '../totp.js'

// TikTok's web UI, driven like a person would. Selectors follow TikTok Studio
// as of 2026-10; when they drift the script stops for a person (needs_human)
// instead of guessing, before the visible step.
const studioUpload = 'https://www.tiktok.com/tiktokstudio/upload?from=webapp'
const loginUrl = 'https://www.tiktok.com/login/phone-or-email/email'

async function signedIn(page: Page) {
  const cookies = await page.context().cookies('https://www.tiktok.com')
  return cookies.some(cookie => cookie.name === 'sessionid' && cookie.value.length > 0)
}

async function login(page: Page, context: ScriptContext) {
  if (await signedIn(page)) return
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' })
  try {
    await page.locator('input[name="username"]').fill(context.secret.username, { timeout: 15_000 })
    await page.locator('input[type="password"]').fill(context.secret.password)
    await page.locator('button[data-e2e="login-button"]').click()
    const code = page.locator('input[placeholder*="code" i], input[autocomplete="one-time-code"]')
    if (context.secret.totp && await code.first().isVisible({ timeout: 8_000 }).catch(() => false)) {
      await code.first().fill(totp(context.secret.totp))
      await page.keyboard.press('Enter')
    }
    await page.waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 15_000 })
  } catch {
    // CAPTCHA, a device check or a changed form: a person finishes the login.
  }
  if (!await signedIn(page)) await context.needHuman('login checkpoint', () => signedIn(page))
}

/**
 * Closes TikTok Studio's pop-ups (the automatic content check offer, the
 * react-joyride feature tour seen from 2026-11-06) that cover the caption. A
 * button that dismisses wins (the tour's skip, close or next); Escape is the
 * fallback. Turning on the content check is also fine: posting then waits
 * for it, which the publish step already handles.
 */
async function closeModals(page: Page) {
  const overlay = page.locator('.TUXModal-overlay[data-transition-status="open"], [data-floating-ui-portal] [role="dialog"], .react-joyride__overlay, .react-joyride__tooltip')
  for (let round = 0; round < 10 && await overlay.first().isVisible({ timeout: 1_500 }).catch(() => false); round++) {
    const dismiss = page.locator('[data-floating-ui-portal]').getByRole('button', { name: /^(annulla|cancel|non ora|not now|ok|chiudi|close|ho capito|got it|attiva|turn on)$/i })
      .or(page.locator('.react-joyride__tooltip [data-action="skip"], .react-joyride__tooltip [data-action="close"]'))
      .or(page.locator('.react-joyride__tooltip [data-action="primary"]'))
    if (await dismiss.first().isVisible().catch(() => false)) await dismiss.first().click()
    else await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    // A tour step without buttons closes on a click on its overlay.
    const tour = page.locator('.react-joyride__overlay')
    if (await tour.first().isVisible().catch(() => false)) await tour.first().click({ position: { x: 5, y: 5 } }).catch(() => undefined)
  }
}

export function tiktokScripts(profiles: Profiles): Record<'login' | 'publish_post', Script> {
  return {
    async login(context) {
      const page = await profiles.page(context.action.account.id)
      await login(page, context)
    },

    async publish_post(context) {
      const { action } = context
      if (context.files.length !== 1 || action.media[0]?.mimeType !== 'video/mp4') throw new ScriptError('unsupported_media', 'TikTok posts need exactly one MP4 video')
      const page = await profiles.page(action.account.id)
      await login(page, context)
      await page.goto(studioUpload, { waitUntil: 'domcontentloaded' })

      const input = page.locator('input[type="file"]').first()
      await input.waitFor({ state: 'attached', timeout: 30_000 }).catch(() => undefined)
      if (!await input.count()) await context.needHuman('upload page changed', async () => await page.locator('input[type="file"]').count() > 0)
      await page.locator('input[type="file"]').first().setInputFiles(context.files[0]!)

      const post = page.locator('button[data-e2e="post_video_button"]')
      const ready = () => post.isEnabled({ timeout: 1_000 }).catch(() => false)
      for (let waited = 0; !(await ready()) && waited < 300; waited += 2) await page.waitForTimeout(2_000)
      if (!await ready()) await context.needHuman('upload did not finish', ready)

      await closeModals(page)
      const caption = page.locator('[contenteditable="true"]').first()
      await caption.click()
      await page.keyboard.press('ControlOrMeta+A')
      await page.keyboard.press('Delete')
      await page.keyboard.insertText(action.content)

      await closeModals(page)
      context.visible()
      await post.click()
      // TikTok may ask to confirm before posting while its content check runs.
      const confirm = page.getByRole('button', { name: /post now|pubblica ora/i })
      if (await confirm.isVisible({ timeout: 5_000 }).catch(() => false)) await confirm.click()
      await page.waitForURL(/tiktokstudio\/content|\/@/, { timeout: 120_000 })

      // The newest video on the profile is the receipt; reconcile checks the caption later.
      await page.goto(`https://www.tiktok.com/@${action.account.handle}`, { waitUntil: 'domcontentloaded' })
      const href = await page.locator('a[href*="/video/"]').first().getAttribute('href', { timeout: 30_000 }).catch(() => null)
      const id = href?.match(/\/video\/(\d+)/)?.[1]
      return id ? { externalId: id, url: `https://www.tiktok.com/@${action.account.handle}/video/${id}` } : undefined
    },
  }
}
