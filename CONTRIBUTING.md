# Contributing

Thanks for helping. GTM Autopilot is used by sales and RevOps people who never touch code, so
changes are judged first by whether a non-technical admin can understand and trust the result.

## Before you start

- For anything bigger than a bug fix, open an issue first so we can agree on scope. The supported
  tools are HubSpot (inbound forms), Salesforce and Apollo. Code for other connectors is in the
  repository but not wired in.
- Read [docs/architecture.md](docs/architecture.md) for how the pieces fit together. The rules
  below are the ones reviews check.

## Ground rules

1. **Workspace isolation.** Every table and query carries `organization_id`, and it always comes
   from the signed-in user's membership (`request.tenantContext`), never from the body, query,
   params or token claims. Another workspace's records answer **404**, not 403.
2. **The event log is append-only.** No `UPDATE` or `DELETE` on `event_log`, in code or
   migrations. Each action writes `action_proposed` → `action_execution_started` →
   `action_execution_succeeded|failed`, and every event has a full `decision_snapshot`.
3. **Agents propose, executors act.** Agent → ProposedAction → RiskValidator → PolicyValidator →
   ActionExecutor → Connector. Agents never call connectors or the database.
4. **Connectors throw `ConnectorError` only**, and every write takes an idempotency key
   (`${organizationId}:${workflowRunId}:${actionId}`), checked before the external call.
5. **Response-time deadlines start at `form_submitted_at`**, never `created_at`.
6. **Never silently default.** Missing configuration throws or records an explicit
   skipped/failed event that the timeline can explain.
7. **Plain language in the UI.** No raw codes or event names outside "Developer details".
   New event types need a description in `dashboard/src/lib/describe-event.ts` (the compiler
   enforces this).

## Development setup

Requirements: Node 20, Docker.

```bash
npm ci && npm run build
eval "$(scripts/ci/test-db.sh)"     # throwaway local Supabase with every migration applied
CI=true npm run test:run            # CI=true: database-backed suites run instead of skipping
scripts/ci/test-db.sh stop

cd dashboard
npm ci
npx tsc --noEmit && npm run build
npx playwright install chromium
npx playwright test                  # real dashboard against e2e/stub-server.mjs
```

Never point tests at a real Supabase project: they create and delete rows.

## Changes that need extra care

- **Migrations**: add the next number in `db/migrations/` (never edit or renumber an applied one;
  the runner rejects changed checksums). Follow the header/rollback layout of the existing files.
  `ALTER TYPE … ADD VALUE` must be in a file of its own: it cannot run in a transaction or be
  rolled back.
- **New routes or queries**: add a cross-tenant test in `tests/security/` showing another
  workspace gets 404 and is never read or written.
- **Connectors**: anything that calls HubSpot, Salesforce or Apollo is only done once it has run
  against the real service; capture real (redacted) responses as fixtures instead of guessing shapes.
- **AI agents**: a change to a prompt, the reply format or the agent logic must bump its version
  (`PROMPT_VERSION` / `ROUTING_PROMPT_VERSION` and the agent version). Workspaces then have to rerun
  the test leads before the agent is used again. Add a golden case in
  `src/evaluation/datasets/golden.ts` for any new behaviour.
- **Dependencies**: pin exact versions and explain why the package is needed. The dashboard pins
  TypeScript 5.8.3 and Tailwind 3.4.17.

## Pull requests

- Keep each PR to one change, with a description of what changed, how you tested it, and
  anything you could not verify.
- CI must pass: typecheck, unit + security tests, dashboard build, Playwright and the secret scan.
- Do not commit `.env` files, real credentials, customer data, or account identifiers (portal
  IDs, Salesforce record IDs, project refs) in code, fixtures or docs.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same license as the project.
