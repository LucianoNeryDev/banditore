import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export interface Keyring {
  activeKeyId: string
  keys: Map<string, Buffer>
}

export interface SealedToken {
  keyId: string
  nonce: Buffer
  ciphertext: Buffer
}

const tagLength = 16

/**
 * AES-256-GCM. The associated data binds a ciphertext to one channel, so a
 * row copied onto another channel fails to open.
 */
export function sealToken(keyring: Keyring, plaintext: string, associatedData: string): SealedToken {
  const key = keyring.keys.get(keyring.activeKeyId)
  if (!key) throw new Error('Active token key missing')
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: tagLength })
  cipher.setAAD(Buffer.from(`${keyring.activeKeyId}:${associatedData}`))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return { keyId: keyring.activeKeyId, nonce, ciphertext }
}

export function openToken(keyring: Keyring, sealed: SealedToken, associatedData: string): string {
  const key = keyring.keys.get(sealed.keyId)
  if (!key) throw new Error('Token key not available')
  if (sealed.nonce.length !== 12 || sealed.ciphertext.length <= tagLength) throw new Error('Malformed token envelope')
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce, { authTagLength: tagLength })
  decipher.setAAD(Buffer.from(`${sealed.keyId}:${associatedData}`))
  decipher.setAuthTag(sealed.ciphertext.subarray(-tagLength))
  return Buffer.concat([decipher.update(sealed.ciphertext.subarray(0, -tagLength)), decipher.final()]).toString('utf8')
}

export function channelTokenContext(channelId: string) {
  return `channel:${channelId}`
}
