import type { Page } from 'playwright-core'
import type { Profiles } from '../browser.js'
import { ScriptError, type Script, type ScriptContext } from '../executor.js'
import { answerTotp, clickIfVisible, codeInput, ensureLogin, hasCookie, need, open, typeInto, waitPressable } from './common.js'

// Reddit's web app, driven like a person would, without the API. The channel
// settings give the subreddit (or `u_<username>` for the account's profile)
// and the title; the post text is the body. Selectors follow reddit.com as of
// 2026-10 (Playwright reaches into its open shadow roots); when they drift, or
// a subreddit asks for a flair, the script stops for a person before posting.
const site = ['https://www.reddit.com']
const signedIn = (page: Page) => hasCookie(page, site, ['reddit_session'])
const postButton = /^(post|pubblica)$/i

async function login(page: Page, context: ScriptContext) {
  await ensureLogin(page, context, 'https://www.reddit.com/login/', () => signedIn(page), async () => {
    await page.locator('input[name="username"]').first().fill(context.secret.username, { timeout: 15_000 })
    await page.locator('input[name="password"]').first().fill(context.secret.password)
    await page.keyboard.press('Enter')
    await answerTotp(page, context, page.locator(codeInput))
  })
}

export function redditScripts(profiles: Profiles): Record<'login' | 'publish_post', Script> {
  return {
    async login(context) {
      await login(await profiles.page(context.action.account.id), context)
    },

    async publish_post(context) {
      const { action } = context
      const subreddit = typeof action.settings.subreddit === 'string' ? action.settings.subreddit : ''
      const title = typeof action.settings.title === 'string' ? action.settings.title.trim() : ''
      if (!/^(u_)?[A-Za-z0-9_]{2,21}$/.test(subreddit) || !title) throw new ScriptError('invalid_settings', 'Reddit needs a subreddit and a title')
      const page = await profiles.page(action.account.id)
      await login(page, context)
      const base = subreddit.startsWith('u_') ? `https://www.reddit.com/user/${subreddit.slice(2)}` : `https://www.reddit.com/r/${subreddit}`
      await open(page, `${base}/submit/?type=${context.files.length ? 'IMAGE' : 'TEXT'}`)

      await (await need(context, page.locator('textarea[name="title"]'), 'title field missing')).fill(title)
      if (context.files.length) {
        const input = await need(context, page.locator('input[type="file"]'), 'media input missing', { state: 'attached' })
        await input.setInputFiles(context.files)
      }
      if (action.content.trim()) {
        const body = page.locator('shreddit-composer [contenteditable="true"], [name="body"] [contenteditable="true"], div[contenteditable="true"][role="textbox"]')
        // Body text on image posts is a later field some subreddits hide; then a person decides.
        await clickIfVisible(page.getByRole('button', { name: /body text|testo del corpo/i }), 2_000)
        await typeInto(page, await need(context, body, 'body field missing'), action.content)
      }
      const post = page.locator('#inner-post-submit-button, #submit-post-button').or(page.getByRole('button', { name: postButton }))
      await waitPressable(page, context, post, 'post button stays disabled (flair, upload or subreddit rules)')

      context.visible()
      await post.first().click()
      await page.waitForURL(/\/comments\/[a-z0-9]+\//, { timeout: 120_000 })
      const id = new URL(page.url()).pathname.match(/\/comments\/([a-z0-9]+)\//)![1]!
      return { externalId: `t3_${id}`, url: `https://www.reddit.com${new URL(page.url()).pathname}` }
    },
  }
}
