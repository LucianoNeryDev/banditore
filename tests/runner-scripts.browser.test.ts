import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Action } from '../src/runner/actions.js'
import type { Profiles } from '../src/runner/browser.js'
import type { Script, ScriptContext } from '../src/runner/executor.js'
import { linkedinScripts } from '../src/runner/scripts/linkedin.js'
import { pinterestScripts } from '../src/runner/scripts/pinterest.js'
import { redditScripts } from '../src/runner/scripts/reddit.js'
import { threadsScripts } from '../src/runner/scripts/threads.js'
import { tiktokScripts } from '../src/runner/scripts/tiktok.js'
import { xScripts } from '../src/runner/scripts/x.js'

// Runs each publish script against a fake copy of its platform's page, to
// check the flow (typing, uploads, the visible step, the receipt). It cannot
// prove the live selectors. Needs a Chromium: RUNNER_TEST_CHROMIUM=<path>.
const executablePath = process.env.RUNNER_TEST_CHROMIUM
const accountId = '6b1f4c0e-8a52-4d3c-9b7e-2f1a3c4d5e6f'
const png = join(mkdtempSync(join(tmpdir(), 'runner-scripts-')), '1.png')
writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'))

const page = (body: string, script = '') => `<!doctype html><html><body>${body}<script>${script}</script></body></html>`
// Records what the script typed and uploaded, then plays the platform's success.
const record = `window.posted = () => ({ text: document.querySelector('[contenteditable]')?.innerText ?? '', files: [...document.querySelectorAll('input[type=file]')].reduce((n, i) => n + i.files.length, 0) })`

const fakes: Record<string, Record<string, string>> = {
  // TikTok Studio as on 2026-10-27, when its content check offer covered the caption.
  tiktok: {
    'https://www.tiktok.com/tiktokstudio/upload?from=webapp': page(`<input type="file"><div contenteditable="true" role="combobox"></div>
      <button data-e2e="post_video_button" disabled>Pubblica</button>
      <div data-floating-ui-portal=""><div class="TUXModal-overlay" data-transition-status="open" style="position:fixed;inset:0;background:#0008">
        <div role="dialog"><span>Esamineremo automaticamente il tuo video</span><button id="on">Attiva</button><button id="off">Annulla</button></div></div></div>`,
    `${record}; document.querySelector('input').onchange = () => { document.querySelector('[data-e2e=post_video_button]').disabled = false }
      for (const b of document.querySelectorAll('[role=dialog] button')) b.onclick = () => document.querySelector('[data-floating-ui-portal]').remove()
      document.querySelector('[data-e2e=post_video_button]').onclick = () => { sessionStorage.result = JSON.stringify(window.posted()); location.href = '/tiktokstudio/content' }`),
    'https://www.tiktok.com/tiktokstudio/content': page('<p>Contenuti</p>'),
    'https://www.tiktok.com/@leonessa': page('<a href="/@leonessa/video/7560000000000000001">v</a>', 'window.result = JSON.parse(sessionStorage.result)'),
  },
  // TikTok Studio as on 2026-11-06, when a two-step feature tour covered the caption.
  tiktokTour: {
    'https://www.tiktok.com/tiktokstudio/upload?from=webapp': page(`<input type="file"><div contenteditable="true" role="combobox"></div>
      <button data-e2e="post_video_button" disabled>Pubblica</button>
      <div id="react-joyride-portal"><div class="react-joyride__overlay" data-test-id="overlay" role="presentation" style="position:fixed;inset:0;background:#0008;z-index:10"></div></div>
      <div class="__floater" style="position:fixed;top:40%;left:40%;z-index:11"><div class="react-joyride__tooltip" role="alertdialog"><span>Nuovo: 1/2</span>
        <button data-action="primary">Avanti</button></div></div>`,
    `${record}; document.querySelector('input').onchange = () => { document.querySelector('[data-e2e=post_video_button]').disabled = false }
      let step = 0; const tip = document.querySelector('.react-joyride__tooltip')
      tip.onclick = (e) => { if (e.target.dataset.action !== 'primary') return; if (++step < 2) { tip.querySelector('span').innerText = 'Nuovo: 2/2'; e.target.innerText = 'Fine' }
        else { document.querySelector('#react-joyride-portal').remove(); document.querySelector('.__floater').remove() } }
      document.querySelector('[data-e2e=post_video_button]').onclick = () => { sessionStorage.result = JSON.stringify(window.posted()); location.href = '/tiktokstudio/content' }`),
    'https://www.tiktok.com/tiktokstudio/content': page('<p>Contenuti</p>'),
    'https://www.tiktok.com/@leonessa': page('<a href="/@leonessa/video/7560000000000000002">v</a>', 'window.result = JSON.parse(sessionStorage.result)'),
  },
  x: {
    'https://x.com/compose/post': page(`<div role="dialog"><div data-testid="tweetTextarea_0" contenteditable="true"></div>
      <input type="file" data-testid="fileInput" multiple style="display:none"><button data-testid="tweetButton">Posta</button></div>`,
    `${record}; document.querySelector('[data-testid=tweetButton]').onclick = () => { window.result = window.posted(); document.querySelector('[role=dialog]').remove()
      document.body.insertAdjacentHTML('beforeend', '<div data-testid="toast">Post inviato <a href="/leonessa/status/1850000000000000001">Visualizza</a></div>') }`),
  },
  linkedin: {
    'https://www.linkedin.com/feed/?shareActive=true': page(`<a href="/feed/update/urn:li:activity:111/">someone else</a>
      <div role="dialog"><div contenteditable="true"></div><button aria-label="Aggiungi contenuti multimediali">m</button><input type="file" multiple style="display:none">
      <button id="next" style="display:none">Avanti</button><button id="post">Pubblica</button></div>`,
    `${record}; const d = document.querySelector('[role=dialog]'); d.querySelector('[aria-label]').onclick = () => d.querySelector('input').click()
      d.querySelector('input').onchange = () => { d.querySelector('#next').style.display = '' }
      d.querySelector('#next').onclick = () => { d.querySelector('#next').remove() }
      d.querySelector('#post').onclick = () => { window.result = window.posted(); d.remove()
        document.body.insertAdjacentHTML('beforeend', '<div class="artdeco-toast-item">Post pubblicato <a href="/feed/update/urn:li:activity:7390000000000000000/">Visualizza post</a></div>') }`),
  },
  threads: {
    'https://www.threads.com/intent/post': page(`<div role="dialog"><div contenteditable="true"></div><input type="file" multiple style="display:none"><div role="button" tabindex="0">Pubblica</div></div>`,
      `${record}; document.querySelector('[role=button]').onclick = () => { window.result = window.posted(); document.querySelector('[role=dialog]').remove()
        document.body.insertAdjacentHTML('beforeend', '<div role="alert">Pubblicato <a href="/@leonessa/post/DQabc123">Visualizza</a></div>') }`),
  },
  pinterest: {
    'https://www.pinterest.com/pin-creation-tool/': page(`<input type="file"><input id="storyboard-selector-title">
      <div data-test-id="storyboard-description-field-container"><div contenteditable="true"></div></div><input id="WebsiteField">
      <button data-test-id="board-dropdown-select-button">Scegli una bacheca</button>
      <div id="picker" style="display:none"><input id="pickerSearchField"><div data-test-id="board-row-Siti web blog">Siti web blog</div><div data-test-id="board-row-Siti web">Siti web</div></div>
      <div data-test-id="storyboard-creation-nav-done"><button>Pubblica</button></div>`,
    `${record}; const picker = document.querySelector('[data-test-id=board-dropdown-select-button]'); picker.onclick = () => { document.querySelector('#picker').style.display = '' }
      for (const row of document.querySelectorAll('[data-test-id^=board-row-]')) row.onclick = () => { picker.innerText = row.innerText; document.querySelector('#picker').style.display = 'none' }
      document.querySelector('[data-test-id=storyboard-creation-nav-done] button').onclick = () => {
        window.result = { ...window.posted(), title: document.querySelector('#storyboard-selector-title').value, link: document.querySelector('#WebsiteField').value, board: picker.innerText }
        document.body.insertAdjacentHTML('beforeend', '<div>Pin pubblicato <a href="/pin/987654321/">Vedi</a></div>') }`),
  },
  reddit: {
    'https://www.reddit.com/r/brescia/submit/?type=TEXT': page(`<textarea name="title"></textarea><shreddit-composer><div contenteditable="true" role="textbox"></div></shreddit-composer>
      <button id="inner-post-submit-button">Pubblica</button>`,
    `${record}; document.querySelector('#inner-post-submit-button').onclick = () => {
        sessionStorage.result = JSON.stringify({ ...window.posted(), title: document.querySelector('textarea').value }); location.href = '/r/brescia/comments/1abc2de/ciao_brescia/' }`),
    'https://www.reddit.com/r/brescia/comments/1abc2de/ciao_brescia/': page('<h1>Ciao Brescia</h1>', 'window.result = JSON.parse(sessionStorage.result)'),
  },
}
const cookies: Record<string, { name: string, url: string }> = {
  tiktok: { name: 'sessionid', url: 'https://www.tiktok.com' }, tiktokTour: { name: 'sessionid', url: 'https://www.tiktok.com' },
  x: { name: 'auth_token', url: 'https://x.com' }, linkedin: { name: 'li_at', url: 'https://www.linkedin.com' },
  threads: { name: 'sessionid', url: 'https://www.threads.com' }, pinterest: { name: '_auth', url: 'https://www.pinterest.com' },
  reddit: { name: 'reddit_session', url: 'https://www.reddit.com' },
}

describe.skipIf(!executablePath)('runner scripts against fake pages', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: executablePath!, headless: true })
  })
  afterAll(async () => {
    await browser?.close()
  })

  async function run(platform: keyof typeof fakes, scripts: (profiles: Profiles) => Record<'publish_post', Script>, overrides: Partial<Action> = {}, files: string[] = []) {
    const context: BrowserContext = await browser.newContext()
    await context.addCookies([{ ...cookies[platform]!, value: 'session' }])
    await context.route('**/*', route => {
      const body = fakes[platform]![route.request().url()]
      return body ? route.fulfill({ contentType: 'text/html', body }) : route.fulfill({ status: 404, body: '' })
    })
    const tab = await context.newPage()
    const profiles = { page: async () => tab } as unknown as Profiles
    let visible = false
    const action = { id: 'a', actionId: 'attempt-1', kind: 'publish_post', state: 'running', createdAt: '', updatedAt: '', content: 'Ciao Brescia\nSiti web veloci',
      media: files.map(() => ({ url: 'https://dash-api.example.com/m', mimeType: 'image/png' as const })), settings: {},
      account: { id: accountId, platform, handle: 'leonessa', sealed: { ephemeralPublicKey: '', nonce: '', ciphertext: '' } }, ...overrides } as Action
    const script: ScriptContext = { action, secret: { username: 'u', password: 'p' }, files, visible: () => { visible = true },
      needHuman: async (reason) => { throw new Error(`needs a person: ${reason}`) } }
    try {
      const receipt = await scripts(profiles).publish_post(script)
      return { receipt, visible, result: await tab.evaluate('window.result') as Record<string, unknown> }
    } finally {
      await context.close()
    }
  }

  it('closes the TikTok content check offer, then posts and reads the video ID', async () => {
    const mp4 = png.replace(/png$/, 'mp4')
    writeFileSync(mp4, Buffer.alloc(16))
    const { receipt, visible, result } = await run('tiktok', tiktokScripts, { media: [{ url: 'https://dash-api.example.com/m', mimeType: 'video/mp4' }] }, [mp4])
    expect(visible).toBe(true)
    expect(result).toMatchObject({ text: 'Ciao Brescia\nSiti web veloci' })
    expect(receipt).toEqual({ externalId: '7560000000000000001', url: 'https://www.tiktok.com/@leonessa/video/7560000000000000001' })
  })

  it('walks through the TikTok Studio feature tour before typing the caption', async () => {
    const mp4 = png.replace(/png$/, 'mp4')
    writeFileSync(mp4, Buffer.alloc(16))
    const { receipt, result } = await run('tiktokTour', tiktokScripts, { media: [{ url: 'https://dash-api.example.com/m', mimeType: 'video/mp4' }] }, [mp4])
    expect(result).toMatchObject({ text: 'Ciao Brescia\nSiti web veloci' })
    expect(receipt).toEqual({ externalId: '7560000000000000002', url: 'https://www.tiktok.com/@leonessa/video/7560000000000000002' })
  })

  it('posts on X with an image and reads the toast receipt', async () => {
    const { receipt, visible, result } = await run('x', xScripts, {}, [png])
    expect(visible).toBe(true)
    expect(result).toMatchObject({ text: 'Ciao Brescia\nSiti web veloci', files: 1 })
    expect(receipt).toEqual({ externalId: '1850000000000000001', url: 'https://x.com/leonessa/status/1850000000000000001' })
  })

  it('posts on a LinkedIn profile through the media editor, reading only the toast', async () => {
    const { receipt, result } = await run('linkedin', linkedinScripts, { target: { kind: 'linkedin_profile', externalId: 'leonessa' } }, [png])
    expect(result).toMatchObject({ text: 'Ciao Brescia\nSiti web veloci', files: 1 })
    expect(receipt).toEqual({ externalId: 'urn:li:activity:7390000000000000000', url: 'https://www.linkedin.com/feed/update/urn:li:activity:7390000000000000000/' })
  })

  it('posts on Threads through the share intent', async () => {
    const { receipt, result } = await run('threads', threadsScripts)
    expect(result).toMatchObject({ text: 'Ciao Brescia\nSiti web veloci', files: 0 })
    expect(receipt).toEqual({ externalId: 'DQabc123', url: 'https://www.threads.com/@leonessa/post/DQabc123' })
  })

  it('creates a Pin on the exact board with title and link', async () => {
    const { receipt, result } = await run('pinterest', pinterestScripts, { settings: { board: 'Siti web', title: 'Siti veloci', link: 'https://leonessadigital.com/blog' } }, [png])
    expect(result).toMatchObject({ files: 1, title: 'Siti veloci', link: 'https://leonessadigital.com/blog', board: 'Siti web' })
    expect(receipt).toEqual({ externalId: '987654321', url: 'https://www.pinterest.com/pin/987654321/' })
  })

  it('submits a Reddit text post and takes the ID from the new URL', async () => {
    const { receipt, result } = await run('reddit', redditScripts, { settings: { subreddit: 'brescia', title: 'Ciao Brescia' } })
    expect(result).toMatchObject({ text: 'Ciao Brescia\nSiti web veloci', title: 'Ciao Brescia' })
    expect(receipt).toEqual({ externalId: 't3_1abc2de', url: 'https://www.reddit.com/r/brescia/comments/1abc2de/ciao_brescia/' })
  })
})
