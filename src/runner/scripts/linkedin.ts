import type { Page } from 'playwright-core'
import type { Profiles } from '../browser.js'
import { ScriptError, type Script, type ScriptContext } from '../executor.js'
import { answerTotp, clickIfVisible, codeInput, ensureLogin, hasCookie, linkMatching, need, open, typeInto, waitPressable } from './common.js'

// LinkedIn's web app, driven like a person would, without the API. A channel
// posts to the member's profile (`linkedin_profile`) or to a Page the member
// administers (`linkedin_page`, the target is its company ID). Selectors
// follow linkedin.com as of 2026-10; when they drift the script stops for a
// person before posting.
const site = ['https://www.linkedin.com']
const signedIn = (page: Page) => hasCookie(page, site, ['li_at'])
const startPost = /^(start a post|crea un post|avvia un post|create|crea)$/i
const postButton = /^(post|pubblica)$/i
const nextButton = /^(next|avanti|done|fine)$/i

async function login(page: Page, context: ScriptContext) {
  await ensureLogin(page, context, 'https://www.linkedin.com/login', () => signedIn(page), async () => {
    // The form's IDs are generated; its autocomplete hints are stable. The page holds a hidden copy of it.
    await page.locator('input[autocomplete^="username"]:visible').first().fill(context.secret.username, { timeout: 15_000 })
    await page.locator('input[autocomplete="current-password"]:visible').first().fill(context.secret.password)
    await page.getByRole('button', { name: /^(accedi|sign in)$/i }).locator('visible=true').first().click()
    await answerTotp(page, context, page.locator(codeInput))
  })
}

export function linkedinScripts(profiles: Profiles): Record<'login' | 'publish_post', Script> {
  return {
    async login(context) {
      await login(await profiles.page(context.action.account.id), context)
    },

    async publish_post(context) {
      const { action } = context
      const target = action.target
      if (target && target.kind !== 'linkedin_profile' && target.kind !== 'linkedin_page') throw new ScriptError('unsupported_target', `Not a LinkedIn channel: ${target.kind}`)
      const page = await profiles.page(action.account.id)
      await login(page, context)

      if (target?.kind === 'linkedin_page') {
        if (!/^\d+$/.test(target.externalId)) throw new ScriptError('unsupported_target', 'A LinkedIn Page channel needs the company ID')
        await open(page, `https://www.linkedin.com/company/${target.externalId}/admin/page-posts/published/?share=true`)
      } else {
        await open(page, 'https://www.linkedin.com/feed/?shareActive=true')
      }
      const dialog = page.locator('[role="dialog"]').filter({ has: page.locator('[contenteditable="true"]') })
      if (!await dialog.first().isVisible({ timeout: 10_000 }).catch(() => false)) {
        await clickIfVisible(page.getByRole('button', { name: startPost }), 10_000)
      }
      const editor = await need(context, dialog.locator('[contenteditable="true"]'), 'post composer did not open')
      await typeInto(page, editor, action.content)

      if (context.files.length) {
        // The toolbar's media button opens a file chooser, then a media editor with Next.
        const chooser = page.waitForEvent('filechooser', { timeout: 15_000 }).catch(() => null)
        await dialog.getByRole('button', { name: /media|foto|photo|video|contenuti multimediali/i }).first().click({ timeout: 15_000 }).catch(() => undefined)
        const picked = await chooser
        if (picked) {
          await picked.setFiles(context.files)
        } else {
          const input = await need(context, page.locator('input[type="file"]'), 'media input missing', { state: 'attached' })
          await input.setInputFiles(context.files)
        }
        const next = page.locator('[role="dialog"]').getByRole('button', { name: nextButton })
        await waitPressable(page, context, next, 'media editor did not finish')
        await next.first().click()
      }

      const post = page.locator('[role="dialog"]').getByRole('button', { name: postButton })
      await waitPressable(page, context, post, 'post button stays disabled')

      context.visible()
      await post.first().click()
      // The success toast links to the new post's update URN. Only the toast:
      // the feed behind it is full of other posts' links.
      const toast = page.locator('.artdeco-toasts_toasts, .artdeco-toast-item, [role="alert"]')
      const link = await linkMatching(toast.locator('a[href*="/feed/update/urn:li:"]'), /\/feed\/update\/(urn:li:[a-zA-Z]+:\d+)/, 60_000)
      if (link) return { externalId: link[1]!, url: `https://www.linkedin.com/feed/update/${link[1]}/` }
      await editor.waitFor({ state: 'detached', timeout: 30_000 })
      // Posted (the composer closed) but the receipt could not be read: the runner's action ID stands in.
      return undefined
    },
  }
}
