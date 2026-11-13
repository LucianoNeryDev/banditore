import type { Page } from 'playwright-core'
import type { Profiles } from '../browser.js'
import type { Script, ScriptContext } from '../executor.js'
import { answerTotp, codeInput, ensureLogin, findOwnPost, hasCookie, linkMatching, need, open, typeInto, waitPressable } from './common.js'

// X's web app, driven like a person would, without the API. Selectors follow
// x.com as of 2026-10 (its data-testid attributes are stable across
// languages); when they drift the script stops for a person before posting.
const site = ['https://x.com']
const signedIn = (page: Page) => hasCookie(page, site, ['auth_token'])

async function login(page: Page, context: ScriptContext) {
  await ensureLogin(page, context, 'https://x.com/i/flow/login', () => signedIn(page), async () => {
    // Since 2026 one page asks for both; the older flow asks for the password after Enter.
    await page.locator('input[name="username_or_email"], input[autocomplete^="username"]').first().fill(context.secret.username, { timeout: 15_000 })
    const password = page.locator('input[name="password"]')
    if (!await password.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await page.keyboard.press('Enter')
      // X sometimes asks for the handle or phone before the password.
      const challenge = page.locator('input[data-testid="ocfEnterTextTextInput"]')
      if (await challenge.isVisible({ timeout: 4_000 }).catch(() => false)) {
        await challenge.fill(context.action.account.handle)
        await page.keyboard.press('Enter')
      }
    }
    await password.fill(context.secret.password, { timeout: 15_000 })
    await page.keyboard.press('Enter')
    await answerTotp(page, context, page.locator(`input[data-testid="ocfEnterTextTextInput"], ${codeInput}`))
  })
}

export function xScripts(profiles: Profiles): Record<'login' | 'publish_post', Script> {
  return {
    async login(context) {
      await login(await profiles.page(context.action.account.id), context)
    },

    async publish_post(context) {
      const { action } = context
      const page = await profiles.page(action.account.id)
      await login(page, context)
      await open(page, 'https://x.com/compose/post')

      const dialog = page.locator('[role="dialog"]')
      const editor = await need(context, dialog.locator('[data-testid="tweetTextarea_0"]'), 'composer did not open')
      await typeInto(page, editor, action.content)
      if (context.files.length) {
        const input = await need(context, dialog.locator('input[data-testid="fileInput"]'), 'media input missing', { state: 'attached' })
        await input.setInputFiles(context.files)
      }
      const post = dialog.locator('[data-testid="tweetButton"]')
      await waitPressable(page, context, post, 'post button stays disabled (upload or length)')

      context.visible()
      await post.first().click()
      // The toast's "View" link carries the new post's ID.
      const toast = await linkMatching(page.locator('[data-testid="toast"] a[href*="/status/"]'), /\/status\/(\d+)/, 30_000)
      if (toast) return { externalId: toast[1]!, url: `https://x.com/${action.account.handle}/status/${toast[1]}` }
      await editor.waitFor({ state: 'detached', timeout: 60_000 })

      await page.goto(`https://x.com/${action.account.handle}`, { waitUntil: 'domcontentloaded' })
      const found = await findOwnPost(page.locator('article[data-testid="tweet"]'), 'a[href*="/status/"]', /\/status\/(\d+)/, action.content)
      if (found) return { externalId: found[1]!, url: `https://x.com/${action.account.handle}/status/${found[1]}` }
      // Posted (the composer closed) but the receipt could not be read: the runner's action ID stands in.
      return undefined
    },
  }
}
