import type { MediaFile } from '../../src/platforms/types.js'

export function mediaFile(id: string, name: string, mimeType: string, data: Buffer = Buffer.alloc(0), parts = [data]): MediaFile {
  return { id, name, mimeType, sizeBytes: data.length, chunks: async function* () { yield* parts } }
}
