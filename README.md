# FGP — Forhuds Panel

FGP is a local-first, multi-user lead research platform. It combines a React/Vite dashboard, an Express/TypeScript API, Prisma with SQLite, a bounded SSRF-protected Scrapling scanning service, and a secure Manifest V3 Chrome extension.

## Architecture

- `apps/dashboard` — dark React dashboard with authentication, scanner, link import, splitter, leads table/Kanban, My Leads, hosting checks, history, settings, and administrator controls.
- `apps/server` — Express API, cookie sessions, role authorization, workspace isolation, extension pairing, persistent scanner workers, SSE updates, SSRF protection, CSV exports, backups, and audit logging.
- `apps/scraper` — private Python service using Scrapling for asynchronous static fetching, selective browser rendering, and deterministic contact/page extraction.
- `apps/server/prisma` — SQLite schema and ordered, data-preserving migrations.
- `apps/extension` — Chrome MV3 extension that pairs using the dashboard Scanner ID and reads organic URLs from a Google results page opened by the user.
- `packages/shared` — validation, URL normalization, Discord detection, CSV, and splitter utilities shared across the platform.

All workspace-owned records carry a workspace ID. Dashboard sessions use opaque HttpOnly, Secure, SameSite cookies with a rolling 30-day lifetime; passwords are required, capped at 200 characters, checked server-side for guess resistance without a fixed minimum length, and use salted `scrypt` hashes. Scanner IDs contain 80 bits of randomness; known legacy/bootstrap values are never accepted for pairing and are replaced automatically before setup or pairing can proceed. Extension bearer tokens are random, stored only as hashes on the server, and can be revoked independently. Rotating a Scanner ID revokes all existing extension tokens.

The Node scanner is the source of truth. It owns authentication, the queue, persistence, stop/resume, concurrency, robots policy, deep-scan boundaries, and security. Before the loopback-only Python worker receives a URL, Node resolves and rejects local/private/link-local/metadata targets. It repeats that validation for every redirect and every deep-scan candidate.

## Start locally

Requirements: Node.js 22 or newer, Python 3.10–3.13, and Chrome/Chromium.

```text
npm install
npm run scraper:setup
npm run db:generate
npm run db:migrate
npm run dev
```

Open `http://localhost:5173`. On the first visit, create the initial administrator with a username and password. Existing local leads and history are preserved and attached to that workspace.

The API listens on `http://localhost:3001`; `/api/health` reports database, extension, and Scrapling worker availability. `npm run dev` starts the Scrapling worker, API, and dashboard together.

## Chrome extension

Build it with:

```text
npm run build -w @lead/extension
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select:

```text
apps/extension/dist
```

If it is already loaded from that folder, you do not download it again. Click **Reload** on its card after rebuilding. Open the popup and enter the **Scanner ID** shown in the dashboard top bar.

The extension creates a separate instance ID for each browser profile. Press **Start Scanner** on a Google results page. Choose a preset target, enter a custom target (up to the configured safety maximum), or choose **Until Stopped**. It captures unique organic business domains, continues through available result pages for that manually opened query, survives popup closure and service-worker sleep, and stops at the target, when Google has no accessible next page, when **Stop Scanner** is pressed, or when an administrator force-stops it. It does not create queries or automate new Google searches. Page and URL deduplication prevents loops and duplicate imports.

## Main workflows

- **Searcher:** accepts a query and automatically discovers a preset or validated custom number of unique business results with the Brave Search API, or imports extension results and pasted URLs/bare domains/CSV/TXT content. Every accepted business domain enters the same domain-deduplicated scanner queue and is saved to Leads automatically; later discoveries enrich that one existing Lead instead of creating copies.
- **Scanner engine:** Scrapling `AsyncFetcher` performs ordinary static requests first. Only unresolved JavaScript shells, selected social/contact routes, and recoverable 403/5xx documents enter the separate browser-render tier. Static domain work can run broadly in parallel while Chromium rendering is capped independently (three concurrent renders by default), preventing difficult sites from starving easy domains. Adaptive concurrency starts at the configured ceiling, halves on HTTP 429 pressure, steps down on timeouts/5xx responses, and restores workers after sustained healthy scans. The Searcher reports live throughput, current/configured concurrency, median and p95 duration, completion rate, and pressure counts. Static connections and the rendered top-level site are pinned to the public DNS addresses that passed SSRF validation. The renderer blocks cross-origin subresources and navigation, waits for a bounded render window, scrolls, expands non-transactional social controls, and inspects the approved document and shadow roots. Extracted metadata, Discord destinations, email addresses, social links, and scanned pages are persisted in SQLite.
- **Discord recovery:** extraction inspects every anchor destination, including icon-only SVG/image controls, plus raw HTML, visible text, embedded JSON/hydration data, URL-bearing attributes, first-party script bundles, rendered DOM/frames, Discord widgets, branded Discord landing routes, and destinations exposed by redirects. Failed guessed paths do not consume the useful-page budget, but a separate hard attempt ceiling keeps every crawl bounded. The crawler records valid Discord evidence even when it appears in a branded 4xx/5xx document. If an imported URL is outdated or unavailable, the centralized recovery pipeline records every attempt and safely tries the domain root, prioritized same-site community/contact/FAQ/review pages, a `www` hostname variant, and up to three explicitly linked public social/profile pages with no recursive external crawl. HTTP is considered only for a non-TLS HTTPS failure. Structured fetch and scanner outcomes keep HTTP failures separate from the overall completed/fallback result.
- **Deep Scan:** Node keeps one bounded same-domain crawl queue. It prioritizes likely contact/community paths, saves a database checkpoint after each page, and resumes without duplicating completed pages.
- **Leads:** supports table/Kanban views with persistent drag-and-drop status changes, detailed research fields, tags, statuses, priorities, assignments, activity history, My Leads, an in-app notification center, and CSV export. A workspace/domain database constraint prevents duplicate Leads. Scanner contacts prefill empty Lead fields and never overwrite manual content.
- **Splitter:** supports first/all colon splitting, a custom delimiter, and a URL-aware Website/Discord mode that understands inconsistent separator spacing and Markdown links without splitting `https://`.
- **Administration:** creates/disables users, changes roles, monitors/revokes extension instances, force-stops scanners, views audit events, and creates/downloads/restores validated SQLite snapshots.
- **Backups:** use SQLite `VACUUM INTO`, integrity and required-table validation, manifest metadata, daily automatic retention, and a pre-restore safety snapshot. Restore invalidates existing sessions.

Scanner Reset removes scanner workspace records only; it does not delete saved Leads.

## Responsible scanning

Deep Scan is off by default, is same-domain only, and normal scans default to 6 pages with a maximum depth of 2. robots.txt respect and Dynamic Fallback are on by default. Normal Discord recovery stops at the first valid destination, allows at most two browser-render candidates, and has a 45-second domain budget. Explicit Deep Scan may use the configured page limit, up to three browser-render candidates, and a two-minute domain budget. Requests within a domain are serialized with a small delay while independent domains use the configured worker concurrency.

Dynamic rendering is deliberately same-host and blocks cross-host browser subrequests. No proxy rotation, CAPTCHA solving, fingerprint spoofing, stealth fetcher, or anti-bot bypass is enabled. A blocked target is recorded and the queue continues.

## Worker commands and configuration

`npm run scraper:setup` creates `apps/scraper/.venv`, installs the pinned Python dependencies, and installs the browser binaries required by Scrapling. `npm run scraper:dev` starts only the worker. `npm run scraper:test` runs its controlled fixture tests.

For manual self-hosted startup, run these as three supervised services:

```text
npm run scraper:dev
npm run dev -w @lead/server
npm run dev -w @lead/dashboard
```

Configuration:

```text
DATABASE_URL="file:./lead-intelligence.db"
PORT=3001
HOST=127.0.0.1
PUBLIC_APP_ORIGIN=http://localhost:5173
AUTH_BYPASS_ENABLED=false
INITIAL_SETUP_TOKEN=replace-with-a-one-time-production-setup-secret
SCRAPER_URL=http://127.0.0.1:3011
SCRAPER_TOKEN=replace-with-a-long-random-secret
SCRAPER_PORT=3011
BRAVE_SEARCH_API_KEY=replace-with-your-brave-search-api-key
MAX_SEARCH_TARGET_RESULTS=5000
MAX_BRAVE_SEARCH_REQUESTS=60
SCRAPER_MAX_BODY_BYTES=10485760
SCRAPER_MAX_SCROLL_STEPS=6
SCRAPER_SCROLL_WAIT_MS=125
```

Place these values in `apps/server/.env` when running the server through its workspace command. A fresh production database will not create its first administrator until the operator supplies an `INITIAL_SETUP_TOKEN` of at least 24 characters and enters the same one-time value in the setup form. Existing installations do not use this token after the first administrator exists. Keep the scraper bound to loopback and use the same unique `SCRAPER_TOKEN` of at least 24 characters in the scraper and Node environments; production startup rejects the development placeholder. Set `NODE_ENV=production`, a precise `PUBLIC_APP_ORIGIN`, and a protected `BACKUP_DIR` for a non-local deployment. HTTPS enables the session cookie's `Secure` flag.

`AUTH_BYPASS_ENABLED=true` is an explicitly unsafe temporary operating mode. It maps every unauthenticated request to the first active administrator and exposes all data and mutations publicly. The dashboard displays a permanent red warning while the mode is active. Prefer the default `false`; production deployments can change the mode reversibly with `deploy-release.ps1 -AuthBypass enabled` or `deploy-release.ps1 -AuthBypass disabled`.

Scanner IDs created by current builds use 80 bits of entropy. On the first hardened startup, legacy short Scanner IDs are rotated and existing extension tokens are revoked, so each Chrome profile must reconnect once using the new ID shown in the dashboard.

The Brave key is read only by the Node server and is never returned to the browser. In Searcher, enter a query, choose the desired result count, and select **Find & scan**. The selected count means distinct business domains, not raw result URLs. The collector paginates and distributes its request budget across closely related business-intent variations of the same query, deduplicating domains and replacing excluded platform results until it reaches the target or Brave has no more unique results. One Brave API request can return up to 20 results; the panel displays the maximum request budget before starting. Google automation remains intentionally excluded: the extension only reads organic URLs from result pages opened manually by a user.

Reaching the configured discovery page budget is a normal completed outcome, not a scanner failure. When no public Discord destination is found, FGP records `DISCORD_NOT_FOUND`, preserves every checked page and attempt, and keeps the website in Leads. Normal discovery uses a small priority-page budget; Deep Scan and the audit command use the larger configured limits.

Business discovery filtering applies to Brave, extension, and manual imports. Social/community sites (including Discord and Reddit), gaming stores (including Steam), marketplaces, directories, review sites, search engines, link hubs, and similar platforms are ignored before DNS resolution or scanning. Extend the defaults with a comma-separated `SEARCH_EXCLUDED_DOMAINS` value. Use `SEARCH_ALLOWED_DOMAINS` only for an intentional exception to the default list.

## Verification

```text
npm run lint
npm run typecheck
npm test
npm run build
npm run security:scan
```

`npm run security:audit` also queries the npm and Python advisory databases and should be run from a network-enabled development or deployment environment with `pip-audit` installed.

Create a deployment archive only with the audited release builder:

```text
npm run release:build
```

The builder uses a source allowlist and rejects archives containing environment files, SQLite databases, backups, logs, caches, generated clients, or other local runtime data. Do not upload an archive made from the whole workspace.

Run the bundled known-positive Discord discovery audit after building the server:

```text
npm run build -w @lead/server
npm run audit:discord-discovery
```

The no-argument command uses `tests/fixtures/known-positive-discord-sites.txt`. You can still pass a different input and output stem directly to `apps/server/scripts/discord-discovery-audit.mjs`. The command preserves input order and duplicates, scans with bounded concurrency, and writes detailed JSON, a flat CSV, and a summary JSON containing raw-line, unique-URL, unique-domain, testability, method, and failure counts. Reports include original/fallback HTTP statuses, pages checked, normalized invite, discovery method/section/interaction, validation status, failure category, robots status, and duration. Live-site results are evidence from that run, not a guarantee that a changing third-party site or invite will remain available.

The JavaScript integration suite uses disposable databases and covers authentication, session security, roles, assignment visibility, workspace isolation, extension pairing/revocation, backups, SSRF rejection, large imports, deduplication, persistent idle scanning, stop/resume, 404/root recovery, robots fallbacks, controlled social redirects, script-asset discovery, error-document evidence, aggregator handling, and lead preservation. The Python suite covers Scrapling static fetching, redirect handoff, metadata, Discord extraction strategies, root/widget destinations, soft-404 classification, email/social extraction, same-domain link selection, and worker-side defense in depth.

## Third-party software

Scrapling 0.4.11 is a pinned runtime dependency under the BSD 3-Clause License. The required copyright, conditions, disclaimer, and upstream link are preserved in `THIRD_PARTY_NOTICES.md`.
