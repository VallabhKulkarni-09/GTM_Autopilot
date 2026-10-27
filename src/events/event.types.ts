/**
 * event.types.ts
 * Event system types used by event-log.ts and event-processor.ts.
 * Imports canonical types from domain/db-types.
 */

import type {
  EventType,
  ActorType,
  EventStatus,
  EventLog,
  ConnectorName,
  DecisionSnapshot,
} from '../domain/db-types.js'

export type { EventType, ActorType, EventStatus, EventLog, ConnectorName, DecisionSnapshot }

/**
 * Input to writeEvent(). decision_snapshot is NOT optional.
 * TypeScript enforces this at compile time — no '?' on decisionSnapshot.
 */
export type WriteEventInput = {
  organizationId:  string
  workflowRunId:   string
  playInstanceId:  string
  leadId:          string
  eventType:       EventType
  actorType:       ActorType
  actorId?:        string
  agentVersion?:   string
  modelProvider?:  string
  modelName?:      string
  promptVersion?:  string
  decisionSnapshot: DecisionSnapshot   // NOT OPTIONAL. Never undefined. Never null.
  proposedAction?:  Record<string, unknown>
  candidateActions?: Record<string, unknown>[]
  policyRuleId?:    string
  policyName?:      string
  policyPassed?:    boolean
  policyDecision?:  Record<string, unknown>
  externalSystem?:  ConnectorName
  externalId?:      string
  idempotencyKey?:  string
  eventStatus:      EventStatus
  errorCode?:       string
  errorMessage?:    string
  errorRaw?:        unknown
  durationMs?:      number
}

export type EventLogRow = EventLog
