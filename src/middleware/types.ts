/**
 * types.ts
 * Extends FastifyRequest with tenantContext / authUser.
 * Import this file to get type augmentation.
 */

import type { FastifyRequest } from 'fastify'

export type MemberRole = 'admin' | 'member'

export type AuthUser = {
  userId: string
  email: string | null
}

export type TenantContext = {
  organizationId: string
  userId: string
  role: MemberRole
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set for every authenticated /api/* request (including users without a workspace). */
    authUser: AuthUser
    /** Set only when the user is a member of a workspace. Resolved server-side from org_members. */
    tenantContext: TenantContext
  }
  interface FastifyContextConfig {
    /** Route may be called by a signed-in user who has no workspace yet (e.g. POST /api/workspaces). */
    allowNoWorkspace?: boolean
  }
}
