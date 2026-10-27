-- migration 020: add apollo to connector_name enum and apollo_enrichment to evidence_source_type
-- Both enums need new values before the connector code can write to DB.

-- connector_name: add 'apollo'
ALTER TYPE connector_name ADD VALUE IF NOT EXISTS 'apollo';

-- evidence_source_type: add 'apollo_enrichment'
-- These are the only two new values. Clearbit source types remain unchanged.
ALTER TYPE evidence_source_type ADD VALUE IF NOT EXISTS 'apollo_enrichment';
