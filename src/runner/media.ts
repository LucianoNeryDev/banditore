import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import type { Action } from './actions.js'

const maxBytes = 1024 * 1024 * 1024
const extensions: Record<string, string> = { 'video/mp4': 'mp4', 'image/jpeg': 'jpg', 'image/png': 'png' }

/** Fetches an action's media from the engine's signed URLs into a private temporary directory. */
export async function downloadMedia(action: Action, fetcher: typeof fetch = fetch) {
  const directory = await mkdtemp(join(tmpdir(), 'runner-media-'))
  const cleanup = () => rm(directory, { recursive: true, force: true })
  try {
    const files: string[] = []
    for (const [index, medium] of action.media.entries()) {
      const response = await fetcher(medium.url, { redirect: 'error', signal: AbortSignal.timeout(15 * 60_000) })
      if (!response.ok || !response.body || response.headers.get('content-type') !== medium.mimeType) throw new Error(`Media ${index + 1} could not be fetched (${response.status})`)
      const path = join(directory, `${index + 1}.${extensions[medium.mimeType]}`)
      let size = 0
      await pipeline(Readable.fromWeb(response.body as NodeReadableStream), async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          size += chunk.length
          if (size > maxBytes) throw new Error(`Media ${index + 1} has an unexpected size`)
          yield chunk
        }
      }, createWriteStream(path, { mode: 0o600 }))
      if (!size) throw new Error(`Media ${index + 1} has an unexpected size`)
      files.push(path)
    }
    return { files, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}
