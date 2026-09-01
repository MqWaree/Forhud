# FGP / Forhuds Panel — DeepSeek V4 Pro Handoff for OpenCode

Last rebuilt: 2026-09-02 (Europe/Paris)

Audience: DeepSeek V4 Pro running inside OpenCode with this repository opened as the workspace.

Purpose: give a new coding agent enough verified context to continue FGP safely without relying on the historical chat, guessing production state, exposing credentials, or undoing recovered work.

This is a continuation document, not an instruction to deploy. The repository and live evidence are the source of truth. If this file disagrees with code, tests, Git, or production health, investigate and report the discrepancy before changing anything.

## 1. Required reading order

Before substantial work:

1. Read `AGENTS.md` completely. Its rules are mandatory.
2. Read this file completely.
3. Read `DEEPSEEK-ATTEMPT-LEDGER.md` completely before optimizing or fixing a recurring bug. It records failed, partial, superseded, and no-result approaches.
4. Read `OPENCODE-HANDOFF.md` for the longer chronological and product history.
5. Read `README.md` for the supported developer workflow.
6. Inspect `git status --short --branch`, `git log --oneline --decorate -15`, and the diff of every modified tracked file.
7. Inspect the task-relevant code and tests before proposing a fix.

Do not treat old chat snippets, screenshots, root helper scripts, or generated output as more authoritative than the committed application source.

## 2. One-page operational snapshot

### Project identity

- Product: FGP / Forhuds Panel
- Public site: `https://forhud.shop`
- Git repository: `https://github.com/MqWaree/Forhud`
- Primary branch: `main`
- Local workspace: `C:\Users\Mohammad\Documents\Codex\2026-08-02\referenced-chatgpt-conversation-this-is-an`
- VPS: Ubuntu at `162.35.162.136`
- Application directory: `/opt/fgp`
- Production environment: `/etc/fgp/fgp.env`
- Production database: `/var/lib/fgp/lead-intelligence.db`
- Production backups: `/var/backups/fgp`

### Git state observed while rebuilding this handoff

- Local branch: `main`
- Local HEAD: `9153420643ff70a1ffe1f802cd6d1994b17a21e8`
- Short HEAD: `9153420`
- `origin/main` pointed to the same commit.
- Latest relevant commits:
  - `9153420` — recorded verified production deployment evidence.
  - `5d1b16b` — safe deployment workflow update.
  - `e8f331a` — repaired deployment launcher/runtime lookup.
  - `55e9c26` — clarified OpenCode release state.
  - `30e9241` — added the original OpenCode handoff.
  - `7ecf02d` — merged the recovered application release with remote history.
  - `1f9d695` — large scanner reliability/application release.
  - `ef9b089` — fixed production login SQLite timeout behavior.

Always resolve Git state again. These hashes describe the handoff creation moment, not an eternal state.

### Verified production state

- The last independently verified application feature baseline is `7ecf02d`.
- Later commits through `9153420` primarily changed deployment launchers and documentation.
- The last recorded successful deployment log is `outputs/deploy-release-20260901-235350.log`.
- The recorded completion marker is `FGP_DEPLOYMENT_OK`.
- The successful rollout created a timestamped database backup and rollback directory.
- Loopback and public health reported:
  - database connected;
  - browser extension available;
  - Scrapling healthy, version 0.4.11.
- Public HTML referenced `index-BkNjb471.js` and `index-CUVbUSv1.css`, matching the deployed build evidence.

Do not say production is still healthy merely because this section says it was healthy on 2026-09-01. Recheck health when a current claim matters.

### Current dirty working tree at handoff creation

The workspace was not clean. Preserve these changes.

Tracked modifications:

- `DEPLOY-CORRECTED-RELEASE.cmd`
- `DEPLOY-FGP.cmd`
- `deploy-release.ps1`
- `run-deploy-interactive.ps1`

Their current purpose is to route deployments through a new mutex-protected wrapper rather than allowing two deployment windows to rebuild the same shared archive concurrently.

Important untracked implementation:

- `invoke-fgp-deployment.ps1`

That file:

- acquires the named Windows mutex `Local\FGP.Forhud.Deployment`;
- exits clearly if another deployment is running;
- runs the audited release builder using normal Node/pnpm or the recovered tool wrapper;
- calls `deploy-release.ps1` only after a successful release build;
- releases the mutex in a `finally` block.

`deploy-release.ps1` has a local edit that adds `invoke-fgp-deployment.ps1` to its deployment publication allowlist. These mutex changes were **not committed, pushed, deployed, or production-verified** when this handoff was rebuilt.

There are also many untracked historical patch scripts, diagnostics, staging directories, and local test helpers. Examples include `apply-*.cjs`, `fix-*.js`, `diagnose-*.ps1`, `haze-card-staging/`, and `haze-layout-staging/`. They are not automatically part of the product. Review each file individually. Never use `git add -A` to sweep them into a release.

### Handoff-package verification

After writing the DeepSeek handoff package on 2026-09-02:

- `git diff --check` reported no patch-format errors; only the repository's existing Windows LF-to-CRLF notices appeared.
- The offline security scan passed with no packaged secrets or missing hardening controls.
- The audited release builder completed successfully with 238 entries.
- The resulting release archive contained `DEEPSEEK-ATTEMPT-LEDGER.md`, `DEEPSEEK-V4-PRO-HANDOFF.md`, and `DEEPSEEK-V4-PRO-START-PROMPT.md`.
- A fixed-prefix check found none of the historically exposed token prefixes in the handoff documents.

The full application test suite was not rerun solely for this documentation/allowlist handoff update. Run the complete required suite before committing a substantial code change or deploying.

The separate `DEEPSEEK-ATTEMPT-LEDGER.md` is part of the takeover package. It explains the approaches already tried with failed, partial, misleading, or no-result outcomes. Consult it before another scanner-speed, Brave-yield, authentication, LZT, Haze, UI, or deployment fix.

## 3. Product summary

FGP is a production multi-user research and market-tracking platform. Its main capabilities are:

1. Authenticated workspaces, users, roles, ranks, and member groups.
2. Brave Search business-domain discovery.
3. Persistent website/contact scanning.
4. Discord, Telegram, and email extraction.
5. Automatic lead creation/enrichment and a Leads Kanban board.
6. A general product-price scanner.
7. A rank-gated LZT Market Rust account tracker.
8. Durable Haze-account notifications.
9. A paired Chrome extension for manually opened Google result pages.
10. Safe production deployment with Git publication, database backup, health checks, and rollback.

The product must behave as a persistent operator tool, not a demo. Progress, queues, retries, user edits, alert delivery state, and diagnostics must survive refreshes and service restarts where designed.

## 4. Architecture and ownership boundaries

### Dashboard — `apps/dashboard`

- React + Vite + TypeScript.
- Authentication and setup UI.
- Searcher, Splitter, Leads, My Leads, History, Settings, Administration, member sidebar, product prices, and LZT views.
- Server state is obtained through authenticated API calls and SSE.
- UI direction: dark, compact, sleek, blended controls, restrained purple accents, subtle metrics.

Key files:

- `apps/dashboard/src/App.tsx` — application shell, navigation, routes, legacy in-file pages.
- `apps/dashboard/src/SearcherPage.tsx` — Brave search, scanner progress, retry and Discord reconciliation UI.
- `apps/dashboard/src/LeadsPage.tsx` — table/Kanban workflows, exports, hover information, drag/drop.
- `apps/dashboard/src/RustPricesPage.tsx` — general market and LZT subviews.
- `apps/dashboard/src/AdminPage.tsx` — user, rank, extension, audit, and backup administration.
- `apps/dashboard/src/api.ts` — dashboard API client.
- `apps/dashboard/src/styles.css`, `identity.css`, `enhancements.css` — visual system.

### Node API — `apps/server`

- Express + TypeScript.
- Authentication, authorization, workspace isolation, API validation, SSE, business search, scanner orchestration, lead synchronization, product/LZT tracking, backups, and notifications.
- Node is the authoritative scanner coordinator.
- It owns queue state, persistence, retries, concurrency, stop/resume, URL policy, SSRF checks, and final classification.

Key files:

- `apps/server/src/app.ts` — route registration and cross-feature API behavior.
- `apps/server/src/auth.ts` — sessions, scrypt password hashes, password validation integration.
- `apps/server/src/setup-security.ts` — initial administrator protection.
- `apps/server/src/rate-limit.ts` — persistent account/IP rate limiting.
- `apps/server/src/brave-search.ts` — Brave pagination, caching, target collection.
- `apps/server/src/business-filter.ts` — exclusions and canonical business filtering.
- `apps/server/src/scanner.ts` — persistent scanning engine and retry state.
- `apps/server/src/crawler.ts` — bounded page traversal and URL security policy.
- `apps/server/src/discord-discovery.ts` — contact extraction and recovery.
- `apps/server/src/discord-invite-reconciliation.ts` — persisted invite/server-identity checker.
- `apps/server/src/scraper-client.ts` — private worker client and error classification.
- `apps/server/src/adaptive-concurrency.ts` — pressure response and gradual recovery.
- `apps/server/src/lead-sync.ts` — valid contact to Lead synchronization.
- `apps/server/src/rust-price-scanner.ts` — general product scanner.
- `apps/server/src/lzt-client.ts` — official/public LZT input handling.
- `apps/server/src/lzt-tracker.ts` — lifecycle, persistence, polling, alerts, inventory.
- `apps/server/src/lzt-discord-card.ts` — Haze notification content/layout.
- `apps/server/src/haze-notifier.ts` — durable outbound Haze worker.
- `apps/server/src/currency-rates.ts` — display conversion.
- `apps/server/src/backups.ts` — validated SQLite backup/restore.
- `apps/server/src/security.ts` — security helpers.

### Python worker — `apps/scraper`

- Python + Scrapling 0.4.11.
- Private loopback-only fetching/rendering worker.
- Static-first fetches with selective browser rendering.
- Structured extraction and structured failure information.
- It is not the queue owner and must not become a public API.

Key files:

- `apps/scraper/src/service.py`
- `apps/scraper/tests/test_service.py`
- `apps/scraper/tests/fixtures/`

### Chrome extension — `apps/extension`

- Manifest V3 extension.
- Pairs with a high-entropy Scanner ID.
- Reads organic URLs only from Google pages manually opened by the operator.
- It must not automate Google queries or circumvent Google access controls.

### Shared package — `packages/shared`

- Cross-workspace schemas and utilities.
- URL/domain normalization.
- Discord normalization.
- CSV and splitter behavior.

### Database — `apps/server/prisma`

- Prisma + SQLite.
- Ordered, data-preserving migrations.
- Do not rewrite a migration that has already reached production.
- Add a new migration or a carefully tested compatibility helper.

## 5. Production topology

### Services

- `fgp-api.service` — Node API and application workers.
- `fgp-scraper.service` — private Python Scrapling worker.
- `fgp-haze-notifier.service` — Haze notification delivery worker.
- Caddy — HTTPS, static dashboard hosting, SPA fallback, API proxy, and security headers.

### Network boundary

- Caddy is the only intended public front door.
- Node API normally listens on `127.0.0.1:3001`.
- Scrapling normally listens on a private loopback port, commonly 3011.
- The worker requires a shared strong token and production rejects development placeholders.
- Never expose the Scrapling service publicly.

### Filesystem boundary

- Release: `/opt/fgp`
- Environment: `/etc/fgp/fgp.env`
- Database: `/var/lib/fgp/lead-intelligence.db`
- Backups: `/var/backups/fgp`
- Rollback releases: timestamped `/opt/fgp-rollback-*` directories.

### Caddy expectations

- Serve built dashboard assets.
- Proxy `/api/*` to Node.
- Preserve SPA fallback.
- Use automatic HTTPS.
- Keep HSTS, CSP, frame denial, MIME protection, referrer policy, permissions policy, and server-header reduction.

## 6. Security invariants

These are product requirements, not optional hardening ideas.

### Credentials and sensitive data

- Never expose passwords, API keys, cookies, session IDs, Discord credentials, SSH credentials, environment contents, production database files, or backup contents.
- Historical chat included Brave, LZT, and Discord values. Treat every value ever pasted there as compromised.
- Never copy those values into source, handoff files, commands that echo them, screenshots, or logs.
- Store production secrets only in `/etc/fgp/fgp.env`.
- Store local secrets only in ignored environment files.
- If a production dashboard password is forgotten, reset it through an authorized flow. Password hashes are salted scrypt hashes and cannot be retrieved.

### Authentication

- Login is mandatory in production.
- Do not reintroduce the historical full-access authentication bypass.
- Initial production setup requires `INITIAL_SETUP_TOKEN` when no administrator exists.
- Sessions are opaque, HttpOnly, Secure on HTTPS, SameSite, rolling cookies.
- Usernames are normalized and validated server-side.
- Role, rank, permission, and workspace checks stay server-side.

### Password policy

- There is intentionally no fixed minimum password length.
- This does not mean weak passwords are accepted.
- The shared policy must reject common passwords and predictable transforms such as leetspeak, case changes, years, and suffixes.
- It must apply to setup, administrator creation/reset, and self-service changes.
- Preserve positive coverage for genuinely random shorter credentials and strong passphrases.

### Rate limiting and SQLite

- Account/IP throttles persist in SQLite.
- SQLite is a single-writer database.
- Keep invalid-login counter updates short, atomic, and sequential.
- Do not reintroduce competing parallel interactive transactions; that previously caused Prisma P1008 login timeouts.

### SSRF and crawler policy

- Validate DNS before every fetch boundary.
- Reject private, loopback, link-local, metadata, and unsafe resolved addresses.
- Revalidate redirects and discovered crawl candidates.
- Preserve address pinning as defense in depth.
- Respect robots rules and same-domain crawl boundaries.
- Do not add proxy rotation, CAPTCHA solving, stealth/fingerprint evasion, authentication bypass, or rate-limit circumvention.
- Honest block/challenge classification is required.

### Workspace isolation

- Every workspace-owned record remains scoped by `workspaceId`.
- API queries and mutations must enforce that scope.
- Cross-workspace tests are required for changes touching ownership.

## 7. Authentication and operator access notes

- The production dashboard is `https://forhud.shop`.
- Do not put account identifiers or passwords in committed documentation.
- Do not confuse the FGP dashboard credential prompt with the VPS root password prompt.
- Dashboard credentials are sent only to the FGP login endpoint over HTTPS.
- VPS root credentials are entered only into the SSH deployment prompt.
- A current password cannot be displayed or recovered from the database.
- Preferred reset: an authorized administrator uses the product reset flow.
- Emergency server-side reset must be deliberately designed, audited, and performed without printing the temporary secret.

## 8. Searcher requirements

The Searcher uses Brave Search to collect unique business domains, not raw search-result rows.

### Target behavior

- Continue safe pagination and closely related business-intent query variations until:
  - the requested unique-domain target is reached;
  - the configured safe request budget is exhausted; or
  - Brave produces no new qualifying business domains.
- A request for 500 means 500 unique qualifying business domains, not 500 raw provider results.
- Report provider exhaustion honestly.

### Efficiency

- Use positive result caching.
- Reuse cached pages/query variants.
- Deduplicate canonical domains before spending scanner capacity.
- Current expected defaults include:
  - `BRAVE_MAX_REQUESTS=300`;
  - `BRAVE_SEARCH_CONCURRENCY=3`;
  - positive cache TTL;
  - cache capacity sufficient for many pages;
  - a maximum target that permits 500-result requests.

### Filtering

- Exclude generic social networks, marketplaces, directories, review sites, search engines, gaming stores, and link hubs unless explicitly allowlisted.
- Normalize scheme, `www`, host casing, path/query noise, and known equivalent variants.

### Persistence and UI

- Search progress is server-persisted.
- Refreshing the dashboard must not erase active state.
- Small metrics should include percent, discovered, queued, active, completed, valid contacts, failed, timeout, blocked, retries, throughput, current concurrency, and median/p95 latency.

## 9. Contact scanner requirements

### Source of truth

Node owns the queue, persistence, retry policy, stop/resume, concurrency, URL security, and final status. Python returns structured work results.

### Contact validity

- Discord is valid.
- Telegram is valid.
- Email is a fallback when Discord and Telegram are absent.
- Preserve both Discord and Telegram when both are found.
- Do not call a scan a contact success merely because a fallback page loaded.
- `DISCORD_NOT_FOUND` is a valid completed extraction outcome, not a network failure.

### Extraction surfaces

- Anchor destinations, including icon-only anchors.
- Accessibility labels.
- Visible text and raw HTML.
- URL-bearing attributes.
- Embedded JSON and hydration data.
- First-party script bundles.
- Rendered DOM and approved shadow roots.
- Discord widgets and branded routes.
- Same-domain contact/community/support/FAQ/review routes.
- Bounded root/`www` recovery.
- Explicitly linked supported social/profile pages through bounded recovery.

### Failure classification

Keep these distinct:

- no supported contact found;
- DNS failure;
- TLS failure;
- connection failure;
- timeout;
- HTTP 408/425/429;
- HTTP 5xx;
- HTTP 403/block/challenge;
- worker busy/offline/error;
- policy/robots failure;
- invalid response.

Classify the remote cause before a generic local worker error. Preserve original status, fallback status, attempted pages, elapsed time, extraction methods, worker codes, `Retry-After`, and the final classification.

### Retry policy

- Retry transient classes only.
- Use bounded exponential backoff.
- Honor `Retry-After`.
- Reduce adaptive concurrency immediately under worker/provider pressure.
- Restore concurrency gradually after healthy work.
- Stop must interrupt waiting retries promptly.
- Permanent blocks and policy failures must not loop forever.
- After the fifth failed contact-extraction attempt, a site may leave the active list, but its complete failure history remains downloadable.

### Regression that must stay fixed

A healthy homepage must not become a domain-level Timeout or Blocked result only because guessed `/discord`, `/community`, or `/contact` paths failed.

## 10. Discord invite reconciliation

The Discord Links reload/check action is a persisted background job.

It must:

- have its own accurate progress bar and subtle metrics;
- survive refresh/restart where designed;
- normalize invites before checking;
- group duplicate destinations;
- resolve Discord server identity when available;
- merge different invites pointing to the same server;
- respect HTTP 429 and `Retry-After`;
- classify 403, 429, 5xx, timeout, worker timeout, invalid invite, and success separately;
- continue after individual failures;
- expose counts/progress through API and SSE;
- never bypass Discord controls.

The Leads simple Discord export should contain normalized invite links only, without CSV metadata.

## 11. Leads and Kanban

### Synchronization

- Valid scanner contacts synchronize to Leads immediately.
- Canonical workspace/domain uniqueness prevents duplicates.
- New scanner evidence may enrich a Lead.
- Never overwrite operator-entered values with blanks or lower-quality data.

### Supported workflows

- Table and Kanban views.
- Status, priority, assignment, tags, activity history.
- My Leads filtering.
- Bulk actions and exports.
- Destructive clear-all action with explicit confirmation.
- Smooth optimistic drag/drop with rollback on server failure.
- Hover information panel.
- Clickable source, Discord, Telegram, and other contact links.

## 12. General product-price scanner

The general tracker and LZT tracker are related UI areas but separate data/workflow scopes.

### Product scope

- Rust NFA.
- Game accounts.
- Arbitrary other items with a custom search term.

Each product scope isolates sources, listings, diagnostics, deletion, exports, statistics, and scan state.

### Required behavior

- Sort by clicking Price and through the visible sort control.
- Filter by text, listing type/category, minimum price, maximum price.
- Display DKK, EUR, USD, and RUB.
- Preserve original source value/currency while converting only for display.
- Show aggregate market statistics.
- Show category statistics only for categories with at least three comparable listings.
- Provide delete-all-results with destructive confirmation.
- Retry failed scans and rescan all.
- Export debug information for both passed and failed scans.
- Canonicalize duplicate source sites.

## 13. LZT Market Rust tracker

### Separation and access

- LZT is a dedicated subview under product prices.
- Do not mix general tracker controls into the LZT view.
- Access requires the built-in `LZT Access` rank/permission.

### Input modes

- Token mode uses the official Market API.
- `LZT_API_TOKEN` is optional.
- Public mode polls no faster than once per minute.
- Public mode never bypasses login, CAPTCHA, or human verification.
- Record access challenges honestly.

### Listing data

- Listing ID and URL.
- Title/type and source timestamps.
- Price and source currency.
- Games count.
- Rust hours.
- Kills/deaths where present.
- Inventory item count.
- Rust inventory value.
- CS2 inventory value.
- Total inventory value.
- DLC packs.
- Listed, updated, and sold timestamps.
- Sold/lifecycle state.

### Currency correctness

- Apply the selected currency to the listing price and every inventory subtotal/total.
- Never label a RUB source value as USD, EUR, or DKK without converting it.
- Use one rate snapshot consistently across a rendered listing.
- Preserve source currency and minor units for auditability.

### Lifecycle

- Reconcile sold status after a listing is stored.
- Remove a listing from the active panel after it has remained sold for one minute.
- Preserve lifecycle history and notification audit state.

### Notifications

Current requested rules:

- standard alert at or below USD 5.00;
- high-hours alert with at least 2,000 Rust hours at or below USD 6.00.

Baseline imports must not spam alerts.

## 14. Haze notification delivery

Final architecture decision:

- Do not add a separate Discord bot.
- FGP detects qualifying LZT listings and writes a durable alert queue.
- `fgp-haze-notifier.service` sends through the configured Haze account.
- A manual message action queues a message without making an LZT API call.
- Failed deliveries use bounded retry/backoff.

Test-alert controls accept:

- custom maximum price;
- minimum games;
- minimum Rust hours.

A service showing `active` or `connected` proves only process/token connectivity. Verify the durable alert record and actual delivery outcome before claiming a message was posted.

Never log or document the Haze/Discord credential.

## 15. Ranks and member sidebar

- Discord-style grouped member sidebar.
- Rank name, colour, order/position, and permission list.
- User-to-rank assignments.
- Built-in managed ranks.
- Administrative CRUD and assignment endpoints.
- LZT permission represented safely as `LZT Access`.

Do not restore derogatory rank names from historical requests.

## 16. Database model map

The Prisma schema currently declares these major models:

### Identity and security

- `Workspace`
- `User`
- `WorkspaceRank`
- `UserRank`
- `AuthSession`
- `SecurityRateLimit`
- `ExtensionInstance`

### Search and discovery

- `SearchSession`
- `SearchResult`
- `Domain`
- `DiscordLink`
- `HostingLocation`

### Leads

- `Lead`
- `LeadActivity`
- `Tag`
- `LeadTag`
- `Notification`

### Scanner

- `ScannerState`
- `ScannerResult`
- `ScannerFailureHistory`
- `ScannerSource`
- `ScannerDiscordLink`

### Product prices

- `RustPriceScannerState`
- `RustPriceSource`
- `RustPriceScanDiagnostic`
- `RustAccountListing`
- `RustPriceSnapshot`

### LZT and Haze

- `LztTrackerState`
- `LztRustListing`
- `LztHazeAlert`
- `HazeManualMessage`
- `LztMarketAverageSnapshot`

### Operations

- `Setting`
- `WorkspaceSetting`
- `AuditLog`
- `BackupMetadata`

Read relations, unique constraints, indexes, and workspace ownership directly from `apps/server/prisma/schema.prisma` before changing persistence.

## 17. API map

All application routes are defined primarily in `apps/server/src/app.ts`. Protected routes must remain authenticated; role/rank checks must remain server-side.

### Health and authentication

- `GET /api/health`
- setup status and initial setup
- login, logout, current user
- account update and password change

### Extension and events

- pair and heartbeat
- scanner start/stop for extension instances
- SSE at `/api/events`

### Brave and import

- Brave status/current/start
- URL/link imports
- search sessions and session details

### Contact scanner

- scanner state/results/detail
- start, stop, reset, retry failed, rescan result
- Discord reconciliation start/progress
- scanner CSV and failure exports
- scanner-to-Leads synchronization

### Product prices

- product state/listings
- import/search/start/stop/reset/delete
- retry failed/rescan all/rescan source
- listings and debug exports

### LZT

- snapshot/state
- start/stop/restart
- connection test
- custom test alert and retry
- manual Haze message
- recalculate
- administrative LZT health

### Leads and collaboration

- list/detail/create/update/delete
- bulk actions and assignment
- users, tags, notifications
- Leads CSV, Discord-only text, and history exports

### Administration

- workspace and Scanner ID rotation
- overview, members, ranks, users
- extension instances and force-stop
- scanner oversight
- audit events
- backup create/upload/download/delete/restore

Do not make an authenticated route public to support a batch script. Design a narrowly scoped credential only if the operator explicitly requests a supported external integration and the security model is reviewed.

## 18. Configuration map

Names may evolve; inspect `.env.example`, `deploy/fgp.env.example`, and source validation before changing production.

Important groups:

### Core

- `PORT`
- `HOST`
- `DATABASE_URL`
- `PUBLIC_APP_ORIGIN`
- `INITIAL_SETUP_TOKEN`

### Brave

- `BRAVE_SEARCH_API_KEY`
- `BRAVE_MAX_REQUESTS`
- `BRAVE_SEARCH_CONCURRENCY`
- cache TTL/capacity
- allowed/excluded domains

### Scraper

- private worker URL/port/token
- global and dynamic concurrency
- body, page, scroll, and timeout limits

### Discord reconciliation

- checker concurrency
- request timeout
- persisted job deadline

### LZT

- enabled flag
- API base URL/token
- poll and reconciliation intervals
- Rust app ID
- notification thresholds
- display currency/timezone

### Haze

- enabled flag
- operator-provided account credential
- target channel
- delivery poll interval

Never copy example placeholders into production without validating them. Never include real values in Git.

## 19. Local tooling and recovered workstation

Preferred tools:

- Node.js 22+
- pnpm compatible with the checked-in lockfile
- Python 3.10–3.13
- Chrome/Chromium for rendered worker tests
- Git
- GitHub CLI where authenticated

Recovered fallback wrapper:

```text
C:\Users\Mohammad\Documents\Codex\recovery-installers\Run-With-FgpTools.cmd
```

Example:

```text
C:\Users\Mohammad\Documents\Codex\recovery-installers\Run-With-FgpTools.cmd pnpm run test
```

The ordinary Windows PowerShell/Node environment may fail with a CET compatibility message. Use the known working command wrapper or a compatible shell. Do not weaken tests because the restored runtime needs permission or a wrapper.

Do not bake the workstation-specific fallback path into production application code.

## 20. Verification contract

Before a production release, run:

```text
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run security:scan
pnpm run release:build
```

Last fully recorded baseline:

- 24 JavaScript/TypeScript test files passed.
- 252 JavaScript/TypeScript tests passed.
- 42 Python/Scrapling tests passed.
- Lint passed with zero warnings.
- Type checking passed.
- Production build passed.
- Offline security scan passed.
- Audited release archive inspection passed.

Test counts can legitimately increase. Do not force new output to match historical counts; investigate regressions and report the current exact results.

Task-specific verification should include the nearest unit/integration tests and a focused manual smoke test. A deployment requires full verification plus production health and workflow validation.

## 21. Git rules

- Primary branch: `main`.
- Never force-push `main`.
- Preserve unrelated user changes.
- Inspect every dirty tracked file before editing it.
- Review every untracked file before staging it.
- Avoid `git add -A` in this workspace.
- Before deployment, fetch and confirm `origin/main` is an ancestor of local `main`.
- Resolve divergence explicitly.
- Keep secrets, databases, logs, archives, output reports, generated clients, caches, backups, and staging folders out of Git.
- Report states precisely:
  - modified locally;
  - committed locally;
  - pushed to GitHub;
  - deployed to VPS;
  - verified publicly.

## 22. Deployment workflow

Normal operator launcher:

```text
DEPLOY-FGP.cmd
```

The committed deployment workflow is intended to:

1. Build a fresh allowlisted release archive.
2. Fetch the GitHub branch.
3. Refuse behind/diverged history.
4. Stage only release-approved files.
5. Commit release-scoped changes if necessary.
6. Push the exact source.
7. Hash and upload the release archive.
8. Verify archive and lockfile remotely before downtime.
9. Back up SQLite.
10. preserve a rollback release.
11. install dependencies and generate Prisma.
12. apply migrations/compatibility helpers.
13. build the application.
14. install/reload systemd and Caddy definitions.
15. start services.
16. verify loopback and public health.
17. roll back automatically on rollout failure.

### Current local mutex work

The local dirty changes add a mutex wrapper to prevent two deployment windows from rebuilding the same shared archive. Before adopting them:

1. Review the five related files together.
2. Confirm launcher paths work with and without normal Node on PATH.
3. Open one deployment, then confirm a second invocation exits safely before rebuilding.
4. Confirm a single invocation still performs the release build exactly once.
5. Run the normal verification suite.
6. Commit/push only the intended launcher files.
7. Deploy once, with one window.
8. Require `FGP_DEPLOYMENT_OK`.
9. Verify services, `/api/health`, public dashboard assets, and a task-relevant smoke test.

Do not open two deployment windows while validating the old workflow.

## 23. Production verification checklist

After an authorized deployment:

- Deployment log ends with `FGP_DEPLOYMENT_OK`.
- `fgp-api.service` is active.
- `fgp-scraper.service` is active.
- `fgp-haze-notifier.service` is active when configured.
- Loopback `/api/health` is healthy.
- Public `https://forhud.shop/api/health` is healthy.
- Public dashboard loads and references the newly built assets.
- Database backup exists and passed integrity validation.
- Rollback directory exists.
- GitHub `main` contains the exact deployed source commit.
- The changed workflow passes a production smoke test.
- No secret appears in logs or Git diff.

## 24. Known operational lessons

- CRLF in the generated Linux script once caused `set: pipefail` failures. Preserve carriage-return normalization.
- Missing local output folders once broke deployment logging. Keep automatic creation.
- `Get-FileHash` was unavailable in one Windows environment. The safe script moved to .NET SHA-256.
- Frozen pnpm lockfile mismatches previously interrupted rollout. Preflight must validate the exact archive before downtime.
- Early API connection refusals can occur during startup. They are acceptable only if bounded retries end in verified health.
- A build finishing does not mean a deployment succeeded.
- An active systemd service does not prove its business workflow works.
- Overlapping deployments previously caused a checksum mismatch because both touched the same archive. This motivated the current mutex work.
- Third-party blocks, CAPTCHAs, access walls, and rate limits are real states, not bugs to disguise.

## 25. Highest-priority unfinished work

Priorities should be revalidated with the operator and current evidence.

### A. Finish and verify the deployment mutex

The implementation exists locally but is dirty and unverified. This is the clearest immediate repository-state risk.

### B. Controlled Searcher/scanner production measurement

Run a bounded sample and measure:

- requested versus discovered unique domains;
- contact success rate;
- Discord/Telegram/email distribution;
- no-contact rate;
- timeout rate;
- blocked rate;
- worker error rate;
- median and p95 scan duration;
- retry recovery rate;
- domains retired after five failures;
- persistence after page refresh and service restart.

Do not promise every website can be scraped.

### C. Discord reconciliation production validation

Verify persisted progress, rate-limit handling, server-identity deduplication, retry classification, and simple-link export.

### D. Credential rotation audit

Historically pasted Brave/LZT/Discord credentials should be rotated privately. Verify presence/status without displaying values.

### E. Untracked-file cleanup

Review one-off root scripts and staging folders. Promote only genuinely reusable tools into a named, documented location. Delete only with explicit understanding and operator authorization.

## 26. Troubleshooting playbooks

### Login fails

1. Confirm public and loopback health.
2. Confirm the API service is active.
3. Inspect sanitized recent service logs.
4. Confirm database availability and migration state.
5. Distinguish invalid credentials, rate limiting, session/cookie origin issues, and SQLite write contention.
6. Never attempt to recover a password hash.
7. Use an authorized reset flow if needed.

### Search returns fewer domains than requested

1. Inspect persisted search session state.
2. Compare raw Brave results, excluded platforms, duplicates, unique domains, request budget, and provider exhaustion.
3. Check the positive cache and query variants.
4. Confirm target maximum and request settings.
5. Do not label provider exhaustion as application success at the requested target.

### Scanner shows high timeout/blocked counts

1. Export structured diagnostics.
2. Separate homepage outcome from speculative path outcomes.
3. Group by DNS/TLS/connection/timeout/429/5xx/block/worker/policy/no-contact.
4. Review `Retry-After` and retry history.
5. Compare worker pressure and adaptive concurrency.
6. Reproduce against controlled fixtures before changing classification.
7. Do not add bypass techniques.

### Haze message does not post

1. Confirm alert/manual-message row exists.
2. Inspect its status, attempts, last error, and next retry.
3. Confirm service state and sanitized logs.
4. Confirm credentials are present privately, without echoing them.
5. Distinguish connection from delivery.
6. Use a bounded custom test alert.

### Deployment fails

1. Keep the window/log.
2. Identify whether failure occurred before or after production replacement.
3. Confirm Git publication status.
4. Confirm archive checksum and preflight lockfile result.
5. Confirm backup and rollback paths.
6. Let the script's rollback finish.
7. Never manually delete the current release or database in panic.
8. Fix the root cause locally, rerun verification, and deploy once.

## 27. Operator communication style

- Use plain, direct language.
- Lead with the outcome.
- State what was verified.
- Keep progress updates concise.
- Avoid jargon unless it helps a diagnosis.
- Do not repeatedly ask questions that repository evidence can answer safely.
- Do ask when a missing choice changes scope, security, production data, or external side effects.
- Never claim "done," "live," "deployed," or "fixed" without matching evidence.
- When something fails, explain the actual failed layer and the next safe action.

## 28. First-session protocol for DeepSeek V4 Pro

On the first OpenCode turn:

1. State that `AGENTS.md`, this handoff, and the original handoff were read.
2. Report current branch, HEAD, relation to `origin/main`, and dirty files.
3. Explicitly mention the local uncommitted deployment-mutex work if it is still present.
4. Confirm no historical credential will be reused or printed.
5. Do not deploy merely because production details are available.
6. Ask for no permission when performing safe read-only inspection.
7. For a requested change, inspect, implement, test, and report exact results.
8. For a requested deployment, complete Git publication, VPS rollout, health verification, and a public workflow smoke test.

## 29. Definition of done

A code task is complete only when:

1. The requested behavior exists in the correct layer.
2. Security, workspace isolation, persistence, and failure states are preserved.
3. Relevant regression tests exist and pass.
4. Relevant lint/type/build/security checks pass.
5. No secret or runtime data is staged.
6. Git state is understood and reported.
7. User changes outside the task remain intact.

A deployment task additionally requires:

8. Exact source committed and pushed.
9. VPS rollout completes with the success marker.
10. Health checks pass.
11. Public assets/workflow are smoke-tested.
12. Backup and rollback evidence exist.

## 30. Final warning to the receiving model

This codebase was recovered after an OS failure and then stabilized through many production fixes. It contains real operational data paths and a dirty workspace with unfinished launcher work. Be fast, but do not be casual.

The most valuable behavior is evidence-driven continuity:

- preserve the dirty work until understood;
- preserve authentication and SSRF protection;
- classify external failures honestly;
- keep queues and progress persistent;
- treat GitHub, VPS deployment, and public verification as separate states;
- never expose secrets;
- never replace measured behavior with a confident guess.
