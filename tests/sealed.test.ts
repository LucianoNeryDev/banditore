import { describe, expect, it } from 'vitest'
import { isRunnerPublicKey, openSecret, runnerKeyPair, sealSecret } from '../src/crypto/sealed.js'

const secret = JSON.stringify({ username: 'bottega.digitale', password: 'correct horse battery staple', totp: 'JBSWY3DPEHPK3PXP' })

describe('sealed secrets', () => {
  const runner = runnerKeyPair()

  it('opens with the runner key and never repeats ciphertext', () => {
    const first = sealSecret(runner.publicKey, 'account-1', secret)
    const second = sealSecret(runner.publicKey, 'account-1', secret)
    expect(openSecret(runner.privateKey, 'account-1', first)).toBe(secret)
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false)
    expect(first.ciphertext.includes(Buffer.from('correct horse'))).toBe(false)
  })

  it('refuses another account, another runner and tampered blobs', () => {
    const sealed = sealSecret(runner.publicKey, 'account-1', secret)
    expect(() => openSecret(runner.privateKey, 'account-2', sealed)).toThrow()
    expect(() => openSecret(runnerKeyPair().privateKey, 'account-1', sealed)).toThrow()
    const flipped = Buffer.from(sealed.ciphertext)
    flipped[0]! ^= 1
    expect(() => openSecret(runner.privateKey, 'account-1', { ...sealed, ciphertext: flipped })).toThrow()
    expect(() => openSecret(runner.privateKey, 'account-1', { ...sealed, nonce: Buffer.alloc(8) })).toThrow('Malformed')
  })

  it('recognises runner public keys', () => {
    expect(isRunnerPublicKey(runner.publicKey)).toBe(true)
    expect(isRunnerPublicKey('not-a-key')).toBe(false)
    expect(isRunnerPublicKey(Buffer.alloc(31).toString('base64url'))).toBe(false)
  })
})
