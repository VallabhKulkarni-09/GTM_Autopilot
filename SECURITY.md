# Security policy

GTM Autopilot stores CRM and sales-tool credentials and handles personal data about leads, so we
take reports seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through GitHub:
**Security → Report a vulnerability** on this repository (private vulnerability reporting).

Include what you found, how to reproduce it, and the impact you expect. We aim to acknowledge
reports within 3 working days and to agree a fix and disclosure date with you. We are happy to
credit you in the release notes.

Especially in scope:

- Reading or changing another workspace's data (leads, timelines, settings, connections).
- Bypassing sign-in or the admin role on `/api/*`.
- Forged or replayed HubSpot webhooks being accepted.
- Exposure of stored connector credentials or `APP_ENCRYPTION_KEY`.
- Ways to alter or remove event-log history.

## Supported versions

Security fixes go to the latest release on `main`. Please upgrade before reporting
(`git pull && docker compose up --build -d`).

## Running it safely

- Serve the API and dashboard over **HTTPS** (a reverse proxy in front of ports 3000 and 3001).
  Only `/webhooks/hubspot` needs to be reachable by HubSpot.
- Keep `.env` out of version control and readable only by the service user. Treat
  `SUPABASE_SERVICE_KEY`, `SUPABASE_JWT_SECRET`, `SUPABASE_DB_URL` and `APP_ENCRYPTION_KEY` as secrets.
- **Back up `APP_ENCRYPTION_KEY`.** Connector credentials are encrypted with it (AES-256-GCM); without
  it they cannot be read, and with it they can.
- Give the Salesforce "Run As" user and the HubSpot private app only the permissions listed in the
  README, and prefer a dedicated integration user.
- Rotate keys after anyone with access leaves: create new credentials in each tool, save them on
  the Connections page, then revoke the old ones.
- Do not expose Redis to the network; Docker Compose keeps it internal.
