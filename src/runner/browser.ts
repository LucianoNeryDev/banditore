import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type BrowserContext } from 'playwright-core'

/**
 * One persistent Chromium profile per account, shown on the runner's X
 * display so a person can take over through noVNC. Profiles survive restarts,
 * so logins are rare.
 */
export class Profiles {
  private open: { accountId: string, context: BrowserContext } | null = null

  constructor(private readonly directory: string, private readonly executablePath?: string) {}

  async context(accountId: string) {
    if (!/^[0-9a-f-]{36}$/.test(accountId)) throw new Error('Invalid account ID')
    if (this.open?.accountId === accountId) return this.open.context
    await this.close()
    const dir = join(this.directory, accountId)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const context = await chromium.launchPersistentContext(dir, {
      headless: false,
      ...(this.executablePath ? { executablePath: this.executablePath } : {}),
      viewport: { width: 1280, height: 800 },
      locale: 'it-IT',
      timezoneId: 'Europe/Rome',
      acceptDownloads: false,
      // No remote debugging port and no extensions: the only control channel is
      // Playwright's pipe. Without the automation flag the profile looks like the
      // account owner's normal browser, which it is.
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--no-first-run', '--disable-extensions', '--disable-blink-features=AutomationControlled', '--window-position=0,0', '--window-size=1280,860'],
    })
    this.open = { accountId, context }
    return context
  }

  async page(accountId: string) {
    const context = await this.context(accountId)
    return context.pages()[0] ?? context.newPage()
  }

  async close() {
    const current = this.open
    this.open = null
    await current?.context.close().catch(() => undefined)
  }
}
