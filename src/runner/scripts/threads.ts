import type { Page } from 'playwright-core'
import type { Profiles } from '../browser.js'
import type { Script, ScriptContext } from '../executor.js'
import { answerTotp, codeInput, ensureLogin, findOwnPost, hasCookie, linkMatching, need, open, typeInto, waitPressable } from './common.js'

// Threads' web app, driven like a person would, without the API. An account
// signs in with its own Threads login or the Instagram login it is linked to.
// Selectors follow threads.com as of 2026-10; when they drift the script stops
// for a person before posting.
const site = ['https://www.threads.com', 'https://www.threads.net']
const signedIn = (page: Page) => hasCookie(page, site, ['sessionid'])
const postButton = /^(post|pubblica)$/i

async function login(page: Page, context: ScriptContext) {
  // The plain form (not the choice screen); it takes the Instagram login of Instagram-linked accounts too.
  await ensureLogin(page, context, 'https://www.threads.com/login/?show_toa_choice_screen=false&variant=toa', () => signedIn(page), async () => {
    await page.locator('input[autocomplete="username"], input[name="username"]').first().fill(context.secret.username, { timeout: 15_000 })
    await page.locator('input[type="password"]').first().fill(context.secret.password)
    await page.keyboard.press('Enter')
    await answerTotp(page, context, page.locator(codeInput))
  })
}

export function threadsScripts(profiles: Profiles): Record<'login' | 'publish_post', Script> {
  return {
    async login(context) {
      await login(await profiles.page(context.action.account.id), context)
    },

    async publish_post(context) {
      const { action } = context
      const page = await profiles.page(action.account.id)
      await login(page, context)
      // Threads' own share intent opens the composer; the text is typed, not passed in the URL.
      await open(page, 'https://www.threads.com/intent/post')

      const dialog = page.locator('[role="dialog"]').filter({ has: page.locator('[contenteditable="true"]') })
      const editor = await need(context, dialog.locator('[contenteditable="true"]'), 'composer did not open')
      await typeInto(page, editor, action.content)
      if (context.files.length) {
        const input = await need(context, dialog.locator('input[type="file"]'), 'media input missing', { state: 'attached' })
        await input.setInputFiles(context.files)
      }
      const post = dialog.getByRole('button', { name: postButton })
      await waitPressable(page, context, post, 'post button stays disabled (upload or length)')

      context.visible()
      await post.last().click()
      // The "Posted" toast's View link carries the post's code.
      const toast = await linkMatching(page.locator('[role="alert"] a[href*="/post/"], [role="status"] a[href*="/post/"]'), /\/@[^/]+\/post\/([A-Za-z0-9_-]+)/, 30_000)
      if (toast) return { externalId: toast[1]!, url: `https://www.threads.com/@${action.account.handle}/post/${toast[1]}` }
      await editor.waitFor({ state: 'detached', timeout: 60_000 })

      await page.goto(`https://www.threads.com/@${action.account.handle}`, { waitUntil: 'domcontentloaded' })
      const found = await findOwnPost(page.locator('[data-pressable-container="true"]'), 'a[href*="/post/"]', /\/post\/([A-Za-z0-9_-]+)/, action.content)
      if (found) return { externalId: found[1]!, url: `https://www.threads.com/@${action.account.handle}/post/${found[1]}` }
      // Posted (the composer closed) but the receipt could not be read: the runner's action ID stands in.
      return undefined
    },
  }
}
