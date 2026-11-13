import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { channelTokenContext, openToken, sealToken } from '../src/crypto/envelope.js'
import { redact, redactText } from '../src/crypto/redact.js'

const keyring = { activeKeyId: 'k1', keys: new Map([['k1', randomBytes(32)]]) }

describe('token envelope', () => {
  it('round-trips and never stores the plaintext', () => {
    const sealed = sealToken(keyring, 'EAAG-page-token', channelTokenContext('a'))
    expect(sealed.ciphertext.includes(Buffer.from('EAAG-page-token'))).toBe(false)
    expect(openToken(keyring, sealed, channelTokenContext('a'))).toBe('EAAG-page-token')
  })

  it('fails when the ciphertext is moved to another channel', () => {
    const sealed = sealToken(keyring, 'token', channelTokenContext('a'))
    expect(() => openToken(keyring, sealed, channelTokenContext('b'))).toThrow()
  })

  it('fails on tampering', () => {
    const sealed = sealToken(keyring, 'token', channelTokenContext('a'))
    sealed.ciphertext[0]! ^= 1
    expect(() => openToken(keyring, sealed, channelTokenContext('a'))).toThrow()
  })

  it('opens old ciphertexts after the active key rotates', () => {
    const sealed = sealToken(keyring, 'token', channelTokenContext('a'))
    const rotated = { activeKeyId: 'k2', keys: new Map([...keyring.keys, ['k2', randomBytes(32)]]) }
    expect(openToken(rotated, sealed, channelTokenContext('a'))).toBe('token')
    expect(sealToken(rotated, 'token', 'x').keyId).toBe('k2')
  })

  it('refuses unknown key ids', () => {
    const sealed = { ...sealToken(keyring, 'token', 'x'), keyId: 'gone' }
    expect(() => openToken(keyring, sealed, 'x')).toThrow('Token key not available')
  })
})

describe('redaction', () => {
  it('drops credential fields and known secret values', () => {
    expect(redact({ access_token: 'x', nested: { message: 'bad secretvalue123', code: 190 } }, ['secretvalue123']))
      .toEqual({ nested: { message: 'bad [redacted]', code: 190 } })
  })

  it('removes query-string credentials', () => {
    expect(redactText('https://graph.facebook.com/x?client_secret=abc&code=def&fields=id'))
      .toBe('https://graph.facebook.com/x?client_secret=[redacted]&code=[redacted]&fields=id')
  })
})
