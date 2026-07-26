# StudioOps owner-first IA, responsive design, and component contract

Status: proposed for owner review  
Task: `task_117`  
Delivery: visual-only; no runtime behavior is implemented here  
Fixture policy: synthetic content only

## 1. Authority and source order

Owner-facing builders must apply this order when sources disagree:

1. Lifecycle, candidate-integrity, authority, and privacy invariants in accepted
   architecture and security tasks.
2. This route, responsive, state, and interaction contract.
3. `design-tokens.json`, `component-inventory.csv`, and
   `element-inventory.csv`.
4. The rendered reference layouts.
5. Existing runtime UI.

The supplied audit screenshots are negative evidence, not visual targets. The
prototype intentionally replaces their global-feed-first structure, oversized
masthead, internal prompt/status exposure, and long full-card inbox.

The only owner-shell brand image is
`plugins/studioops/assets/studioops-logo.png`, SHA-256
`3ae6318136d074f0613e6b972757022cb8460473e5eda2669ba581c63de57fa6`.
It is referenced, not copied or redrawn. `studioops-icon.png` is reserved for
high-resolution app/marketplace presentation. `studioops-composer-icon.png` is
reserved for composer UI.

`content-contract.json` is the canonical product-copy source for the prototype.
Its bytes are protected by `content-contract.sha256`; the visual contract test
also verifies that the prototype loads copy from that source rather than
duplicating strings.

## 2. Product principle and decision hierarchy

StudioOps is an owner decision product with an operator console behind it. Every
route answers one question before exposing implementation state:

1. **Consequence** — what decision or outcome matters?
2. **Subject** — which task, candidate, release, exception, or incident?
3. **Freshness** — how old is this information and when is it due?
4. **Evidence** — what proves the claim for the exact immutable subject?
5. **Decision** — what is the single next primary action?
6. **History** — who acknowledged or decided, when, and against which subject?
7. **Diagnostics** — raw prompts, worker payloads, and internal states only
   after an operator-only disclosure.

Visual hierarchy follows the same order. Brand and navigation remain compact;
the requested route owns the first `main` landmark and first `h1`. Counts and
automation state never outrank route content.

## 3. Route map

All routes are local, authenticated by the future local-control-plane boundary,
and `noindex`. Search metadata is not applicable.

| Route | Owner question | First main content | Data source | Build decision | Owner |
| --- | --- | --- | --- | --- | --- |
| `/` | What is healthy, at risk, and next? | Portfolio summary | Aggregate `/api/state` projection | Build in owner UI | `task_83` |
| `/work` | What is moving through the lifecycle? | Work filters, stages, then rows | Task projection from `/api/state` | Build in owner UI | `task_83` |
| `/tasks/:id` | What is this task and what happens next? | Requested task header | Current `GET /api/tasks/:id/detail`, redacted projection required | Build route-first | `task_83` |
| `/qa` | Which immutable candidates await attention? | Candidate queue | Current `/api/qa/review-list`, manifest projection required | Build in QA UI | `task_84` |
| `/qa/candidates/:id` | Is this exact candidate complete and testable? | Requested candidate header and integrity | Candidate manifest and completeness gate | Build route-first | `task_84` |
| `/releases` | What is approved, pending, or released? | Release queue/history | Release candidate records | Build later in QA UI | `task_84` |
| `/releases/:id` | Is this exact release ready and reversible? | Requested release header | RC manifest, reachability, rollback checks | Build later in QA UI | `task_84` |
| `/action-required` | What decisions need me now? | Compact grouped queue | Owner-inbox projection | Build with owner routes | `task_83`, `task_84` |
| `/operations` | Is the delivery system healthy? | Service and queue health | `/api/health`, workers, queues, leases, circuits | Build as operator surface | `task_81` |
| `/policies` | What rules constrain the system? | Lifecycle and quality gates | Execution/project policy | Build as read-first policy surface | `task_79` |

### Route-first invariant

On `/tasks/:id`, `main` begins with the task breadcrumb, task `h1`, summary, and
human-readable state. On `/qa/candidates/:id`, `main` begins with the candidate
identity, immutable integrity result, and QA summary. No Portfolio card, Action
Required feed, project list, automation controls, or unrelated task content may
mount before either route subject.

Client navigation moves focus to the new `h1` (`tabindex="-1"` only for
programmatic focus) after the route is committed. Browser Back restores the
prior list scroll position and row focus. Server-rendered navigation begins at
the skip link and does not force focus.

### Exact task tabs

Task workspace tabs and URL values are fixed:

| Label | URL | Purpose |
| --- | --- | --- |
| Brief | `/tasks/:id?tab=brief` | Story, outcome, criteria, safety, privacy |
| Activity | `/tasks/:id?tab=activity` | Owner-readable transitions, comments, acknowledgements |
| Reviews | `/tasks/:id?tab=reviews` | Specialist and lead evidence bound to subject SHA |
| QA Evidence | `/tasks/:id?tab=qa-evidence` | Criteria-to-candidate evidence map |
| Dependencies | `/tasks/:id?tab=dependencies` | Blocked-by and enables relationships |
| Runs | `/tasks/:id?tab=runs` | Redacted execution summaries |

Prompts are not a tab. They appear only inside a collapsed **Operator
diagnostics** disclosure after operator authorization and redaction. Raw
lifecycle statuses are replaced by owner-readable state labels; the diagnostic
projection may show internal codes.

Tab keyboard behavior is manual activation: Left/Right and Home/End move focus;
Enter/Space activates; only the active tab is in sequential tab order. At narrow
widths the tablist scrolls horizontally and scrolls the active tab into view
without changing the page's vertical position.

## 4. Primary navigation

Order is fixed:

1. Portfolio
2. Work
3. QA & Release
4. Action Required
5. Operations
6. Policies

Mobile bottom navigation shows Portfolio, Work, QA, and Action; **More** opens a
modal drawer containing all six destinations. The label remains “QA & Release”
inside the drawer and desktop rail; “QA” is the constrained bottom-nav label.
Action counts cap visually at `99+`, retain the full accessible label, and are
announced only when a newly fetched count changes.

## 5. Action Required contract

The queue is grouped by consequence, not mixed into one feed:

1. **QA decisions** — opens `/qa/candidates/:id`; visible primary is **Review
   candidate**.
2. **Release approvals** — opens `/releases/:id`; visible primary is **Approve
   release** only after authority, reachability, completeness, and stale checks
   pass. It is disabled in the design reference.
3. **Engineering exceptions** — opens `/tasks/:id`; visible primary is **Open
   task** until an actor-scoped exception API exists.
4. **Incidents** — opens `/operations/incidents/:id`; visible primary is
   **Inspect incident** until durable acknowledgement exists.

Every row contains type, title, age, SLA or overdue duration, acknowledgement
history, human-readable state, exactly one visible primary action, and a
secondary **More actions** menu. Long descriptions, recovery checklists, raw
error enums, branch labels, local paths, prompts, and multiple same-weight
buttons are prohibited.

Ordering is: blocking incident, overdue release/QA, other overdue items, then
soonest SLA. Within a tie, oldest created record first. An acknowledged item
stays visible until resolved; acknowledgement changes presentation, never the
underlying lifecycle.

## 6. Responsive reference layouts

The three committed images are viewport references, not device mockups. Browser
chrome and safe-area insets are excluded from the dimensions.

### 390 × 844 — phone, Action Required

Reference: `test/visual/owner-first/390x844-action-required.png`

- Compact 64 px header: 40 px logo, product name, local-state indicator, More.
- First main content starts at 80 px with route eyebrow and `h1`; no promotional
  masthead.
- Decision groups and rows use one column. Row metadata wraps before its action.
- Exactly one primary action is full-width at the bottom of each row.
- Sticky bottom navigation occupies 64 px plus `env(safe-area-inset-bottom)`.
- Content has at least 16 px side gutters and never hides behind bottom nav.
- Target order: skip link → brand/home → More → route summary → rows in priority
  order → primary action and More per row → bottom navigation.

### 834 × 1112 — tablet, direct task

Reference: `test/visual/owner-first/834x1112-task.png`

- Compact 72 px header and 72 px icon rail leave 762 px for the workspace.
- The requested task is the first `main` content. A global inbox is absent.
- Task header is compact; metadata wraps below the title when necessary.
- Exact tabs remain one scrollable row. Brief uses two balanced columns.
- The operator diagnostics disclosure is last and collapsed.
- At widths below 768 CSS px, the rail becomes bottom nav/drawer and the task
  becomes a full-screen detail route.

### 1440 × 1000 — desktop, direct QA candidate

Reference: `test/visual/owner-first/1440x1000-qa-candidate.png`

- 72 px compact header; 240 px project rail; fluid workspace; optional 320 px
  evidence inspector.
- The requested candidate and integrity result start `main`; unrelated inbox
  items never precede them.
- Test steps occupy the main reading column; evidence, limitations, and decision
  scope use the inspector.
- The decision region remains visible but disabled in this artifact and states
  its missing runtime contract.
- Content max is 1440 px. Above 1440, outer canvas grows while columns and line
  lengths remain bounded.

### 200% zoom

Treat 200% zoom at 1440 CSS-pixel viewport as an effective 720 px layout:

- Desktop rail and inspector collapse.
- Header becomes mobile/tablet shell; bottom navigation and drawer are used.
- Tables switch to labeled row layouts without dropping columns or actions.
- Task tabs scroll; no two-dimensional page scrolling.
- Sticky decision controls must not cover focused content.
- Text remains fully visible with 1.5 line height and no fixed-height cards.

### 400% zoom

Treat 400% zoom at 1280 CSS-pixel viewport as an effective 320 px layout:

- One content column; 12 px gutters are permitted below 360 px.
- Product name may hide while the canonical logo remains.
- Primary actions fill the content width; More remains a separate 44 px target.
- Metadata, digests, and commit IDs wrap with `overflow-wrap:anywhere`.
- Bottom navigation becomes a compact two-row drawer trigger if four items
  cannot retain 44 px targets.
- No horizontal page scroll at 320 CSS px. Evidence media scales to 100%.

Reflow is verified by the visual contract source rules. Runtime builders must
add browser evidence at 200% and 400% because browser zoom itself is outside
this visual-only task.

## 7. State contract

Every dynamic route and data component supports these states:

| State | Presentation | Interaction | Announcement and focus |
| --- | --- | --- | --- |
| Loading | Geometry-matched skeleton; one loading label | Existing stale content may remain inert if mutation safety is unknown | One polite status; do not announce each skeleton |
| Empty | Explain why empty and the next safe route, if any | At most one contextual action | Focus remains on route heading |
| Error | Human summary and safe reference ID; never raw exception | Retry only when idempotent; Back always safe | Blocking route error gets `role=alert`; focus error heading |
| Offline | Persistent banner; last-local-snapshot timestamp | Navigation within cached snapshot allowed; all mutations disabled | Polite on transition only |
| Stale | Timestamp and “may be out of date” text | Immutable-subject decisions disabled until refresh validates identity | Status on transition; focus stays |
| Permission | Explain required role without leaking data | Hide sensitive content; disabled action includes reason | Focus permission heading for protected route |
| Degraded | Identify delayed subsystem and unaffected scope | Decisions unavailable when evidence/freshness is affected | Polite status; no repeated worker updates |

Component-specific default, hover, focus-visible, active, selected, disabled,
submitting, success, and failure states are enumerated in
`component-inventory.csv`.

Skeletons reserve final geometry to keep CLS below 0.1. The shell loads before
route data, route requests are scoped rather than fetching the full board, and
lists are paginated (50 rows maximum initial slice). Non-critical evidence
images are lazy loaded with intrinsic dimensions. Candidate identity and first
route heading are never deferred.

## 8. Token contract

`design-tokens.json` is normative and records every exact value:

- **Type:** Inter/system fallback; sizes 12, 14, 16, 18, 24, and 32 px at a
  16 px root; weights 400, 560, 680, 760; line heights 1.2, 1.5, 1.65.
- **Color:** canvas `#F5F6FA`, surface `#FFFFFF`, text `#211D36`, muted
  `#665F78`, brand `#6427E7`, focus `#00A3C4`, and semantic pairs listed in
  the token file.
- **Spacing:** 0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64 px.
- **Radius:** 0, 6, 10, 16 px, and pill.
- **Elevation:** none, raised, overlay, and focus values in the token file.
- **Z-index:** base 0, sticky 100, drawer 300, dialog 500, toast 700.
- **Motion:** 0, 120, 180, 280 ms; exact standard/enter/exit curves in the token
  file; all non-essential motion becomes 0 ms under reduced motion.

No owner builder may introduce a new visual value without updating the token
source and documenting its semantic use. Theme contrast is validated against
the token pairs, not by visual sampling.

## 9. Component contract

`component-inventory.csv` is normative. It covers:

- navigation: AppShell, BrandMark, PrimaryNav, PageHeader, TaskTabs;
- boards/lists/tables: Board, WorkRow, DecisionGroup, DecisionRow, DataTable,
  RunTable, ActivityTimeline, DependencyList;
- forms/actions: FilterBar, FormField, Button, Menu, Dialog;
- evidence/QA: IntegrityBanner, QAPacket, CriteriaEvidenceRow, EvidenceViewer,
  ReviewSummary;
- status/feedback: StatusBadge, FeedbackBanner, Skeleton, EmptyState,
  ErrorState, Toast;
- diagnostics: DiagnosticsDisclosure.

Repeated markup and styling must be shared. Owner-facing status formatting,
focus rings, button hierarchy, decision rows, integrity labels, and state
banners may not be page-local copies.

## 10. Control and action contract

This packet distinguishes navigation, existing unsafe/insufficient endpoints,
and unavailable future actions:

| Visible control | Contract in this artifact | Runtime note |
| --- | --- | --- |
| Route links and tabs | Real `GET` route shown in this document | Runtime builder implements routing |
| Existing task detail | Current `GET /api/tasks/:id/detail` | Must add owner-safe projection; prompts cannot ship in primary payload |
| Existing candidate queue | Current `GET /api/qa/review-list` | Must return immutable candidate summaries |
| Candidate decision | **Unavailable** | Current `POST /api/qa/bundles/:id/decision` is not sufficient until actor authorization and exact manifest binding land |
| Task raw status update | **Not represented** | Current `PATCH /api/tasks/:id` raw status mutation is prohibited in owner UI |
| Release approval | **Unavailable** | Requires owner-scoped transition, reachability, immutable subject, risk and rollback record |
| Exception decision | **Unavailable** | Requires actor-scoped exception transition and reason code |
| Incident acknowledgement | **Unavailable** | Requires durable outbox receipt and acknowledgement API |
| Operator diagnostics | **Unavailable** in prototype | Requires operator authorization and redacted projection |

Disabled controls are genuinely disabled and accompanied by a visible reason.
They do not use fake success, fixture mutations, or inert buttons that appear
functional.

## 11. WCAG 2.2 AA annotations

- **Landmarks:** one banner, one Primary nav, one main, optional named
  complementary inspector, and contentinfo only when useful. Skip link is the
  first focusable element.
- **Keyboard order:** follows visible reading and decision order. CSS visual
  reordering cannot change meaning. Every action is reachable without pointer
  or drag.
- **Focus:** 3 px cyan focus treatment with sufficient adjacent contrast.
  Client route changes focus the new `h1`; dialogs and menus restore focus to
  their trigger; destructive confirmations initially focus Cancel or the title.
- **Contrast:** body and muted text meet 4.5:1 on their defined surfaces; large
  text and graphical controls meet 3:1. Semantic soft colors always pair with
  dark semantic text.
- **Target size:** every target is at least 44 × 44 CSS px. Inline text links may
  use the WCAG spacing exception, but primary workflow controls do not.
- **Reduced motion:** honor `prefers-reduced-motion: reduce`; remove transforms,
  smooth scroll, shimmer, and non-essential transition duration.
- **Announcements:** route loading, refreshed counts, newly arrived urgent
  items, and completed actions use one scoped live region. Errors use assertive
  announcement only when they block completion. Worker heartbeats are never
  announced continuously.
- **No color-only meaning:** every state has text and, where useful, an icon or
  shape. Overdue text includes the duration. Selected navigation includes
  `aria-current`.
- **Forms:** visible persistent labels, associated help/errors, error summary,
  and no placeholder-only instructions.
- **Media:** evidence has useful alt/caption; decorative icons have empty alt or
  are hidden. Recordings provide captions or transcript and never autoplay.

## 12. QA packet field mapping

Every owner QA handoff field from the audit maps to both queue and candidate
designs:

| Required field | QA queue | Candidate detail |
| --- | --- | --- |
| Candidate ID and manifest digest | ID plus verified marker | Integrity banner with full copy action |
| Exact base/source/integration SHAs | Hidden from dense row; integrity state summarizes | Integrity banner, complete and wrap-safe |
| Task, branch, PR, review, CI links | Completeness count and exception marker | Links section grouped by subject |
| Preview URL, health, verified commit | Preview verified marker | Preview card with exact commit and health time |
| Affected screens/routes/APIs/data/devices | Short affected-surface summary | Dedicated affected-surface table |
| Criteria, ordered steps, expected outcomes | Passed/total completeness count | CriteriaEvidenceRow per criterion |
| Accounts, fixtures, permissions, reset | Missing-field warning only | Setup section before test steps |
| Screenshots, recordings, logs, hashes | Evidence count | EvidenceViewer with hash and subject |
| Limitations, risks, migrations, flags, rollback | Risk count and severity text | Dedicated decision-scope sections |
| Pass, Fail, Request Changes, Defer, Open Candidate | One context action: Review candidate | Decision area; disabled until authorization and stale checks pass |
| Acknowledgement and delivery receipts | Acknowledgement history in row | Activity section with durable receipt timeline |

The queue never attempts to fit the packet into a card. It shows just enough to
prioritize and opens the candidate route for the complete decision.

## 13. Audit screenshot correction map

| Negative evidence | Observed defect | Proposed correction | Evidence |
| --- | --- | --- | --- |
| `desktop-owner-inbox.png` | 25 full cards create an approximately 31,933 px feed; global automation buttons compete with decisions | Compact typed groups, bounded rows, one primary action, Operations owns automation | 390 Action Required and component inventory |
| `mobile-owner-inbox.png` | Approximately 275 px masthead and wrapping utility buttons consume first viewport | 64 px compact header, route title immediately below, bottom nav/drawer | 390 Action Required |
| `mobile-direct-task-route.png` | Direct task route mounts global feed before requested task | Task is first main landmark; global feed absent; Back restores list position | 834 direct task and route-first test |
| Current task details described in audit | 15 raw status buttons and full prompts expose internal workflow | Human state summary; exact six tabs; prompts only in operator diagnostics | 834 task and element inventory |

## 14. Privacy and security

The owner shell is local-first but still least-privilege:

- Never render secrets, tokens, prompt source, repository source, full local
  paths, private remote URLs, customer content, or raw stack traces.
- Project/task names are owner data and remain in the application, not
  privacy-minimal notifications.
- Lock-screen notifications contain generic type, count, and age only.
- Short SHAs and manifest digests appear only where candidate identity matters.
- Evidence viewers receive redacted, hash-verified artifacts and never infer
  safety from filename.
- Permission failures disclose the required capability, not hidden content.
- Owner decisions require reauthentication/owner authority in the functional
  task; visual proximity to an action is not authorization.

## 15. Functional follow-up

This design packet does not complete the runtime. The scoped follow-up is:

- `task_83`: implement owner Portfolio, Work, direct Task, responsive shell, and
  compact Action Required projections from this contract.
- `task_84`: implement immutable QA candidate, release, and decision surfaces
  from this contract.
- `task_80`: provide complete QA-packet, owner-authority, acknowledgement, and
  durable notification contracts before decisions become enabled.
- `task_81`: provide bounded Operations health and diagnostics projections.
- `task_79`: provide enforced policy/read models and actor-scoped transitions.
- `task_77`: authorize and redact operator diagnostics.

No runtime builder may activate an owner mutation by wiring it to the current
generic status or caller-supplied decision endpoints.

