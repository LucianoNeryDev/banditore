import { describe, expect, it } from 'vitest'
import { InstagramLoginAdapter } from '../src/platforms/instagram/adapter.js'
import { accountScopes, defaultMetaScopes, MetaAdapter } from '../src/platforms/meta/adapter.js'
import { normalizeReplyText, pickOwnReply } from '../src/platforms/reply-match.js'
import { RateLimited, type FindReplyInput, type ReplyInput, type ResolvedProviderApp } from '../src/platforms/types.js'
import { defaultYoutubeScopes, YoutubeAdapter, youtubeReplyScope } from '../src/platforms/youtube/adapter.js'

// Every platform call goes to a recorded fake; nothing here reaches a real platform.
interface Call { method: string, url: URL, headers: Record<string, string>, body: unknown }
type Reply = (call: Call) => Response | Promise<Response>

function recorder(replies: Reply[]) {
  const calls: Call[] = []
  const fetcher = (async (input: URL | string | Request, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? 'GET', url: new URL(String(input)), headers: init?.headers as Record<string, string>, body: init?.body }
    calls.push(call)
    const reply = replies.shift()
    if (!reply) throw new Error(`Unexpected call ${call.method} ${call.url}`)
    return reply(call)
  }) as typeof fetch
  return { calls, fetcher }
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const graphError = (status: number, code: number, extra: Record<string, unknown> = {}) => json({ error: { message: 'boom', code, ...extra } }, status)
const googleError = (status: number, reason: string) => json({ error: { code: status, message: `boom ${reason}`, errors: [{ reason }] } }, status)
const timeout = () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }) }
const refused = () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }) }
const unreadable = () => new Response('not json', { status: 200 })

const metaApp: ResolvedProviderApp = { id: 'meta-test', platform: 'meta', externalAppId: '111', secret: 'app-secret-123', settings: { configId: '222' } }
const googleApp: ResolvedProviderApp = { id: 'google-test', platform: 'youtube', externalAppId: '123-abc.apps.googleusercontent.com', secret: 'google-secret-123', settings: {} }
const instagramApp: ResolvedProviderApp = { id: 'instagram-test', platform: 'instagram', externalAppId: '1582792782997136', secret: 'ig-secret-123', settings: {} }

const meta = (replies: Reply[]) => {
  const { calls, fetcher } = recorder(replies)
  return { calls, adapter: new MetaAdapter({ version: 'v26.0', redirectUri: 'https://dash-api.example.com/cb', fetch: fetcher }) }
}
const instagramLogin = (replies: Reply[]) => {
  const { calls, fetcher } = recorder(replies)
  return { calls, adapter: new InstagramLoginAdapter({ version: 'v26.0', redirectUri: 'https://dash-api.example.com/ig', fetch: fetcher }) }
}
const youtube = (replies: Reply[]) => {
  const { calls, fetcher } = recorder(replies)
  return { calls, adapter: new YoutubeAdapter({ redirectUri: 'https://dash-api.example.com/yt', fetch: fetcher }) }
}

const page = { id: 'c1', kind: 'facebook_page' as const, externalId: '1288534674353714' }
const igAccount = { id: 'c2', kind: 'instagram_account' as const, externalId: '17841400000000000', handle: 'leonessa' }
const ytChannel = { id: 'c3', kind: 'youtube_channel' as const, externalId: 'UC4LhENFUrkAcWqE7K-iFj5A' }
const replyInput = (channel: ReplyInput['channel'], overrides: Partial<ReplyInput> = {}): ReplyInput => ({
  channel, token: 'token-abc', postExternalId: '1_2', targetExternalId: '1_2_3', text: 'Grazie mille!', ...overrides })
const since = new Date('2030-01-01T10:00:00Z')
const findInput = (channel: FindReplyInput['channel'], overrides: Partial<FindReplyInput> = {}): FindReplyInput => ({
  channel, token: 'token-abc', postExternalId: '1_2', targetExternalId: '1_2_3', text: 'Grazie  mille!', since, excludeExternalIds: [], ...overrides })

describe('reply text matching', () => {
  it('compares normalised text from the account since the attempt, leaving out IDs other replies hold', () => {
    expect(normalizeReplyText(' Grazie\n mille! ')).toBe('Grazie mille!')
    expect(normalizeReplyText('Caffè')).toBe(normalizeReplyText('Caffè'))
    const mine = { id: 'r1', text: 'Grazie mille!', createdAt: since.getTime() + 1_000, own: true }
    expect(pickOwnReply([mine, { ...mine, id: 'r2', own: false }], findInput(page))).toEqual({ kind: 'found', externalId: 'r1' })
    expect(pickOwnReply([{ ...mine, createdAt: since.getTime() - 1 }], findInput(page))).toEqual({ kind: 'not_found' })
    expect(pickOwnReply([mine], findInput(page, { excludeExternalIds: ['r1'] }))).toEqual({ kind: 'not_found' })
    expect(pickOwnReply([mine, { ...mine, id: 'r3' }], findInput(page))).toMatchObject({ kind: 'ambiguous' })
  })
})

describe('Meta replies', () => {
  it('asks for pages_manage_engagement by default and names what each kind needs', () => {
    expect(defaultMetaScopes).toContain('pages_manage_engagement')
    const { adapter } = meta([])
    // Facebook threads nest deeper than one level, so their top may need reading on the platform.
    expect(adapter.replyRules('facebook_page')).toEqual({ permission: 'pages_manage_engagement', maxLength: 8_000, deepThreads: true })
    expect(adapter.replyRules('instagram_account')).toEqual({ permission: 'instagram_manage_comments', maxLength: 2_200 })
  })

  it('posts a Facebook reply as the Page under the comment, with the app secret proof', async () => {
    const { adapter, calls } = meta([json({ id: '1_2_9' })])
    expect(await adapter.reply(metaApp, replyInput(page))).toEqual({ kind: 'sent', externalId: '1_2_9' })
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url.pathname).toBe('/v26.0/1_2_3/comments')
    const body = calls[0]!.body as URLSearchParams
    expect(body.get('message')).toBe('Grazie mille!')
    expect(body.get('appsecret_proof')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('posts an Instagram reply on the replies edge', async () => {
    const { adapter, calls } = meta([json({ id: '17999' })])
    expect(await adapter.reply(metaApp, replyInput(igAccount, { targetExternalId: '17900' }))).toEqual({ kind: 'sent', externalId: '17999' })
    expect(calls[0]!.url.href.startsWith('https://graph.facebook.com/v26.0/17900/replies')).toBe(true)
    expect((calls[0]!.body as URLSearchParams).get('message')).toBe('Grazie mille!')
  })

  it('is uncertain only when the reply may exist, and names a missing permission only when Meta does', async () => {
    const requires = (permission: string) => ({ message: `(#200) Requires ${permission} permission to manage the object` })
    const cases: Array<[Reply, Record<string, unknown>]> = [
      [timeout, { kind: 'uncertain', code: 'response_lost' }],
      [unreadable, { kind: 'uncertain', code: 'response_lost' }],
      [graphError(500, 2, { is_transient: true }), { kind: 'uncertain', code: 'platform_error' }],
      [json({ unexpected: true }), { kind: 'uncertain', code: 'unexpected_response' }],
      [refused, { kind: 'failed', retryable: true, code: 'unreachable' }],
      [graphError(400, 4), { kind: 'failed', retryable: true, code: 'rate_limited' }],
      // A permission error that names no permission concerns this comment only: the channel keeps its replies.
      [graphError(403, 10), { kind: 'failed', retryable: false, code: 'reply_not_allowed' }],
      [graphError(403, 200, { message: '(#200) Permissions error' }), { kind: 'failed', retryable: false, code: 'reply_not_allowed' }],
      [graphError(403, 200, requires('pages_manage_engagement')), { kind: 'failed', retryable: false, code: 'missing_permission', permission: 'pages_manage_engagement' }],
      [graphError(403, 200, requires('pages_read_engagement')), { kind: 'failed', retryable: false, code: 'missing_permission', permission: 'pages_read_engagement' }],
      [graphError(401, 190), { kind: 'failed', retryable: false, code: 'channel_inactive', reauth: true }],
      [graphError(400, 100, { error_subcode: 33 }), { kind: 'failed', retryable: false, code: 'comment_gone' }],
      [graphError(400, 368), { kind: 'failed', retryable: false, code: 'rejected' }],
    ]
    for (const [reply, expected] of cases) {
      const { adapter } = meta([reply])
      expect(await adapter.reply(metaApp, replyInput(page))).toMatchObject(expected)
    }
    const { adapter } = meta([graphError(403, 10, { message: '(#10) Requires instagram_manage_comments permission' })])
    expect(await adapter.reply(metaApp, replyInput(igAccount))).toMatchObject({ code: 'missing_permission', permission: 'instagram_manage_comments' })
  })

  it('finds the Page\'s own reply under the comment for an uncertain send, across pages', async () => {
    const { adapter, calls } = meta([
      json({ data: [{ id: '1_2_8', message: 'Grazie mille!', created_time: '2030-01-01T10:01:00+0000', from: { id: '999' } }],
        paging: { cursors: { after: 'n1' }, next: 'https://graph.facebook.com/next' } }),
      json({ data: [{ id: '1_2_9', message: 'Grazie mille!\n', created_time: '2030-01-01T10:02:00+0000', from: { id: page.externalId },
        permalink_url: 'https://www.facebook.com/1_2_9' }] }),
    ])
    // Every page after the first is charged to the caller's budget.
    let spent = 0
    expect(await adapter.findReply(metaApp, findInput(page, { spendCall: () => { spent++ } })))
      .toEqual({ kind: 'found', externalId: '1_2_9', url: 'https://www.facebook.com/1_2_9' })
    expect(spent).toBe(1)
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toMatchObject({ filter: 'stream', fields: 'id,message,created_time,from{id},permalink_url' })
    expect(calls[1]!.url.searchParams.get('after')).toBe('n1')
    const limited = meta([graphError(400, 17)])
    await expect(limited.adapter.findReply(metaApp, findInput(page))).rejects.toBeInstanceOf(RateLimited)
  })

  it('finds the account\'s own Instagram reply by `user`, or by its username', async () => {
    const { adapter, calls } = meta([json({ data: [
      { id: '17998', text: 'Grazie mille!', timestamp: '2030-01-01T10:01:00+0000', username: 'mario' },
      { id: '17999', text: 'Grazie mille!', timestamp: '2030-01-01T10:01:00+0000', username: 'other', user: { id: igAccount.externalId } },
    ] })])
    expect(await adapter.findReply(metaApp, findInput(igAccount, { targetExternalId: '17900' }))).toEqual({ kind: 'found', externalId: '17999' })
    expect(calls[0]!.url.pathname).toBe('/v26.0/17900/replies')
    expect(calls[0]!.url.searchParams.get('fields')).toBe('id,text,timestamp,username,user')
    expect(calls[0]!.url.searchParams.get('limit')).toBe('50')
    const byName = meta([json({ data: [{ id: '17999', text: 'Grazie mille!', timestamp: '2030-01-01T10:01:00+0000', username: 'Leonessa' }] })])
    expect(await byName.adapter.findReply(metaApp, findInput(igAccount))).toMatchObject({ kind: 'found', externalId: '17999' })
  })

  it('reads a Facebook thread up to its top-level comment, and fails a read without sending', async () => {
    const { adapter, calls } = meta([json({ id: '1_2_7', parent: { id: '1_2_5' } }), json({ id: '1_2_5', parent: { id: '1_2_3' } }), json({ id: '1_2_3' })])
    expect(await adapter.replyTarget(metaApp, { channel: page, token: 'token-abc', commentExternalId: '1_2_7' })).toEqual({ kind: 'top', externalId: '1_2_3' })
    expect(calls.map(call => call.url.pathname)).toEqual(['/v26.0/1_2_7', '/v26.0/1_2_5', '/v26.0/1_2_3'])
    expect(calls[0]!.url.searchParams.get('fields')).toBe('id,parent{id}')
    expect(calls[0]!.url.searchParams.get('appsecret_proof')).toMatch(/^[0-9a-f]{64}$/)
    for (const [reply, expected] of [
      [timeout, { kind: 'failed', retryable: true }], [refused, { kind: 'failed', retryable: true, code: 'unreachable' }],
      [graphError(400, 100, { error_subcode: 33 }), { kind: 'failed', retryable: false, code: 'comment_gone' }],
      [graphError(401, 190), { kind: 'failed', retryable: false, code: 'channel_inactive', reauth: true }],
    ] as Array<[Reply, Record<string, unknown>]>) {
      const failing = meta([reply])
      expect(await failing.adapter.replyTarget(metaApp, { channel: page, token: 'token-abc', commentExternalId: '1_2_7' })).toMatchObject(expected)
    }
    expect(await meta([]).adapter.replyTarget(metaApp, { channel: igAccount, token: 'token-abc', commentExternalId: '17900' })).toMatchObject({ kind: 'failed', code: 'not_supported' })
  })

  it('keeps the grant\'s scopes per account, narrowing Page permissions to the Pages they name', () => {
    const grant = { scopes: ['pages_manage_posts', 'pages_manage_engagement', 'instagram_manage_comments'],
      granular_scopes: [{ scope: 'pages_manage_engagement', target_ids: ['1'] }, { scope: 'instagram_manage_comments', target_ids: ['555'] }] }
    expect(accountScopes(grant, { kind: 'facebook_page', externalId: '1' })).toEqual(grant.scopes)
    expect(accountScopes(grant, { kind: 'facebook_page', externalId: '2' })).toEqual(['pages_manage_posts', 'instagram_manage_comments'])
    expect(accountScopes(grant, { kind: 'instagram_account', externalId: '777' })).toEqual(grant.scopes)
  })

  it('records the granted scopes of each connected account from debug_token', async () => {
    const { adapter } = meta([
      json({ access_token: 'short-user' }),
      json({ access_token: 'long-user', expires_in: 5_184_000 }),
      json({ data: [{ id: '1', name: 'Leonessa', access_token: 'page-1', tasks: ['CREATE_CONTENT'], instagram_business_account: { id: '17841', username: 'leonessa' } },
        { id: '3', name: 'Client', access_token: 'page-3', tasks: ['CREATE_CONTENT'] }] }),
      json({ data: { scopes: ['pages_manage_posts', 'pages_manage_engagement'], granular_scopes: [{ scope: 'pages_manage_engagement', target_ids: ['1'] }] } }),
    ])
    const accounts = await adapter.finishConnect(metaApp, 'code')
    expect(accounts.map(account => [account.externalId, account.grantedScopes])).toEqual([
      ['1', ['pages_manage_posts', 'pages_manage_engagement']], ['17841', ['pages_manage_posts', 'pages_manage_engagement']], ['3', ['pages_manage_posts']]])
  })
  it('subscribes each Page granted messaging to the app, and keeps the connect when Meta refuses', async () => {
    const { adapter, calls } = meta([
      json({ access_token: 'short-user' }),
      json({ access_token: 'long-user', expires_in: 5_184_000 }),
      json({ data: [{ id: '1', name: 'Leonessa', access_token: 'page-1', tasks: ['CREATE_CONTENT'] },
        { id: '3', name: 'Client', access_token: 'page-3', tasks: ['CREATE_CONTENT'] },
        { id: '4', name: 'Other', access_token: 'page-4', tasks: ['CREATE_CONTENT'] }] }),
      json({ data: { scopes: ['pages_manage_posts', 'pages_messaging'], granular_scopes: [{ scope: 'pages_messaging', target_ids: ['1', '3'] }] } }),
      json({ success: true }),
      graphError(403, 200, { message: 'Requires pages_manage_metadata permission' }),
    ])
    const accounts = await adapter.finishConnect(metaApp, 'code')
    expect(accounts.map(account => account.externalId)).toEqual(['1', '3', '4'])
    const subscribes = calls.filter(call => call.url.pathname.endsWith('/subscribed_apps'))
    expect(subscribes.map(call => `${call.method} ${call.url.pathname} ${call.headers.Authorization}`)).toEqual([
      'POST /v26.0/1/subscribed_apps Bearer page-1', 'POST /v26.0/3/subscribed_apps Bearer page-3'])
    expect((subscribes[0]!.body as URLSearchParams).get('subscribed_fields')).toBe('messages,message_echoes,messaging_postbacks')
  })
})

describe('Instagram login replies', () => {
  it('replies on graph.instagram.com with the account token and names its own permission', async () => {
    const { adapter, calls } = instagramLogin([json({ id: '17999' }), graphError(403, 10, { message: 'Requires instagram_business_manage_comments permission' })])
    expect(adapter.replyRules('instagram_account')).toEqual({ permission: 'instagram_business_manage_comments', maxLength: 2_200 })
    expect(await adapter.reply(instagramApp, replyInput(igAccount, { targetExternalId: '17900' }))).toEqual({ kind: 'sent', externalId: '17999' })
    expect(calls[0]!.url.href.startsWith('https://graph.instagram.com/v26.0/17900/replies')).toBe(true)
    expect((calls[0]!.body as URLSearchParams).has('appsecret_proof')).toBe(false)
    expect(await adapter.reply(instagramApp, replyInput(igAccount))).toMatchObject({ code: 'missing_permission', permission: 'instagram_business_manage_comments' })
  })

  it('reads the granted permissions from the code exchange, wrapped in data or not', async () => {
    for (const exchange of [
      { data: [{ access_token: 'short', user_id: '17841', permissions: 'instagram_business_basic,instagram_business_manage_comments' }] },
      { access_token: 'short', user_id: 17841, permissions: ['instagram_business_basic', 'instagram_business_manage_comments'] },
    ]) {
      const { adapter } = instagramLogin([json(exchange), json({ access_token: 'IGAA-long', token_type: 'bearer', expires_in: 5_183_944 }),
        json({ user_id: '17841', username: 'orbvora' })])
      const [account] = await adapter.finishConnect(instagramApp, 'code')
      expect(account).toMatchObject({ externalId: '17841', token: 'IGAA-long', grantedScopes: ['instagram_business_basic', 'instagram_business_manage_comments'] })
    }
    const { adapter } = instagramLogin([json({ access_token: 'short' }), json({ access_token: 'IGAA-long', expires_in: 5_183_944 }), json({ user_id: '17841' })])
    expect((await adapter.finishConnect(instagramApp, 'code'))[0]!.grantedScopes).toBeUndefined()
  })
})

describe('YouTube replies', () => {
  it('asks for youtube.force-ssl and records the granted scopes at connect and renewal', async () => {
    expect(defaultYoutubeScopes).toContain(youtubeReplyScope)
    const { adapter } = youtube([
      json({ access_token: 'ya29.new', expires_in: 3599, refresh_token: '1//refresh', scope: `https://www.googleapis.com/auth/youtube.upload ${youtubeReplyScope}` }),
      json({ items: [{ id: ytChannel.externalId, snippet: { title: 'OrbVora' } }] }),
      json({ access_token: 'ya29.renewed', expires_in: 3599, scope: 'https://www.googleapis.com/auth/youtube.upload' }),
    ])
    expect((await adapter.finishConnect(googleApp, 'code'))[0]!.grantedScopes).toEqual(['https://www.googleapis.com/auth/youtube.upload', youtubeReplyScope])
    expect((await adapter.refreshCredential(googleApp, { accessToken: 'old', refreshToken: '1//refresh', expiresAt: null })).grantedScopes)
      .toEqual(['https://www.googleapis.com/auth/youtube.upload'])
    expect(new URL(adapter.authorizeUrl(googleApp, 'state')).searchParams.get('scope')).toContain('youtube.force-ssl')
  })

  it('inserts a reply under the top-level comment and links to it on the video', async () => {
    const { adapter, calls } = youtube([json({ id: 'Ug1.r9', snippet: { textOriginal: 'Grazie mille!', publishedAt: '2030-01-01T10:00:00Z' } })])
    expect(adapter.replyRules('youtube_channel')).toEqual({ permission: youtubeReplyScope, maxLength: 10_000 })
    expect(await adapter.reply(googleApp, replyInput(ytChannel, { postExternalId: 'tNnu5T9_KjU', targetExternalId: 'Ug1' })))
      .toEqual({ kind: 'sent', externalId: 'Ug1.r9', url: 'https://www.youtube.com/watch?v=tNnu5T9_KjU&lc=Ug1.r9' })
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url.href).toBe('https://www.googleapis.com/youtube/v3/comments?part=snippet')
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ snippet: { parentId: 'Ug1', textOriginal: 'Grazie mille!' } })
  })

  it('maps refusals, quota and lost answers', async () => {
    const cases: Array<[Reply, Record<string, unknown>]> = [
      [timeout, { kind: 'uncertain', code: 'response_lost' }],
      [googleError(500, 'backendError'), { kind: 'uncertain', code: 'platform_error' }],
      [refused, { kind: 'failed', retryable: true, code: 'unreachable' }],
      [googleError(403, 'quotaExceeded'), { kind: 'failed', retryable: false, code: 'quota_exceeded' }],
      [googleError(403, 'rateLimitExceeded'), { kind: 'failed', retryable: true, code: 'rate_limited' }],
      [googleError(403, 'insufficientPermissions'), { kind: 'failed', retryable: false, code: 'missing_permission', permission: youtubeReplyScope }],
      // `forbidden` is about this comment or video, not the grant's scopes.
      [googleError(403, 'forbidden'), { kind: 'failed', retryable: false, code: 'reply_not_allowed' }],
      [googleError(401, 'authError'), { kind: 'failed', code: 'channel_inactive', reauth: true }],
      [googleError(404, 'parentCommentNotFound'), { kind: 'failed', code: 'comment_gone' }],
      [googleError(400, 'commentTextTooLong'), { kind: 'failed', code: 'text_too_long' }],
      [googleError(400, 'operationNotSupported'), { kind: 'failed', code: 'reply_not_allowed' }],
      [googleError(400, 'processingFailure'), { kind: 'failed', retryable: false, code: 'rejected' }],
    ]
    for (const [reply, expected] of cases) {
      const { adapter } = youtube([reply])
      expect(await adapter.reply(googleApp, replyInput(ytChannel))).toMatchObject(expected)
    }
  })

  it('finds the channel\'s own reply by its author channel and original text', async () => {
    const reply = (id: string, author: string, extra: Record<string, unknown> = {}) => ({ id, snippet: { authorChannelId: { value: author },
      textDisplay: 'Grazie mille!', publishedAt: '2030-01-01T10:01:00Z', ...extra } })
    const { adapter, calls } = youtube([json({ nextPageToken: 'p2', items: [reply('Ug1.a', 'UCother0000000000000000000')] }),
      json({ items: [reply('Ug1.b', ytChannel.externalId, { textOriginal: 'Grazie  mille!', textDisplay: 'Grazie mille! (edited)' })] })])
    let spent = 0
    expect(await adapter.findReply(googleApp, findInput(ytChannel, { postExternalId: 'tNnu5T9_KjU', targetExternalId: 'Ug1', spendCall: () => { spent++ } })))
      .toEqual({ kind: 'found', externalId: 'Ug1.b', url: 'https://www.youtube.com/watch?v=tNnu5T9_KjU&lc=Ug1.b' })
    expect(spent).toBe(1)
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ part: 'snippet', parentId: 'Ug1', maxResults: '100', textFormat: 'plainText' })
    expect(calls[1]!.url.searchParams.get('pageToken')).toBe('p2')
    const quota = youtube([googleError(403, 'quotaExceeded')])
    await expect(quota.adapter.findReply(googleApp, findInput(ytChannel))).rejects.toBeInstanceOf(RateLimited)
  })
})
