/**
 * url-guard.ts — SSRF check for admin-set model base URLs (local providers only).
 *
 * Allowed: http(s), no username/password, every resolved address outside the blocked ranges.
 * Loopback and private ranges ARE allowed on purpose: that is where the host's Ollama and Docker live.
 * Blocked: cloud metadata / link-local, "this network", multicast, broadcast, reserved.
 * Checked at save time and again before every request (resolution can change).
 * Redirects are refused by the adapters, so a server cannot bounce us to a blocked address.
 */
import { BlockList, isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

const blocked = new BlockList()
blocked.addSubnet('0.0.0.0', 8, 'ipv4')          // "this network"
blocked.addSubnet('169.254.0.0', 16, 'ipv4')     // link-local incl. 169.254.169.254 metadata
blocked.addSubnet('192.0.0.0', 24, 'ipv4')       // IETF protocol assignments (incl. some metadata)
blocked.addSubnet('224.0.0.0', 4, 'ipv4')        // multicast
blocked.addSubnet('240.0.0.0', 4, 'ipv4')        // reserved + broadcast
blocked.addAddress('::', 'ipv6')                 // unspecified
blocked.addSubnet('fe80::', 10, 'ipv6')          // link-local
blocked.addSubnet('ff00::', 8, 'ipv6')           // multicast
blocked.addAddress('fd00:ec2::254', 'ipv6')      // AWS IPv6 metadata

// Addresses that stay on this machine / Docker / the private network (data does not leave the user's network).
const privateRanges = new BlockList()
privateRanges.addSubnet('127.0.0.0', 8, 'ipv4')
privateRanges.addSubnet('10.0.0.0', 8, 'ipv4')
privateRanges.addSubnet('172.16.0.0', 12, 'ipv4')
privateRanges.addSubnet('192.168.0.0', 16, 'ipv4')
privateRanges.addSubnet('100.64.0.0', 10, 'ipv4')   // CGNAT / Tailscale
privateRanges.addAddress('::1', 'ipv6')
privateRanges.addSubnet('fc00::', 7, 'ipv6')         // unique local

export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped) return privateRanges.check(mapped[1], 'ipv4')
  const family = isIP(address)
  return family === 4 ? privateRanges.check(address, 'ipv4') : family === 6 ? privateRanges.check(address, 'ipv6') : false
}

export type Resolver = (host: string) => Promise<string[]>
const systemResolver: Resolver = async host => (await lookup(host, { all: true, verbatim: true })).map(a => a.address)

export class UrlBlockedError extends Error {
  constructor(message: string) { super(message); this.name = 'UrlBlockedError' }
}

export function isBlockedAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped) return blocked.check(mapped[1], 'ipv4')
  const family = isIP(address)
  if (family === 4) return blocked.check(address, 'ipv4')
  if (family === 6) return blocked.check(address, 'ipv6')
  return true // not an IP at all → refuse
}

/** Parses + normalises a base URL (no trailing slash). Throws UrlBlockedError with a plain message. */
export function parseBaseUrl(raw: string): URL {
  let url: URL
  try { url = new URL(raw.trim()) } catch { throw new UrlBlockedError('Enter a full address, for example http://host.docker.internal:11434') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UrlBlockedError('The address must start with http:// or https://')
  if (url.username || url.password) throw new UrlBlockedError('Do not put a username or password in the address')
  if (url.search || url.hash) throw new UrlBlockedError('The address cannot contain ? or #')
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url
}

/** Passes the SSRF check and reports whether every address is private (data stays in the user's network). */
export async function checkBaseUrl(raw: string, resolve: Resolver = systemResolver): Promise<{ url: URL; privateOnly: boolean }> {
  const url = await assertBaseUrlAllowed(raw, resolve)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(host) ? [host] : await resolve(host)
  return { url, privateOnly: addresses.every(isPrivateAddress) }
}

export async function assertBaseUrlAllowed(raw: string, resolve: Resolver = systemResolver): Promise<URL> {
  const url = parseBaseUrl(raw)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  let addresses: string[]
  try {
    addresses = isIP(host) ? [host] : await resolve(host)
  } catch {
    throw new UrlBlockedError(`Could not find "${host}". Check the address.`)
  }
  if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
    throw new UrlBlockedError('This address is not allowed (it points to a protected network range).')
  }
  return url
}
