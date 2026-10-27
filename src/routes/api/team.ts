/**
 * team.ts — workspace members.
 *   GET    /api/team              → list members (any member)
 *   POST   /api/team              → add a teammate by email (admin)
 *   PATCH  /api/team/:userId      → change role (admin)
 *   DELETE /api/team/:userId      → remove from workspace (admin)
 *
 * Adding a teammate creates (or finds) their Supabase Auth user and a membership row.
 * No email is sent by us: they sign in at the dashboard with a magic link.
 * A workspace can never lose its last admin.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { getDb } from '../../db/client.js'
import { addMember } from '../../repositories/org-members.repository.js'

type MemberRow = { user_id: string; email: string; role: 'admin' | 'member'; created_at: string }

const err = (req: FastifyRequest, reply: FastifyReply, status: number, error: string, message: string) =>
  reply.status(status).send({ error, message, requestId: req.id })

async function listMembers(orgId: string): Promise<MemberRow[]> {
  const { data, error } = await getDb()
    .from('org_members')
    .select('user_id, email, role, created_at')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`listMembers failed: ${error.message}`)
  return (data ?? []) as MemberRow[]
}

/** Finds or creates the auth user for an email, without sending any email. */
async function resolveAuthUserId(email: string): Promise<string> {
  const admin = getDb().auth.admin
  const created = await admin.createUser({ email, email_confirm: true })
  if (created.data.user) return created.data.user.id
  // Already registered: generateLink returns the existing user without emailing them.
  const link = await admin.generateLink({ type: 'magiclink', email })
  if (link.data.user) return link.data.user.id
  throw new Error(`resolveAuthUserId failed: ${created.error?.message ?? link.error?.message ?? 'unknown'}`)
}

export async function teamRoutes(app: FastifyInstance) {
  app.get('/', async (request, reply) => {
    const members = await listMembers(request.tenantContext.organizationId)
    return reply.send({
      members: members.map(m => ({ userId: m.user_id, email: m.email, role: m.role, addedAt: m.created_at })),
    })
  })

  app.post<{ Body: { email: string; role: 'admin' | 'member' } }>('/', {
    schema: {
      body: {
        type: 'object', required: ['email', 'role'], additionalProperties: false,
        properties: {
          email: { type: 'string', format: 'email', maxLength: 320 },
          role: { type: 'string', enum: ['admin', 'member'] },
        },
      },
    },
  }, async (request, reply) => {
    const { organizationId } = request.tenantContext
    const email = request.body.email.trim().toLowerCase()
    const members = await listMembers(organizationId)
    if (members.some(m => m.email.toLowerCase() === email)) {
      return err(request, reply, 409, 'ALREADY_MEMBER', `${email} is already in this workspace.`)
    }
    let userId: string
    try {
      userId = await resolveAuthUserId(email)
    } catch (e) {
      request.log.error({ e }, 'team add: auth user lookup failed')
      return err(request, reply, 502, 'INVITE_FAILED', 'Could not add this person. Please try again.')
    }
    await addMember(organizationId, userId, email, request.body.role)
    return reply.status(201).send({ member: { userId, email, role: request.body.role } })
  })

  app.patch<{ Params: { userId: string }; Body: { role: 'admin' | 'member' } }>('/:userId', {
    schema: {
      params: { type: 'object', properties: { userId: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', required: ['role'], additionalProperties: false, properties: { role: { type: 'string', enum: ['admin', 'member'] } } },
    },
  }, async (request, reply) => {
    const { organizationId } = request.tenantContext
    const members = await listMembers(organizationId)
    const target = members.find(m => m.user_id === request.params.userId)
    if (!target) return err(request, reply, 404, 'NOT_FOUND', 'Member not found.')
    if (target.role === 'admin' && request.body.role === 'member' && members.filter(m => m.role === 'admin').length === 1) {
      return err(request, reply, 409, 'LAST_ADMIN', 'A workspace needs at least one admin.')
    }
    const { error } = await getDb().from('org_members').update({ role: request.body.role, updated_at: new Date().toISOString() })
      .eq('organization_id', organizationId).eq('user_id', target.user_id)
    if (error) throw new Error(`role update failed: ${error.message}`)
    return reply.send({ member: { userId: target.user_id, email: target.email, role: request.body.role } })
  })

  app.delete<{ Params: { userId: string } }>('/:userId', {
    schema: { params: { type: 'object', properties: { userId: { type: 'string', format: 'uuid' } } } },
  }, async (request, reply) => {
    const { organizationId } = request.tenantContext
    const members = await listMembers(organizationId)
    const target = members.find(m => m.user_id === request.params.userId)
    if (!target) return err(request, reply, 404, 'NOT_FOUND', 'Member not found.')
    if (target.role === 'admin' && members.filter(m => m.role === 'admin').length === 1) {
      return err(request, reply, 409, 'LAST_ADMIN', 'A workspace needs at least one admin.')
    }
    const { error } = await getDb().from('org_members').delete().eq('organization_id', organizationId).eq('user_id', target.user_id)
    if (error) throw new Error(`member delete failed: ${error.message}`)
    return reply.status(204).send()
  })
}
