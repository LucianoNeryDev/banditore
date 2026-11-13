import type { Page } from 'playwright-core'
import type { Profiles } from '../browser.js'
import { ScriptError, type Script, type ScriptContext } from '../executor.js'
import { answerTotp, codeInput, ensureLogin, hasCookie, linkMatching, need, open, typeInto, waitPressable } from './common.js'

// Pinterest's Pin creation tool, driven like a person would, without the API.
// One image or video per Pin; the post text is the description, and the
// channel settings give the board (required), title and link. Selectors follow
// pinterest.com as of 2026-10; when they drift the script stops for a person
// before publishing.
const site = ['https://www.pinterest.com', 'https://it.pinterest.com']
const signedIn = (page: Page) => hasCookie(page, site, ['_auth'])

async function login(page: Page, context: ScriptContext) {
  await ensureLogin(page, context, 'https://www.pinterest.com/login/', () => signedIn(page), async () => {
    await page.locator('#email').fill(context.secret.username, { timeout: 15_000 })
    await page.locator('#password').fill(context.secret.password)
    await page.locator('button[type="submit"]').first().click()
    await answerTotp(page, context, page.locator(codeInput))
  })
}

const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined

export function pinterestScripts(profiles: Profiles): Record<'login' | 'publish_post', Script> {
  return {
    async login(context) {
      await login(await profiles.page(context.action.account.id), context)
    },

    async publish_post(context) {
      const { action } = context
      const board = text(action.settings.board)
      if (!board) throw new ScriptError('invalid_settings', 'Pinterest needs a board')
      if (context.files.length !== 1) throw new ScriptError('unsupported_media', 'A Pin takes exactly one image or video')
      const page = await profiles.page(action.account.id)
      await login(page, context)
      await open(page, 'https://www.pinterest.com/pin-creation-tool/')

      const input = await need(context, page.locator('input[type="file"]'), 'upload input missing', { state: 'attached' })
      await input.setInputFiles(context.files[0]!)

      const title = text(action.settings.title)
      if (title) await (await need(context, page.locator('#storyboard-selector-title'), 'title field missing')).fill(title)
      if (action.content) {
        const description = await need(context, page.locator('[data-test-id="storyboard-description-field-container"] [contenteditable="true"], [data-test-id="editor-with-mentions"] [contenteditable="true"]'), 'description field missing')
        await typeInto(page, description, action.content)
      }
      const link = text(action.settings.link)
      if (link) await (await need(context, page.locator('#WebsiteField'), 'link field missing')).fill(link)

      // Choose the board by name in the board picker; a person picks it when the list differs.
      const picker = await need(context, page.locator('[data-test-id="board-dropdown-select-button"]'), 'board picker missing')
      // A board row or the picker shows the name on its first line (a "secret" label may follow).
      const firstLine = (value: string) => value.split('\n')[0]!.trim().toLowerCase()
      const chosen = async () => firstLine(await picker.innerText().catch(() => '')) === board.toLowerCase()
      if (!await chosen()) {
        await picker.click()
        const search = page.locator('#pickerSearchField')
        if (await search.isVisible({ timeout: 5_000 }).catch(() => false)) await search.fill(board)
        const rows = page.locator('[data-test-id^="board-row-"]')
        await rows.first().waitFor({ timeout: 10_000 }).catch(() => undefined)
        const names = (await rows.allInnerTexts()).map(firstLine)
        const index = names.indexOf(board.toLowerCase())
        if (index >= 0) await rows.nth(index).click()
        if (!await chosen()) await context.needHuman(`choose the board "${board}"`, chosen)
      }

      const publish = page.locator('[data-test-id="storyboard-creation-nav-done"] button, button[data-test-id="storyboard-creation-nav-done"]')
      await waitPressable(page, context, publish, 'publish button stays disabled (upload)')

      context.visible()
      await publish.first().click()
      // The confirmation offers a link to the new Pin.
      const pin = await linkMatching(page.locator('a[href*="/pin/"]'), /\/pin\/(\d+)/, 90_000)
      if (pin) return { externalId: pin[1]!, url: `https://www.pinterest.com/pin/${pin[1]}/` }
      throw new ScriptError('no_confirmation', 'Pinterest showed no published Pin')
    },
  }
}
