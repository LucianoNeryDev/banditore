import { describe, expect, it } from 'vitest'
import { defaultMetaScopes } from '../src/platforms/meta/adapter.js'
import { defaultYoutubeScopes, youtubeReplyScope } from '../src/platforms/youtube/adapter.js'
import { expandScope, replyOnlyScopes, scopesToPin } from '../src/provider-scopes.js'

describe('provider app scopes', () => {
  it('pins the defaults without the scopes only replies need, until the provider grants them', () => {
    expect(scopesToPin('youtube', { withoutReplies: true })).toEqual(defaultYoutubeScopes.filter(scope => scope !== youtubeReplyScope))
    expect(scopesToPin('meta', { withoutReplies: true })).toEqual(defaultMetaScopes.filter(scope => scope !== 'pages_manage_engagement'))
    // Comment reads already needed these: they stay.
    expect(scopesToPin('meta', { withoutReplies: true })).toContain('instagram_manage_comments')
    expect(replyOnlyScopes.instagram).toBeUndefined()
  })

  it('takes Google scopes by their last part, and refuses an empty list or a browser platform', () => {
    expect(expandScope('youtube', 'youtube.upload')).toBe('https://www.googleapis.com/auth/youtube.upload')
    expect(expandScope('youtube', youtubeReplyScope)).toBe(youtubeReplyScope)
    expect(expandScope('meta', ' pages_show_list ')).toBe('pages_show_list')
    expect(scopesToPin('youtube', { scopes: ['youtube.upload', 'youtube.upload', 'youtube.readonly'] }))
      .toEqual(['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'])
    expect(() => scopesToPin('youtube', { scopes: [' '] })).toThrow(/At least one/)
    expect(() => scopesToPin('reddit', { withoutReplies: true })).toThrow(/no OAuth scopes/)
  })
})
