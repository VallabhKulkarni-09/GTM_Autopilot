/**
 * crypto.ts — AES-256-GCM encryption for stored connector secrets.
 *
 * Key: APP_ENCRYPTION_KEY = 32 random bytes, base64.
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 * Format: "v1:<iv b64>:<auth tag b64>:<ciphertext b64>"
 * Missing / malformed key → throws. Tampered ciphertext → throws. Never returns plaintext silently.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const VERSION = 'v1'

export class EncryptionKeyError extends Error {}

function loadKey(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY
  if (!raw) throw new EncryptionKeyError('APP_ENCRYPTION_KEY is not set — cannot read or store connector credentials')
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) throw new EncryptionKeyError('APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded')
  return key
}

export function encryptJson(value: unknown): string {
  const key = loadKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':')
}

export function decryptJson<T>(payload: string): T {
  const [version, iv, tag, ct] = payload.split(':')
  if (version !== VERSION || !iv || !tag || !ct) throw new Error('Encrypted value has an unknown format')
  const decipher = createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  const pt = Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()])
  return JSON.parse(pt.toString('utf8')) as T
}
