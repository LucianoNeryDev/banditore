import { z } from 'zod'
import type { AccountActivityResult, ChannelProfile, PlatformPost, PlatformPostType } from '../types.js'
import { activityPostsPerRead, clipText } from '../activity.js'
import type { GraphCall, GraphClient } from './graph.js'

const optionalText = z.string().optional().nullable()

const facebookProfileSchema = z.object({ name: optionalText, username: optionalText, about: optionalText, website: optionalText, category: optionalText,
  picture: z.object({ data: z.object({ url: optionalText }).optional() }).optional() })
const facebookPostsSchema = z.object({ data: z.array(z.object({ id: z.string().min(1).max(200), message: optionalText, created_time: optionalText,
  permalink_url: optionalText, status_type: optionalText })).default([]) })
const instagramProfileSchema = z.object({ username: optionalText, name: optionalText, biography: optionalText, website: optionalText,
  profile_picture_url: optionalText })
const instagramMediaSchema = z.object({ data: z.array(z.object({ id: z.string().min(1).max(200), caption: optionalText, media_type: optionalText,
  media_product_type: optionalText, permalink: optionalText, timestamp: optionalText })).default([]) })

const date = (value: string | null | undefined) => {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isNaN(parsed) ? null : new Date(parsed)
}

const facebookTypes: Record<string, PlatformPostType> = { added_video: 'video', added_photos: 'image', shared_story: 'link', mobile_status_update: 'text' }

/** Name, @username, about, website, category and picture of a Page, and its newest published posts. Two requests. */
export async function facebookActivity(graph: GraphClient, call: GraphCall, pageId: string): Promise<AccountActivityResult> {
  const page = facebookProfileSchema.parse(await graph.request('GET', `/${pageId}`, { ...call,
    query: { fields: 'name,username,about,website,category,picture{url}' } }))
  const posts = facebookPostsSchema.parse(await graph.request('GET', `/${pageId}/published_posts`, { ...call,
    query: { fields: 'id,message,created_time,permalink_url,status_type', limit: String(activityPostsPerRead) } }))
  const profile: ChannelProfile = { name: page.name ?? null, username: page.username ?? null, description: page.about ?? null, website: page.website ?? null,
    category: page.category ?? null, pictureUrl: page.picture?.data?.url ?? null }
  return { profile, posts: posts.data.map((post): PlatformPost => ({ externalId: post.id, type: facebookTypes[post.status_type ?? ''] ?? 'other',
    text: clipText(post.message), url: post.permalink_url ?? null, publishedAt: date(post.created_time) })) }
}

function instagramType(mediaType: string | null | undefined, productType: string | null | undefined): PlatformPostType {
  if (productType === 'REELS') return 'reel'
  return mediaType === 'CAROUSEL_ALBUM' ? 'carousel' : mediaType === 'VIDEO' ? 'video' : mediaType === 'IMAGE' ? 'image' : 'other'
}

/**
 * Username, name, biography, website and picture of an Instagram account, and
 * its newest media. Two requests. Instagram's own login gives no biography or
 * website (`login: true` leaves them out of the request).
 */
export async function instagramActivity(graph: GraphClient, call: GraphCall, userId: string, options: { login: boolean }): Promise<AccountActivityResult> {
  const fields = options.login ? 'username,name,profile_picture_url' : 'username,name,biography,website,profile_picture_url'
  const user = instagramProfileSchema.parse(await graph.request('GET', `/${userId}`, { ...call, query: { fields } }))
  const media = instagramMediaSchema.parse(await graph.request('GET', `/${userId}/media`, { ...call,
    query: { fields: 'id,caption,media_type,media_product_type,permalink,timestamp', limit: String(activityPostsPerRead) } }))
  const profile: ChannelProfile = { name: user.name ?? null, username: user.username ?? null, description: user.biography ?? null,
    website: user.website ?? null, category: null, pictureUrl: user.profile_picture_url ?? null }
  return { profile, posts: media.data.map((item): PlatformPost => ({ externalId: item.id, type: instagramType(item.media_type, item.media_product_type),
    text: clipText(item.caption), url: item.permalink ?? null, publishedAt: date(item.timestamp) })) }
}
