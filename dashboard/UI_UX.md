# GTM Autopilot Dashboard — Complete UI/UX Documentation

> **Purpose of this document:** A complete, authoritative description of the GTM Autopilot dashboard UI and UX — written so an LLM can fully understand, reproduce, extend, or debug any part of the interface without ever seeing a screenshot. Covers visual language, layout, every page, every component, every interaction, every data contract, and every design decision.

---

## 1. Product Context

GTM Autopilot is a **governed decision infrastructure layer** that sits above CRM and sales engagement tools. It processes inbound leads (from HubSpot form fills), enriches them, qualifies them against ICP rules, routes them to the right SDR, and executes actions in Salesforce and Outreach — all within 15 minutes, all logged as immutable events.

The dashboard serves two distinct user types:

| User | Role | Their Job At the Screen |
|---|---|---|
| **RevOps / CRO** | Operations owner | Monitor system health, SLA compliance, pipeline quality, and per-rep performance at a glance |
| **SDR (Sales Development Rep)** | Individual contributor | Know which leads are waiting for them, understand why a lead was assigned to them, and act quickly |

The UI is designed around one Apple principle: **one screen, one job**. Every page has a single primary action or answer it delivers. Navigation is a sidebar, not tabs. Data is never raw — it is always pre-interpreted for the viewer.

---

## 2. Tech Stack

```
Framework:        Next.js 15, App Router, all pages are server components by default
Styling:          Tailwind CSS v3.4.17 (pinned — v4 breaks shadcn @apply directives)
Components:       shadcn/ui primitives (Badge, Table, Card, etc.) + custom components
Icons:            lucide-react v1.41.0
Type safety:      TypeScript 5.8.3 (strict)
Font:             System font stack: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif
Deployment:       Vercel (auto-deploy from main branch)
API base:         https://<api-host>
Auth:             1-year JWT in DASHBOARD_TOKEN env var, sent as Bearer token on every API call
```

---

## 3. Design Language

### 3.1 Color Palette

All colors are defined as CSS custom properties in `globals.css`. Tailwind classes reference these via `hsl(var(--token))`.

```
Background page:     #F9FAFB  (not pure white — a barely-warm gray, prevents harshness)
Surface (cards):     #FFFFFF  with border-gray-100 and shadow-sm
Primary accent:      #0066FF  (Apple system blue — used for active nav, pill buttons, links)
Text primary:        #1C1C1E  (Apple near-black — not pure #000)
Text secondary:      #6B7280  (gray-500)
Text muted:          #9CA3AF  (gray-400 — labels, sub-text, placeholders)
Text caption:        uppercase tracking-widest at 10-12px — always gray-400
Success green:       #34C759  (emerald-500 — fast response, completed actions)
Warning amber:       #F59E0B  (amber-400/500 — SLA threshold indicator, medium latency)
Danger red:          #EF4444  (red-500 — SLA breaches, failed events)
Active blue bg:      #EFF6FF  (blue-50 — sidebar active link background)
Active blue text:    #1D4ED8  (blue-700)
```

### 3.2 Typography

All type sizes are Tailwind classes. The system uses two weights: 400 (body) and 600-700 (headings, metrics).

```
Page title:           text-2xl font-bold     (24px, 700 weight)
Section heading:      text-base font-semibold (16px, 600 weight) inside a card
Card label / caption: text-xs font-semibold uppercase tracking-widest text-gray-400
                      (10-12px, 600 weight, spaced — the Apple "label" style)
Hero metric:          text-4xl font-bold tabular-nums  (36px — KPI numbers)
Large metric:         text-5xl font-bold tabular-nums  (48px — ICP score)
Body:                 text-sm  (14px, 400 weight)
Micro:                text-xs  (12px)
Ultra-micro:          text-[10px]  (used for avatar sub-labels, captions)
```

`tabular-nums` font-feature-setting is applied to all numeric outputs so digits do not shift width as values change.

### 3.3 Spacing

All spacing follows an 8px grid via Tailwind. Cards use `p-5` (20px) or `p-6` (24px). Section gaps are `gap-6` (24px) or `gap-8` (32px). Internal card gaps are `gap-3` (12px) or `gap-4` (16px).

### 3.4 Shapes

```
Cards:            rounded-2xl  (16px radius — modern, not corporate)
Small chips/tags: rounded-full or rounded-md
Icon containers:  rounded-xl  (12px) or rounded-lg  (8px)
Avatar circles:   rounded-full
Progress bars:    rounded-full h-2.5 (bars) or h-1.5 (thin bars in tables)
```

### 3.5 Shadows and Borders

Only one shadow level: `shadow-sm`. No layered shadows. Cards have `border border-gray-100` — subtle, 1px, nearly invisible. This creates depth through contrast, not elevation.

### 3.6 Icons

From `lucide-react`. Used at two sizes:
- **Sidebar nav:** `w-4 h-4`, strokeWidth 2 (inactive) or 2.5 (active)
- **KPI icon containers:** `w-4 h-4`, strokeWidth 2.5
- **Timeline event dots:** `w-3.5 h-3.5`, strokeWidth 2.5
- **Inline text icons:** `w-3 h-3` — always paired with a text label, never standalone

Icons in active states are always `text-blue-600`. Inactive nav icons are `text-gray-400`.

### 3.7 Empty States

Every section that can be empty has an explicit empty state — never a blank space. Empty states always have:
1. A centered icon in a muted container (`bg-gray-100` rounded square)
2. A short title (what is missing)
3. An explanatory sentence (why it is empty and what would populate it)

Empty states never say "No data" alone. They explain the cause.

---

## 4. Application Shell

### 4.1 Layout Structure

```
+----------------------------------------------------------+
|  [Sidebar 240px fixed]  |  [Main content flex-1]        |
|                         |                                |
|  Logo                   |  <page content here>           |
|  Nav links              |  max-w-6xl mx-auto             |
|  ...                    |  p-8                           |
|  System status dot      |                                |
+----------------------------------------------------------+
```

The sidebar is `fixed` — it does not scroll with content. The main content area has `ml-60` (240px left margin) and `max-w-[calc(100vw-240px)]` to prevent overflow. Content inside the main area is wrapped in `max-w-6xl mx-auto` — this caps readable content width on very wide screens.

### 4.2 Sidebar (SidebarNav — dashboard/src/components/sidebar-nav.tsx)

The sidebar is an `<aside>` element that is a 'use client' component — it needs `usePathname()` to detect the active route.

**Sections (top to bottom):**

**Logo block** (`px-5 py-5 border-b border-gray-100`):
- 28x28px rounded-lg square with `bg-blue-600` background
- Lightning bolt (`Zap`) icon from lucide, `w-4 h-4 text-white`, strokeWidth 2.5
- Product name: "GTM Autopilot" at `text-sm font-semibold text-gray-900`
- Subtitle: "Decision Layer" at `text-[10px] text-gray-400 uppercase tracking-wider`

**Navigation** (`flex-1 px-3 py-4 space-y-0.5`):
Three nav items: Overview (`/dashboard`), Leads (`/leads`), Settings (`/settings`).

Active detection: `pathname === href || pathname.startsWith(href + '/')` — so `/leads/abc123` keeps "Leads" active.

**Active link appearance:**
- Background: `bg-blue-50`
- Text: `text-blue-700`
- Icon: `text-blue-600`, strokeWidth 2.5
- Right-side indicator: `w-1 h-4 rounded-full bg-blue-600` (a 4px thin vertical pill on the right edge, via `ml-auto`)

**Inactive link appearance:**
- Text: `text-gray-600 hover:text-gray-900`
- Icon: `text-gray-400`
- Background: `hover:bg-gray-50`
- Transition: `transition-colors duration-100`

**Bottom status block** (`px-5 py-4 border-t border-gray-100`):
- 8x8px circle: `w-2 h-2 rounded-full bg-emerald-500 animate-pulse`
- Label: "System operational" at `text-xs text-gray-500`
- Static display — a future enhancement would make this dynamic from the connectors API

---

## 5. Page: Operations Overview (/dashboard)

**File:** `dashboard/src/app/dashboard/page.tsx`
**User:** RevOps / CRO
**Primary question answered:** "Is the machine working? Are we hitting our SLA? How is volume trending?"

Server component (`export const dynamic = 'force-dynamic'`). Fetches two API endpoints on every load: `/api/metrics/overview` and `/api/metrics/speed-to-lead`. No client-side state on this page.

### 5.1 Error State

If either API call fails, the entire page renders a red error card:
- `rounded-2xl border border-red-100 bg-red-50`
- `AlertTriangle` icon (lucide, red)
- Title: "Dashboard Unavailable" (font-semibold)
- Body: the raw error message
- Sub: "Check API server health and network connectivity."

The page either works completely or explains why it does not.

### 5.2 Page Header

```
Operations Overview
Last 30 days · refreshes on load      [text-sm text-gray-400]
```

### 5.3 KPI Strip (4 cards in a 2x2 / 1x4 grid)

`grid grid-cols-2 lg:grid-cols-4 gap-4` — collapses to 2 columns below `lg` breakpoint.

Each `KpiCard` is `bg-white rounded-2xl border border-gray-100 shadow-sm p-5` with:
- Row 1: `text-xs font-semibold uppercase tracking-widest text-gray-400` label (left) + icon container (right)
- Row 2: `text-4xl font-bold tabular-nums` metric value
- Row 3: `text-xs text-gray-400` sub-label (delta vs prior period or context)

**Icon container:** `w-8 h-8 rounded-xl` — blue background (`bg-blue-50`) for normal, red background (`bg-red-50`) for danger.

**The 4 KPI cards:**

| Card | Metric | Icon | Danger | Sub-text |
|---|---|---|---|---|
| Leads Qualified | `currentPeriod.totalQualified` | CheckCircle2 | No | `+N vs prior period` |
| Touched < 15 min | `currentPeriod.touchedUnder15MinPct`% | Clock | No | `+Npp vs prior period` |
| SLA Breaches | `currentPeriod.slaBreaches` | AlertTriangle | **Yes** — value turns red if > 0 | "Leads that missed the deadline" |
| Active Plays | `currentPeriod.activePlays` | Play | No | "Currently in pipeline" |

**Danger mode:** when `danger=true` AND numeric value > 0, the metric renders `text-red-600`.

### 5.4 Speed-to-Lead Distribution Card

**Header:** section title + lead count sub-label (left) + amber SLA target pill (right):
`"SLA target: 15 min"` — amber-600 text on amber-50 bg, rounded-full

**Bucket color mapping** (green → red = fast → slow):
```
under5  → bg-emerald-500   "Under 5 min"
under15 → bg-blue-500      "5 – 15 min"
under30 → bg-amber-400     "15 – 30 min"
under60 → bg-orange-500    "30 – 60 min"
over60  → bg-red-500       "Over 1 hour"
```

**Each row:** label (w-28) + bar track (flex-1 h-2.5) + count/pct (w-20 right-aligned)
Bar minimum width: `Math.max(data.pct, data.count > 0 ? 2 : 0)%` — ensures a 2% sliver is always visible for non-zero counts.

**Empty state** (when `distribution.total === 0`): centered Clock icon + "No first-touch data yet" + explanation.

### 5.5 Per-SDR Performance Card

Contains `<SdrTable stats={distribution.sdrStats} />` — a client component.

**Empty state** (when `stats.length === 0`):
- `w-12 h-12 rounded-2xl bg-gray-100` container with `Users` icon (gray-300)
- "No SDR data yet"
- "This table populates once leads are qualified and routed to a sales rep. Set up a Clearbit key and seed owners to see data here."

**Table header row:** `bg-gray-50 border-b border-gray-100 px-4 py-3` — 4 columns
- "Rep", "Median Touch", "% Under 15 min" (clickable sort button with ChevronDown/Up), "Meetings" (right-aligned)

**Sorting:** by `under15MinPct`, descending by default. The first row when `sortDesc=true` is labelled "Top performer".

**Each data row:** `grid grid-cols-4 px-4 py-3.5 items-center`
- Top performer: `bg-blue-50/40` background tint
- Other rows: `hover:bg-gray-50`

**Column 1 — Rep:**
- `w-8 h-8 rounded-full` avatar with deterministic color from name hash
- Name in `text-sm font-medium text-gray-900`
- "Top performer" in `text-[10px] text-blue-600 font-medium` (only on row #0 when sortDesc)

**Avatar color algorithm (deterministic hash):**
```typescript
const colors = ['bg-blue-500','bg-violet-500','bg-emerald-500','bg-amber-500','bg-rose-500','bg-cyan-500','bg-fuchsia-500']
let hash = 0
for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
return colors[Math.abs(hash) % colors.length]
// Same name always gets same color across all renders and pages
```

**Column 2 — Median Touch:** `{N} min` in tabular-nums

**Column 3 — % Under 15 min:** thin progress bar (h-1.5) + numeric %
- Bar color: emerald (>=80%), blue (>=50%), amber (<50%)

**Column 4 — Meetings:** right-aligned, font-semibold, tabular-nums

---

## 6. Page: Leads (/leads)

**File:** `dashboard/src/app/leads/page.tsx`
**User:** SDR (primary), RevOps (secondary)
**Primary question answered:** "Which leads are here and how urgent are they?"

Server component with `searchParams`. Falls back to 2 mock leads if API is unreachable.

### 6.1 Page Header
```
Leads
N leads total      [text-sm text-gray-400]
```

### 6.2 Filter Bar (LeadsFilter — leads-filter.tsx)

'use client' component using `useRouter` and `useSearchParams`.

**Stage pill chips:** All | New | Routing | In Sequence | Meeting Booked | Nurture | Lost

Active pill: `bg-blue-600 text-white shadow-sm`
Inactive pill: `bg-white border border-gray-200 text-gray-600 hover:border-blue-300 hover:text-blue-700`
All pills: `px-3 py-1.5 rounded-full text-xs font-semibold transition-all duration-100`

On click: updates `stage` URL param, resets `page` to 1, uses `router.push()`.

**Visual divider:** `w-px h-5 bg-gray-200` between stage and date range pills.

**Date range pills:** All time | Last 7 days | Last 30 days
Active: `bg-gray-900 text-white shadow-sm` (dark, distinct from blue stage filter)

### 6.3 Leads Table

Custom CSS grid: `grid-cols-[2fr_1.5fr_1fr_1fr_1fr_auto]`
Columns: Lead | Title | Stage | First Touch | Assigned To | (arrow)

**Empty state** (no matching leads): "No leads match this filter / Try a different stage or date range"

**Each row:** full `<Link href="/leads/{id}">`, hover `bg-blue-50/30`, group class for child hover states.

**Column 1 — Lead:**
- `w-8 h-8 rounded-full` avatar (deterministic color + initials)
- Name: `text-sm font-semibold text-gray-900`
- Company: `text-xs text-gray-400`
- Fallback: name = `lead.name || lead.email || 'Unknown'`; company = `lead.company || email.split('@')[1] || '—'`

**Column 2 — Title:** truncated, `text-sm text-gray-600`

**Column 3 — Stage badge** (`px-2.5 py-0.5 rounded-full text-xs font-semibold`):

| Stage | Background | Text |
|---|---|---|
| new | bg-gray-100 | text-gray-600 |
| enriching | bg-blue-50 | text-blue-700 |
| routing | bg-violet-50 | text-violet-700 |
| in_sequence | bg-emerald-50 | text-emerald-700 |
| meeting_booked | bg-teal-50 | text-teal-700 |
| nurture | bg-amber-50 | text-amber-700 |
| lost | bg-red-50 | text-red-600 |

**Column 4 — First Touch (TouchTimeBadge component):**

| Value | Rendering | Signal |
|---|---|---|
| null | `—` in text-gray-300 | Not yet touched |
| <= 5 min | `Zap icon + N min` in emerald-600 | Excellent |
| 6–15 min | `N min` in blue-600 | Acceptable |
| > 15 min | `AlertTriangle icon + N min` in red-500 | SLA violation |

**Column 5 — Assigned To:**
- If assigned: `w-6 h-6 rounded-full` small avatar + name
- If unassigned: `"Unassigned"` in text-xs text-gray-300 italic

**Column 6 — Arrow:** `ChevronRight w-4 h-4 text-gray-300 group-hover:text-blue-400`

### 6.4 Pagination

Left: "Showing X–Y of Z"
Right: "← Previous" and/or "Next →" as styled `<Link>` elements
Style: `px-4 py-2 rounded-xl border border-gray-200 bg-white hover:border-blue-300`

---

## 7. Page: Lead Detail (/leads/[id])

**File:** `dashboard/src/app/leads/[id]/page.tsx`
**User:** SDR (primary)
**Primary question answered:** "Why did this lead get this treatment? What do I do next?"

Server component. Fetches `/api/leads/{id}` and `/api/leads/{id}/timeline` in parallel.

### 7.1 Back Link

`<- Leads` as small `<Link>` — `text-sm text-gray-400 hover:text-gray-700`

### 7.2 Two-Column Layout

```
+--------------------------------------+--------------+
|  Lead Header Card                    |  ICP Score   |
|  (flex-1)                            |  (w-72)      |
|  ─────────────────────────           |              |
|  Decision Timeline                   |  What's Next |
|                                      |              |
|                                      |  Timeline    |
|                                      |  Summary     |
+--------------------------------------+--------------+
```

`flex flex-col lg:flex-row gap-6 items-start`
Right column: `w-full lg:w-72 flex-shrink-0` (288px wide on large screens)

### 7.3 Lead Header Card

Top: `w-14 h-14 rounded-2xl` avatar (larger — 56px) + name (text-xl font-bold) + title + email + stage badge

Stats row (grid-cols-3, separated by border-t border-gray-50):
- Submitted: relative time (e.g., "2h ago")
- First Touch: minutes, colored emerald (<= 15min) or red (>15min) or gray (null)
- Assigned To: rep name or "—"

All labels: `text-[10px] font-semibold uppercase tracking-wider text-gray-400`

### 7.4 Decision Timeline

Vertical line: `absolute left-[15px] w-px bg-gray-200` behind all dots.

**Event dot:** `w-[30px] h-[30px] rounded-full` — color by event type:

| Category | Color | Icon |
|---|---|---|
| webhook_received | bg-blue-500 | Info |
| enrichment_succeeded | bg-blue-500 | CheckCircle2 |
| enrichment_failed | bg-amber-400 | AlertTriangle |
| enrichment_skipped | bg-gray-300 | Info |
| dedup_passed | bg-emerald-500 | CheckCircle2 |
| dedup_rejected | bg-red-500 | XCircle |
| action_proposed | bg-violet-500 | Zap |
| action_execution_started | bg-blue-400 | Info |
| action_execution_succeeded | bg-emerald-500 | CheckCircle2 |
| action_execution_failed | bg-red-500 | XCircle |
| sla_breached | bg-red-600 | AlertTriangle |
| play_completed | bg-emerald-600 | CheckCircle2 |
| play_marked_nurture | bg-amber-500 | Info |
| play_marked_duplicate | bg-gray-400 | XCircle |
| human_review_requested | bg-amber-500 | User |
| human_approved | bg-emerald-500 | CheckCircle2 |

**Event bubble:** `bg-gray-50 rounded-xl p-3.5`
**Last event:** `border border-blue-100 bg-blue-50/50` (current state indicator)

**Inside each bubble:**
1. Event label (human-readable) + timestamp (HH:MM:SS) + relative diff ("3s later")
2. Actor name
3. Reason codes as white border chips — plain English (see Section 10)
4. Policy result: icon + policy name
5. Error code: AlertTriangle + red text
6. External confirmation: ExternalLink icon + "system: ID"

**Reason code translation (REASON_LABELS map):**
```
ENRICHMENT_MISSING_COMPANY_SIZE    -> "Missing: company size"
ENRICHMENT_MISSING_INDUSTRY        -> "Missing: industry"
NOT_ICP_SCORE_TOO_LOW              -> "ICP score too low"
DISQUALIFIED_FREE_EMAIL_PROVIDER   -> "Free email domain"
DISQUALIFIED_TOO_SMALL             -> "Company too small"
TERRITORY_MATCH                    -> "Territory match"
ROUND_ROBIN_SELECTED               -> "Round-robin assignment"
OWNER_LIST_EMPTY                   -> "No owners available"
NO_TERRITORY_MATCH_OR_ALL_AT_CAPACITY -> "No owner available for territory"
```
Unmapped codes: `code.toLowerCase().replace(/_/g, ' ')`

### 7.5 Right Panel: ICP Score Card

Score: `text-5xl font-bold tabular-nums` colored by value:
- >= 70: text-emerald-600
- >= 45: text-blue-600
- < 45 or not ICP: text-gray-400

Tier label: "Tier 1" / "Tier 2" / "Tier 3" / "Not ICP"

If null: "Not scored yet" in italic gray.

### 7.6 Right Panel: What Happens Next Card

Maps `lead.stage` to action label + description:

| Stage | Label | Description |
|---|---|---|
| new | "Waiting for enrichment" | "Lead will be enriched and qualified automatically." |
| enriching | "Enriching..." | "Clearbit is fetching company data." |
| routing | "Routing to rep" | "RoutingAgent is selecting the best available SDR." |
| in_sequence | "Rep to make contact" | "{assignedTo} should reach out within the SLA window." |
| meeting_booked | "Meeting booked ✓" | "Lead converted. AE to run discovery." |
| nurture | "In nurture sequence" | "Lead did not meet ICP criteria. Receiving nurture content." |
| lost | "No further action" | "Lead marked lost." |

### 7.7 Right Panel: Timeline Summary Card

Three rows:
- "Total events" → count
- "Failures" → count (red if > 0)
- "Total duration" → timeDiff(first, last) — only if >= 2 events

---

## 8. Page: System Health (/settings)

**File:** `dashboard/src/app/settings/page.tsx`
**User:** RevOps
**Primary question answered:** "Is everything connected? What are the active policies?"

Page title: "System Health" (not "Settings").
Sub-label: "{healthyCount}/{totalCount} connectors healthy · Policies v1"

### 8.1 Connectors Section

Each connector row: `flex items-center gap-4 px-5 py-4` inside `rounded-2xl`.

- Status dot: `w-2.5 h-2.5 rounded-full` emerald (healthy) or red (unhealthy)
- Connector name + description (from static map)
- Status badge: "Connected" (emerald-50 bg, CheckCircle2 icon) or "Not configured" (red-50 bg, XCircle icon)
- Last checked: HH:MM format

### 8.2 SLA Policy Section

Context copy before the form: "Leads must be contacted within the window below from the moment the form is submitted. Missing this deadline triggers an escalation."

`<SlaForm>` client component handles the PUT to `/api/policies/{id}`.

### 8.3 Territory Routing Rules Section

Empty state: Globe icon + "No territory rules configured" + "All qualified leads will use round-robin assignment"

Each rule row: Globe icon in `rounded-xl bg-violet-50` + rule name + conditions summary + queue badge (font-mono)

---

## 9. Data Contracts (API Response Types)

```typescript
// /api/metrics/overview
interface OverviewMetrics {
  currentPeriod: {
    touchedUnder15MinPct: number;
    avgFirstTouchMin: number | null;
    slaBreaches: number;
    activePlays: number;
    playsCompleted: number;
    totalQualified: number;
  };
  priorPeriod: {
    touchedUnder15MinPct: number;
    playsCompleted: number;
    totalQualified: number;
  };
}

// /api/metrics/speed-to-lead
interface SpeedToLeadDistribution {
  buckets: {
    under5: { count: number; pct: number };
    under15: { count: number; pct: number };
    under30: { count: number; pct: number };
    under60: { count: number; pct: number };
    over60: { count: number; pct: number };
  };
  sdrStats: {
    name: string;
    medianFirstTouchMin: number;
    under15MinPct: number;
    playsCompleted: number;
  }[];
  total: number;
}

// /api/leads (paginated)
interface PaginatedLeads {
  data: Lead[];
  total: number;
  page: number;
  limit: number;
}

interface Lead {
  id: string;
  email?: string;
  company?: string;
  name: string;
  title: string;
  stage: 'new'|'enriching'|'routing'|'in_sequence'|'meeting_booked'|'nurture'|'lost';
  timeToFirstTouchMin: number | null;
  assignedTo: string | null;
  formSubmittedAt: string;
}

// /api/leads/{id} — returns { lead: Lead, currentPlay: {...} } — UI unwraps lead

// /api/leads/{id}/timeline — returns raw event_log rows, mapped to:
interface TimelineEvent {
  id: string;
  timestamp: string;
  event_type: EventType;
  actor: string;
  decision_risk_score?: number;
  reason_codes?: string[];
  policy_name?: string;
  policy_passed?: boolean;
  error_code?: string;
  external_confirmation?: string;
}

// /api/connectors
interface ConnectorHealth {
  name: string;
  status: 'healthy'|'degraded'|'unhealthy';
  lastChecked: string;
}

// /api/policies
interface PolicyRule {
  id: string;
  rule_type: string;
  name: string;
  conditions_summary: string;
  queue_assigned?: string;
  sla_minutes?: number;
}
```

---

## 10. Shared Helper Functions

### relativeTime(iso: string): string
```typescript
const diff = Date.now() - new Date(iso).getTime()
const mins = Math.floor(diff / 60000)
if (mins < 1)  return 'just now'
if (mins < 60) return `${mins}m ago`
const hrs = Math.floor(mins / 60)
if (hrs < 24)  return `${hrs}h ago`
return `${Math.floor(hrs / 24)}d ago`
```

### timeDiff(a: string, b: string): string
```typescript
const diff = Math.abs(new Date(b).getTime() - new Date(a).getTime())
if (diff < 1000)  return '< 1s later'
if (diff < 60000) return `${Math.round(diff/1000)}s later`
return `${Math.round(diff/60000)}m later`
```

### getAvatarColor(name: string): string (deterministic)
```typescript
const colors = ['bg-blue-500','bg-violet-500','bg-emerald-500','bg-amber-500','bg-rose-500','bg-cyan-500','bg-fuchsia-500']
let hash = 0
for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
return colors[Math.abs(hash) % colors.length]
```

### getInitials(name: string): string
```typescript
name.split(' ').slice(0, 2).map(n => n[0]).join('').toUpperCase()
// "Alice Johnson" -> "AJ"  |  "Bob" -> "B"
```

---

## 11. Key UX Design Decisions

**Sidebar vs top-nav:** Spatial permanence. Nav does not move when content scrolls. RevOps and SDRs check repeatedly; stable navigation reduces cognitive load.

**Pill chips vs dropdowns for filters:** One click per filter vs three clicks (open, read, select). Pill chips also show all options simultaneously — scannable without interaction.

**Relative timestamps vs absolute:** "2h ago" answers the SDR's real question: how old is this lead. Absolute timestamps answer a question nobody asked.

**Color-coded first-touch column:** Pre-attentive visual processing. An SDR identifies urgent rows before reading a single number. The Zap icon for fast, AlertTriangle for late — both reinforce meaning even without color.

**Plain-English reason codes:** `NOT_ICP_SCORE_TOO_LOW` is a developer constant. "ICP score too low" is business language. The translation layer preserves meaning while removing system jargon from the user surface.

**Explicit empty states with causes:** "No SDR data yet. Set up a Clearbit key and seed owners to see data here." tells an admin exactly what to do. "No data" forces guessing.

**Last timeline event gets blue tint:** It signals current state, not history. The rest of the timeline is what happened; the last entry is what is true now.

**"System Health" vs "Settings":** RevOps come here to monitor, not configure. The word "health" frames the page as observability. The editable SLA form is secondary — it exists under a monitoring page, not a configuration panel.

---

## 12. File Structure

```
dashboard/
├── src/
│   ├── app/
│   │   ├── layout.tsx              <- Root layout: sidebar + main shell
│   │   ├── globals.css             <- Color tokens, typography, utilities
│   │   ├── page.tsx                <- Root redirect to /dashboard
│   │   ├── dashboard/
│   │   │   ├── page.tsx            <- RevOps overview (server component)
│   │   │   └── sdr-table.tsx       <- Per-SDR table (client — needs sort state)
│   │   ├── leads/
│   │   │   ├── page.tsx            <- Leads list (server component)
│   │   │   ├── leads-filter.tsx    <- Stage + date pill filters (client)
│   │   │   └── [id]/
│   │   │       └── page.tsx        <- Lead detail + timeline (server)
│   │   └── settings/
│   │       ├── page.tsx            <- System health (server)
│   │       └── sla-form.tsx        <- SLA edit form (client — form submission)
│   ├── components/
│   │   ├── sidebar-nav.tsx         <- Left sidebar (client — needs usePathname)
│   │   └── ui/                     <- shadcn primitives (Badge, Table, Card, etc.)
│   ├── lib/
│   │   ├── api.ts                  <- apiFetch wrapper
│   │   └── auth.ts                 <- getServerToken() reads DASHBOARD_TOKEN env var
│   └── types/
│       └── api.ts                  <- All TypeScript interfaces for API responses
```

---

## 13. Extension Guidelines

When adding a new page or component:

1. **Server vs client:** Default to server component. Only use 'use client' when you need useState, useEffect, useRouter, or useSearchParams.

2. **Cards:** Always `bg-white rounded-2xl border border-gray-100 shadow-sm`. Padding `p-5` or `p-6`.

3. **Empty states:** Always include one. Always explain the cause, not just the absence.

4. **Numbers:** Always add `tabular-nums` class to metric displays.

5. **Colors:** Never use color alone to convey meaning — always pair with an icon or text label.

6. **Avatars:** For any entity with a name (lead, rep), use `getAvatarColor` + `getInitials`. No images.

7. **Error states:** Full `rounded-2xl border border-red-100 bg-red-50` card with AlertTriangle icon. Not a toast.

8. **Navigation:** New top-level pages go in `NAV_ITEMS` in `sidebar-nav.tsx`. Active detection is automatic.
