/**
 * src/db/client.ts — Supabase service-role singleton
 *
 * RULES (non-negotiable):
 *   1. Use getDb() everywhere — never call createClient() in application code.
 *   2. This client uses SERVICE_KEY and bypasses RLS (server-side only).
 *   3. Node 20 has no native WebSocket. We pass `ws` as the Realtime transport.
 *      This is the documented Supabase approach for Node < 22.
 *      Node 22+ has native WebSocket; the option is harmlessly ignored there.
 *
 * Why not globalThis.WebSocket = ws?
 *   The `globalThis` approach requires either:
 *     a) A top-level await (breaks CommonJS, breaks some ESM bundlers), or
 *     b) require() (only available in CJS, not in ESM output).
 *   Passing `transport: ws` to createClient is the correct, synchronous,
 *   ESM-compatible, bundler-safe, and officially-documented approach.
 *
 * Why not use the `realtime: { transport: ws }` option?
 *   The `transport` option on RealtimeClient accepts a WebSocket constructor.
 *   We pass it as `global.WebSocket` would be set — `ws` itself (as a class).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import ws from 'ws'

let _client: SupabaseClient | undefined

export function getDb(): SupabaseClient {
  if (_client) return _client

  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY

  if (!url || !key) {
    throw new Error(
      '[db/client] SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in environment before calling getDb()'
    )
  }

  _client = createClient(url, key, {
    auth: {
      persistSession:   false,
      autoRefreshToken: false,
    },
    // Node 20 has no native WebSocket. Pass `ws` as the transport so
    // @supabase/realtime-js can construct a WebSocket without crashing.
    // This is the officially-documented workaround for Node < 22.
    realtime: {
      transport: ws as any,
    },
  })

  return _client
}

/** For tests only: reset the singleton between test runs. */
export function _resetDbClient(): void {
  _client = undefined
}
