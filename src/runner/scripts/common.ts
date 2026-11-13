import type { Locator, Page } from 'playwright-core'
import type { ScriptContext } from '../executor.js'
import { totp } from '../totp.js'

// Shared steps for the platform scripts. The runner's Chromium runs in
// Italian (it-IT), so button names are matched in Italian and English.

/** True when one of `names` is a non-empty cookie for one of `urls`. */
export async function hasCookie(page: Page, urls: string[], names: string[]) {
  const cookies = await page.context().cookies(urls)
  return cookies.some(cookie => names.includes(cookie.name) && cookie.value.length > 0 && cookie.value !== '0')
}

const rejectCookies = /^(rifiut[ao] (i )?cookie (non essenziali|facoltativi)|rifiuta( tutto| tutti)?|refuse non-essential cookies|decline optional cookies|reject( all| optional cookies)?)$/i

/** Opens a page and declines optional cookies when the site asks (once per profile). */
export async function open(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await clickIfVisible(page.getByRole('button', { name: rejectCookies }), 3_000).catch(() => false)
}

/**
 * Signs in when the profile has no session: `fill` tries the form, and a
 * person finishes anything it cannot (CAPTCHA, device check, changed form).
 */
export async function ensureLogin(page: Page, context: ScriptContext, url: string, signedIn: () => Promise<boolean>, fill: () => Promise<void>) {
  if (await signedIn()) return
  await open(page, url)
  try {
    await fill()
    for (let waited = 0; waited < 20 && !await signedIn(); waited++) await page.waitForTimeout(1_000)
  } catch {
    // Left for the person on noVNC.
  }
  if (!await signedIn()) await context.needHuman('login checkpoint', signedIn)
}

/** Answers a two-factor prompt from the TOTP seed, when the account has one and the prompt shows. */
export async function answerTotp(page: Page, context: ScriptContext, input: Locator) {
  if (!context.secret.totp || !await input.first().isVisible({ timeout: 8_000 }).catch(() => false)) return
  await input.first().fill(totp(context.secret.totp))
  await page.keyboard.press('Enter')
}

export const codeInput = 'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name="pin"], input[name*="otp" i], input[name*="code" i]'

/**
 * The first visible match, waiting up to `timeout`. When it never shows, a
 * person brings the page to it. Use only before the visible step.
 */
export async function need(context: ScriptContext, locator: Locator, reason: string, options: { timeout?: number, state?: 'visible' | 'attached' } = {}) {
  const target = locator.first()
  const state = options.state ?? 'visible'
  const present = () => state === 'visible' ? target.isVisible() : target.count().then(count => count > 0)
  if (await target.waitFor({ state, timeout: options.timeout ?? 30_000 }).then(() => true, () => false)) return target
  await context.needHuman(reason, present)
  return target
}

/** Clicks the first of `locator` that shows within `timeout`; false when none does. */
export async function clickIfVisible(locator: Locator, timeout = 5_000) {
  const target = locator.first()
  if (!await target.isVisible({ timeout }).catch(() => false)) return false
  await target.click()
  return true
}

/** True when the button can be pressed: no `disabled` and no `aria-disabled="true"`. */
export async function pressable(button: Locator) {
  const target = button.first()
  if (!await target.isVisible().catch(() => false)) return false
  if (await target.getAttribute('aria-disabled').catch(() => null) === 'true') return false
  return target.isEnabled().catch(() => false)
}

/**
 * Waits for a button to become pressable (uploads finishing); after
 * `timeoutMs` a person looks. Use only before the visible step.
 */
export async function waitPressable(page: Page, context: ScriptContext, button: Locator, reason: string, timeoutMs = 600_000) {
  for (let waited = 0; !await pressable(button) && waited < timeoutMs; waited += 2_000) await page.waitForTimeout(2_000)
  if (!await pressable(button)) await context.needHuman(reason, () => pressable(button))
}

/** Replaces an editor's text by typing, a line at a time, as a keyboard would. */
export async function typeInto(page: Page, editor: Locator, text: string) {
  await editor.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Delete')
  for (const [index, line] of text.split('\n').entries()) {
    if (index) await page.keyboard.press('Enter')
    if (line) await page.keyboard.insertText(line)
  }
}

/** The start of a post's text, to recognise it on a profile. */
export function snippet(content: string) {
  return content.replace(/\s+/g, ' ').trim().slice(0, 40)
}

/**
 * The newest post on a profile page whose text starts like `content`: the
 * first of `items` (up to five) containing the snippet, read through `link`.
 */
export async function findOwnPost(items: Locator, link: string, pattern: RegExp, content: string) {
  const start = snippet(content)
  await items.first().waitFor({ timeout: 30_000 }).catch(() => undefined)
  const count = Math.min(await items.count(), 5)
  for (let index = 0; index < count; index++) {
    const item = items.nth(index)
    const text = (await item.innerText().catch(() => '')).replace(/\s+/g, ' ')
    if (start && !text.includes(start)) continue
    const hrefs = await item.locator(link).evaluateAll(nodes => nodes.map(node => node.getAttribute('href') ?? ''))
    const match = hrefs.map(href => href.match(pattern)).find(Boolean)
    if (match) return match
  }
  return null
}

/** The first link in `scope` matching `pattern`, waiting up to `timeout`. */
export async function linkMatching(scope: Locator, pattern: RegExp, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const hrefs = await scope.evaluateAll(nodes => nodes.map(node => node.getAttribute('href') ?? '')).catch(() => [] as string[])
    const match = hrefs.map(href => href.match(pattern)).find(Boolean)
    if (match) return match
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  return null
}
