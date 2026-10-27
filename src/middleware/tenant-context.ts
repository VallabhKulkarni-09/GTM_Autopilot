/**
 * tenant-context.ts — authenticates /api/* requests with a Supabase Auth access token.
 *
 * 1. Verify the Bearer token with `jose`:
 *      HS256  → SUPABASE_JWT_SECRET (legacy Supabase projects)
 *      ES256 / RS256 → the project's JWKS (${SUPABASE_URL}/auth/v1/.well-known/jwks.json)
 *    Any other alg is rejected. `iss`, `aud` ('authenticated') and `exp` are required.
 * 2. request.authUser = { userId: sub, email }
 * 3. organization_id + role come ONLY from org_members (server-side lookup).
 *    Any organization claim inside the token is ignored.
 *    Optional `x-workspace-id` header picks among the user's OWN memberships.
 * 4. No membership → 403 NO_WORKSPACE, unless the route sets config.allowNoWorkspace.
 */

import type { FastifyRequest, FastifyReply } from 'fastify'
import { jwtVerify, createRemoteJWKSet, decodeProtectedHeader, type JWTPayload } from 'jose'
import { getMembershipsForUser, type MembershipRow } from '../repositories/org-members.repository.js'
import './types.js'

type Deps = {
  getMemberships: (userId: string) => Promise<MembershipRow[]>
}

const ASYMMETRIC_ALGS = new Set(['ES256', 'RS256'])
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null

function authConfig() {
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '')
  if (!supabaseUrl) return null
  return { issuer: `${supabaseUrl}/auth/v1`, secret: process.env.SUPABASE_JWT_SECRET, supabaseUrl }
}

/** Verifies a Supabase access token. Throws on any problem. */
export async function verifySupabaseToken(token: string): Promise<JWTPayload> {
  const cfg = authConfig()
  if (!cfg) throw new Error('AUTH_NOT_CONFIGURED')

  const { alg } = decodeProtectedHeader(token)
  const common = { issuer: cfg.issuer, audience: 'authenticated', requiredClaims: ['sub', 'exp'] }

  if (alg === 'HS256') {
    if (!cfg.secret) throw new Error('HS256 token but SUPABASE_JWT_SECRET is not set')
    const { payload } = await jwtVerify(token, new TextEncoder().encode(cfg.secret), { ...common, algorithms: ['HS256'] })
    return payload
  }
  if (alg && ASYMMETRIC_ALGS.has(alg)) {
    jwks ??= createRemoteJWKSet(new URL(`${cfg.supabaseUrl}/auth/v1/.well-known/jwks.json`))
    const { payload } = await jwtVerify(token, jwks, { ...common, algorithms: [...ASYMMETRIC_ALGS] })
    return payload
  }
  throw new Error(`Unsupported JWT alg: ${String(alg)}`)
}

function deny(request: FastifyRequest, reply: FastifyReply, status: number, error: string, message: string) {
  return reply.status(status).send({ error, message, requestId: request.id })
}

export function createTenantContextMiddleware(deps: Deps) {
  return async function tenantContextMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const authHeader = request.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return deny(request, reply, 401, 'MISSING_TOKEN', 'Please sign in.')
    }

    if (!authConfig()) {
      request.log.error('SUPABASE_URL is not set — cannot verify user tokens')
      return deny(request, reply, 401, 'AUTH_NOT_CONFIGURED', 'Sign-in is not configured on this server.')
    }

    let payload: JWTPayload
    try {
      payload = await verifySupabaseToken(authHeader.slice(7))
    } catch {
      return deny(request, reply, 401, 'INVALID_TOKEN', 'Your session is invalid or has expired. Please sign in again.')
    }

    const userId = payload.sub as string
    const email = typeof payload.email === 'string' ? payload.email : null
    request.authUser = { userId, email }

    let memberships: MembershipRow[]
    try {
      memberships = await deps.getMemberships(userId)
    } catch (err) {
      request.log.error({ err }, 'membership lookup failed')
      return deny(request, reply, 500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.')
    }

    const requested = request.headers['x-workspace-id']
    const membership = typeof requested === 'string'
      ? memberships.find(m => m.organization_id === requested)
      : memberships[0]

    if (!membership) {
      if (request.routeOptions.config?.allowNoWorkspace) return
      return deny(request, reply, 403, 'NO_WORKSPACE', 'You are not part of a workspace yet.')
    }

    request.tenantContext = { organizationId: membership.organization_id, userId, role: membership.role }
  }
}

export const tenantContextMiddleware = createTenantContextMiddleware({ getMemberships: getMembershipsForUser })

/** preHandler for write routes: admins only. Use after tenantContextMiddleware. */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.tenantContext?.role !== 'admin') {
    return deny(request, reply, 403, 'ADMIN_REQUIRED', 'Only workspace admins can change this.')
  }
}
