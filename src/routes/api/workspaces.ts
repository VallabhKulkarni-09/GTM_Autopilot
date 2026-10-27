/**
 * workspaces.ts
 *   GET  /api/me          → who am I, which workspace, which role, is setup finished
 *   POST /api/workspaces  → first sign-in: create a workspace, become its admin
 *
 * Both are callable by a signed-in user who has no workspace yet (config.allowNoWorkspace).
 */

import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'crypto'
import { getDb } from '../../db/client.js'
import { addMember } from '../../repositories/org-members.repository.js'
import { seedDefaultPolicies } from '../../policies/default-policies.js'

function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'workspace'
  return `${base}-${randomBytes(3).toString('hex')}`
}

export async function meRoutes(app: FastifyInstance) {
  app.get('/', { config: { allowNoWorkspace: true } }, async (request, reply) => {
    const { userId, email } = request.authUser
    const ctx = request.tenantContext
    if (!ctx) return reply.send({ user: { id: userId, email }, workspace: null, role: null })

    const { data } = await getDb()
      .from('organizations')
      .select('id, name, setup_completed_at')
      .eq('id', ctx.organizationId)
      .single()

    return reply.send({
      user: { id: userId, email },
      workspace: data ? { id: data.id, name: data.name, setupCompleted: Boolean(data.setup_completed_at) } : null,
      role: ctx.role,
    })
  })
}

export async function workspaceRoutes(app: FastifyInstance) {
  app.post<{ Body: { name: string } }>('/', {
    config: { allowNoWorkspace: true },
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: { name: { type: 'string', minLength: 2, maxLength: 120 } },
      },
    },
  }, async (request, reply) => {
    if (request.tenantContext) {
      return reply.status(409).send({ error: 'ALREADY_IN_WORKSPACE', message: 'You already belong to a workspace.', requestId: request.id })
    }
    const { userId, email } = request.authUser
    const name = request.body.name.trim()
    const db = getDb()

    const { data: org, error } = await db
      .from('organizations')
      .insert({ name, slug: slugify(name), is_active: true })
      .select('id, name')
      .single()
    if (error || !org) {
      request.log.error({ error }, 'workspace create failed')
      return reply.status(500).send({ error: 'WORKSPACE_CREATE_FAILED', message: 'Could not create the workspace. Please try again.', requestId: request.id })
    }

    try {
      await addMember(org.id, userId, email ?? '', 'admin')
      await seedDefaultPolicies(org.id)
    } catch (err) {
      request.log.error({ err }, 'workspace bootstrap failed — rolling back org')
      await db.from('organizations').delete().eq('id', org.id)
      return reply.status(500).send({ error: 'WORKSPACE_CREATE_FAILED', message: 'Could not create the workspace. Please try again.', requestId: request.id })
    }

    return reply.status(201).send({ workspace: { id: org.id, name: org.name, setupCompleted: false }, role: 'admin' })
  })
}
