-- Migration: 017_event_type_account_match.sql
-- Description: Add account_match event types to the event_type enum.
--              The account-match node was added after migration 009 defined the enum.
-- Apply via: Supabase Dashboard → SQL Editor

ALTER TYPE event_type ADD VALUE IF NOT EXISTS 'account_match_found';
ALTER TYPE event_type ADD VALUE IF NOT EXISTS 'account_match_no_match';
ALTER TYPE event_type ADD VALUE IF NOT EXISTS 'account_match_error';
