-- Migration: 012_routing_state.sql
-- Description: Persistent round-robin counters per queue per organization.
--              RoutingAgent reads this — never uses Math.random() or in-memory state.
--              Survives service restarts.
-- Rollback: see bottom of file

-- FORWARD MIGRATION

CREATE TABLE routing_state (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  queue_name              VARCHAR(255) NOT NULL,            -- e.g. 'us-smb', 'emea-enterprise'
  counter                 INTEGER NOT NULL DEFAULT 0,       -- incremented on each assignment
  last_assigned_owner_id  VARCHAR(255),                     -- Salesforce user ID of last assignee
  last_assigned_at        TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_routing_state_org_queue
    UNIQUE (organization_id, queue_name)
);

CREATE INDEX idx_routing_state_organization_id ON routing_state(organization_id);
CREATE INDEX idx_routing_state_queue_name      ON routing_state(organization_id, queue_name);

-- ROLLBACK
-- DROP INDEX IF EXISTS idx_routing_state_queue_name;
-- DROP INDEX IF EXISTS idx_routing_state_organization_id;
-- DROP TABLE IF EXISTS routing_state;
