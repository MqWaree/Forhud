# FGP / Forhuds Panel — OpenCode Handoff

Last updated: 2026-09-02 (Europe/Paris)

DeepSeek V4 Pro takeover note: the current model-specific transfer is in `DEEPSEEK-V4-PRO-HANDOFF.md`, the failed/partial/no-result optimization and bug-fix history is in `DEEPSEEK-ATTEMPT-LEDGER.md`, and the ready-to-paste OpenCode bootstrap prompt is in `DEEPSEEK-V4-PRO-START-PROMPT.md`. Read those after `AGENTS.md`. This document remains the durable chronological/product handoff.

This document transfers the durable project context from a long-running Codex conversation into the repository. It intentionally omits all secret values. Read `AGENTS.md` first for mandatory engineering and deployment rules.

## 1. Executive summary

FGP began as a lead-intelligence/search-and-scan panel and expanded into a multi-user production platform with:

- authenticated workspaces and roles;
- a Brave Search business-domain collector;
- a persistent website scanner backed by a private Scrapling service;
- Discord, Telegram, and email discovery;
- Leads table/Kanban workflows and exports;
- a general market/product price scanner;
- an official LZT Market Rust account tracker;
- Discord-style workspace ranks and member sidebar;
- Haze-account notification delivery;
- safe database backups, migrations, deployment, and rollback.

Production is served at `https://forhud.shop` from an Ubuntu VPS. GitHub is `https://github.com/MqWaree/Forhud` and the primary branch is `main`.

The latest application release baseline is commit `7ecf02d`, and current GitHub `main` also contains this OpenCode handoff and repaired deployment launchers. Resolve the current remote HEAD when starting work. The recovered application changes have now been deployed and independently verified; see the production evidence below.

## 2. Current source and verification state

Git history of interest:

- `7ecf02d` — merged the recovered release with the existing remote `main` history and added the committed Vitest configuration to the release manifest.
- `1f9d695` — large recovered FGP release containing the dashboard evolution, market/LZT features, scanner improvements, deployment improvements, migrations, tests, and operational services.
- `ef9b089` — production login SQLite timeout fix.
- Earlier remote commits hardened authentication, setup, scanner pairing, secrets, password validation responses, and pnpm deployment compatibility.

Validation performed on the exact merged tree on 2026-09-01:

- 24 Vitest files passed.
- 252 JavaScript/TypeScript tests passed.
- 42 Python/Scrapling tests passed.
- ESLint passed with zero warnings.
- TypeScript checks passed for dashboard, extension, server, and shared packages.
- Production build passed.
- Offline security scan passed.
- The safe release builder created and inspected a 233-entry archive.

The working tree also contains untracked historical one-off patchers, layout staging folders, and diagnostics. These were deliberately excluded from commits and deployment. Do not use `git add -A` blindly outside the deployment allowlist.

## 3. Production topology

Public and server locations:

- Domain: `forhud.shop` and `www.forhud.shop`
- VPS address: `162.35.162.136`
- Operating system: Ubuntu
- Release directory: `/opt/fgp`
- Environment file: `/etc/fgp/fgp.env`
- SQLite database: `/var/lib/fgp/lead-intelligence.db`
- Database backups: `/var/backups/fgp`
- API loopback address: `127.0.0.1:3001`
- Scrapling worker: private loopback service (normally port 3011)
- Web/API front door: Caddy with automatic HTTPS

Systemd units:

- `fgp-api.service`
- `fgp-scraper.service`
- `fgp-haze-notifier.service`

Security hardening is present in the units: non-root `fgp` user/group, strict filesystem protection, private temporary/device namespaces, no new privileges, restricted writable directories, restart-on-failure, and restrictive umasks.

Caddy serves the built React dashboard from `/opt/fgp/apps/dashboard/dist`, proxies `/api/*` to the loopback API, uses SPA fallback routing, compresses responses, and applies HSTS, CSP, Permissions Policy, frame denial, MIME sniffing protection, referrer policy, and server-header removal.

## 4. Deployment and recovery workflow

The normal deployment entry point is `DEPLOY-FGP.cmd` on Windows.

It now:

1. Locates Node, or uses the recovered local FGP tool wrapper.
2. Builds a fresh allowlisted release archive.
3. Calls `deploy-release.ps1`.

`deploy-release.ps1` automatically publishes the matching source to GitHub before changing production:

- requires a named Git branch;
- fetches the remote branch;
- refuses deployment when the branch is behind or diverged;
- stages only approved source and operational paths;
- excludes secrets, databases, logs, archives, generated/runtime data, and one-off root helpers;
- creates a timestamped deployment commit when release files changed;
- pushes that commit;
- resolves and prints the release commit;
- uploads the archive only after the push succeeds.

The remote phase:

- checks SHA-256;
- extracts into a preflight directory;
- verifies the frozen lockfile before stopping services;
- creates a timestamped database backup;
- preserves a timestamped rollback release;
- installs dependencies and regenerates Prisma;
- applies the metric-width compatibility helper and Prisma schema;
- builds all workspaces;
- installs Caddy/systemd definitions;
- starts the scraper, API, and Haze worker;
- waits for loopback health;
- checks public health;
- rolls back automatically if anything fails after replacement.

The latest successful local log is:

```text
outputs/deploy-release-20260901-235350.log
```

It ends with:

```text
FGP_DEPLOYMENT_OK
```

and both loopback/public health payloads reported the database connected and Scrapling healthy. An independent HTTPS request after completion returned the same healthy payload. The public HTML referenced `index-BkNjb471.js` and `index-CUVbUSv1.css`, matching the assets generated inside the deployment log. GitHub recorded the safe deployment workflow at commit `5d1b16b`; changes after application commit `7ecf02d` are handoff/launcher operations rather than a different runtime feature tree.

Historical deployment lessons:

- Windows CRLF characters previously broke a Linux remote script with `set: pipefail` errors. The remote template now strips carriage returns.
- A missing local output directory previously broke logging. It is created automatically.
- `Get-FileHash` was unavailable in one environment. The script uses .NET SHA-256 directly.
- A pnpm frozen-lockfile mismatch previously stopped rollout. Preflight now validates the exact archive/lockfile before service downtime.
- The API may need several health retries after start; early connection-refused messages are normal if followed by healthy responses.
- Never infer success from a build alone. Require the final deployment marker and public verification.
- Do not run two deployment launcher windows simultaneously. An overlapping attempt rebuilt the shared local archive after another process had hashed it, causing one safe checksum rejection. The later isolated deployment completed successfully. Add a local deployment mutex before further launcher work.

## 5. Workstation recovery context

The Windows OS previously became unusable. Project files were recovered using the repository and data under `C:\Windows.old`. Git, GitHub authentication, Node/Python tooling, and the Python environment were restored.

Current project folder:

```text
C:\Users\Mohammad\Documents\Codex\2026-08-02\referenced-chatgpt-conversation-this-is-an
```

Fallback tool wrapper:

```text
C:\Users\Mohammad\Documents\Codex\recovery-installers\Run-With-FgpTools.cmd
```

The ordinary terminal may find `pnpm` while failing to find `node`. Use the wrapper until Node 22+ is installed/restored globally. Do not assume local PATH behavior matches the VPS.

## 6. Authentication and security history

Early security work hardened:

- initial administrator setup;
- scanner pairing and Scanner IDs;
- extension tokens;
- production secret validation;
- SSRF boundaries;
- authentication and role checks;
- deployment safety.

Password policy changed after the operator asked to remove a fixed minimum length. A subsequent security review demonstrated that a hand-built character-pool estimate accepted obvious transformations such as `P@ssw0rd!`. The desired final behavior is not “accept everything” and not “restore a fixed 12-character minimum.” It is a shared, server-side guess-resistance policy that rejects common/breached-style passwords and predictable transformations across:

- first setup;
- administrator user creation;
- administrator reset;
- self-service password change.

Accounts created during weaker policy periods may need forced password changes. Tests should cover leetspeak, case/substitution/year/suffix variants, genuinely random shorter values, and long passphrases.

Authentication was temporarily bypassed during troubleshooting, making the whole system publicly modifiable. This was acknowledged as unsafe and later reversed. The permanent requirement is: **login must work and remain enabled**.

The remote GitHub history includes a fix for production login timeouts. SQLite permits one writer, so invalid-login account/IP counters must use short atomic UPSERTs in sequence. Do not reintroduce parallel interactive transactions that can deadlock into Prisma P1008 timeouts.

Other security invariants:

- sessions are opaque, HttpOnly, Secure under HTTPS, SameSite, and rolling;
- password hashes use salted `scrypt`;
- setup requires a strong one-time token in production when no user exists;
- extension tokens are random, server-stored as hashes, independently revocable;
- Scanner IDs use high entropy and rotate legacy values;
- rotating Scanner ID revokes existing extension instances;
- persistent rate limits survive process restarts;
- sensitive errors are not exposed as raw internal stacks in production;
- backups are integrity-checked and restores invalidate sessions.

## 7. Dashboard and user experience

Primary navigation currently includes:

- Searcher
- Splitter
- Leads
- My Leads
- Rust Account Prices / product-price scanner
- History
- Settings
- Administration for authorized users

Design direction established in the conversation:

- dark near-black/navy panel;
- purple accents inspired by a compact Haze interface;
- small pixel-style typography for the Haze card, using the committed `smallest_pixel-7.ttf` asset where appropriate;
- compact cards, restrained shadows, aligned labels, and centered/clean notification cards;
- controls should blend into their container rather than looking like default white browser inputs;
- information density similar to Discord/Haze without sacrificing readability;
- Discord-like member list grouped by rank, with role colours/status presence.

The operator repeatedly requested that buttons and filters blend in, layouts become smaller/sleeker, and statistics remain small/subtle rather than dominating the page.

## 8. Searcher and Brave discovery

The Searcher accepts a query and requested unique-domain target. The user often requests 500 results and was frustrated when only 74–106 were returned.

Expected behavior:

- use Brave Search on the server;
- one Brave call may return up to 20 raw results;
- paginate and use closely related business-intent query variations;
- deduplicate canonical domains;
- discard platforms/directories/marketplaces/social/search engines before scanning;
- keep searching until target reached, safe request budget exhausted, or Brave has no new domains;
- report the difference between raw platform results, unique domains, queued sites, and leads;
- never pretend the requested target was achieved when the provider was exhausted.

Production defaults evolved to reduce token/request waste while preserving quality:

- positive search result caching;
- a cache capable of retaining many pages;
- page/query reuse;
- canonical-domain deduplication before consuming further scanner work;
- `BRAVE_MAX_REQUESTS=300` unless deliberately overridden;
- `BRAVE_SEARCH_CONCURRENCY=3`;
- no repeated API request for pages already represented by a valid cached result.

The Brave API key was changed multiple times during troubleshooting. **No historical value is safe to reuse from chat.** Put a newly rotated key only in `/etc/fgp/fgp.env`, restart the API, verify provider connectivity, and ensure the key never reaches the dashboard payload or logs.

The search progress bar must persist through browser refresh and show accurate current-search information. Requested subtle statistics include percentage, discovered, queued, active, scanned, contacts found, failed, timeout, blocked, retrying, current concurrency, throughput, and latency.

## 9. Website/contact scanner evolution

The user reported very poor production counts, including examples around:

- Failed: 138
- Timeout: 171
- Blocked: 128

The current reliability release was specifically designed to address false classification and transient failures without attempting anti-bot bypass.

Important fixes already implemented:

1. A healthy homepage no longer becomes a whole-domain Timeout/Blocked result merely because guessed fallback paths fail.
2. The original useful result/failure is tracked independently of speculative recovery attempts.
3. Telegram and email found on recovery pages are returned and synchronized, not dropped while only Discord is considered.
4. Recovery reports expose `contactFound`, emails, social links, checked pages, and detailed attempt data.
5. High-value fallback fetches have a bounded larger timeout than ordinary speculative pages.
6. Transient scanner failures automatically retry up to two times after the original attempt, using bounded exponential backoff and a two-hour persistence window.
7. Retryable classes include timeout, 408/425/429/5xx, DNS/connection failures, invalid transient responses, and scraper busy/offline/error conditions.
8. Permanent blocks and policy failures do not retry forever.
9. The `Retrying` state is recovered after application restart and counted correctly in progress.
10. Stop interrupts retry waits.
11. Python worker errors carry structured network codes and retry hints.
12. Node classifies remote network causes before generic local worker 5xx errors.
13. `Retry-After` is preserved and used.
14. Adaptive concurrency reduces immediately when the local scraper is busy/offline/erroring.
15. Safe positive DNS caching and in-flight lookup deduplication reduce repeated resolution overhead.

The scanner uses a static-first approach and renders only unresolved JavaScript shells or selected recovery pages. Dynamic rendering is separately concurrency-limited because Chromium work is expensive.

Contact extraction strategies include:

- standard anchor destinations;
- icon-only links and accessibility labels;
- raw HTML and visible text;
- embedded JSON/hydration payloads;
- URL-bearing attributes;
- first-party script bundles;
- controlled rendered DOM/shadow-root inspection;
- redirect destinations;
- Discord widgets/root/channel paths;
- same-domain contact/community/support/FAQ/review routes;
- bounded `www`/root recovery;
- explicitly linked supported social/profile/aggregator pages.

Do not report `Completed with fallback` as a valid lead unless at least one requested contact is extracted. `DISCORD_NOT_FOUND` should remain distinct from transport errors.

The user requested removal of a site from the active list after more than four extraction failures. Current intended behavior is removal after the fifth failed contact attempt while retaining a permanent, downloadable failure-history record.

## 10. Discord invite checker/reconciliation

The dashboard has a Discord Links metric and a reload/reconciliation action. Its purpose is to determine whether different invite URLs lead to the same Discord server.

Requirements established:

- persisted job rather than one long synchronous request;
- progress bar and subtle job statistics;
- grouping of identical normalized destinations before requesting Discord;
- resolved server identity used to merge duplicate invites;
- respect HTTP 429 and `Retry-After`;
- classify 403, 429, 5xx, timeout, worker timeout, and invalid invite separately;
- continue safely after individual failures;
- expose result counts and current progress through the API/SSE;
- export only normalized Discord links when the user requests the simple Leads export;
- clickable Discord/website URLs in Leads Kanban.

Do not attempt to bypass Discord access controls. A blocked/rate-limited invite remains a transparent operational result.

## 11. Leads and Kanban

Leads automatically synchronize from valid scanner contacts. The definition evolved:

- Discord is valid;
- Telegram is valid;
- if Discord and Telegram both exist, preserve both;
- email is the fallback when both Discord and Telegram fail;
- do not add a “valid contact” lead with no usable Discord, Telegram, or fallback email.

The Leads area supports:

- table and Kanban views;
- persistent statuses/priorities;
- assignment;
- tags;
- activity history;
- My Leads filtering;
- bulk operations;
- CSV exports;
- Discord-link-only text export;
- clearing all leads through an explicit destructive action;
- smooth drag/drop with server persistence;
- hover detail panel;
- clickable source/contact URLs.

Automatic enrichment must not erase manual operator edits. Canonical workspace/domain uniqueness prevents duplicate business leads.

## 12. General price scanner

A separate scanning mode was added to discover prices for Rust NFA accounts, later generalized to arbitrary products.

Required behavior:

- top-level mode/tab switching;
- product type choices: Rust NFA, Game accounts, Other items;
- custom product/search term;
- isolated data scope per product;
- sorting by Price, including click-on-header behavior;
- filters for search text, listing type/category, min price, and max price;
- currency display/conversion for DKK, EUR, USD, and RUB;
- overall market statistics at the bottom;
- category-level statistics only for categories with at least three hits;
- delete-all-results action;
- ability to retry failed scans and rescan all;
- debug JSON/CSV for passed and failed scans;
- duplicate-site normalization despite scheme, `www`, subdomain/path, prefix, or suffix variants where they represent the same source.

The operator’s wording occasionally said “scams” when referring to scans. Treat that as a typo unless the surrounding request clearly indicates fraud analysis.

## 13. LZT Market tracker

LZT is a dedicated, rank-gated subview of the Rust price page.

Access and API:

- built-in permission/rank: `LZT Access`;
- API base: official LZT Market production API;
- Rust Steam app ID: `252490`;
- newest listings ordered by listing date descending;
- exclude brute-force, phishing, and stealer origins;
- token belongs only in the VPS environment;
- token is optional for public mode;
- public mode never bypasses human verification and polls at least 60 seconds apart.

Historical issues and fixes:

- human-verification/access challenge was correctly shown instead of bypassed;
- token installation initially failed because a wrong/invalid credential was used;
- one response did not return the requested EUR price unit, prompting stricter response validation and conversion handling;
- HTTP 503 and category timeouts required backoff and resilient polling;
- newest listings did not always auto-update, leading to SSE/polling/restart work;
- detection latency once displayed an absurd multi-billion-millisecond value, leading to bigint/metric normalization and migration helpers;
- API latency and detection metrics should remain realistic and independently measured.

Listing data requested:

- listing ID and link;
- account title/type;
- price in selected currency and useful dual-currency notification display;
- games count;
- Rust hours;
- kills/deaths where available;
- inventory item count;
- Rust inventory value;
- CS2 inventory value;
- total inventory value;
- DLC packs;
- listed/updated/sold timestamps;
- lifecycle/sold status.

Inventory hover behavior:

- hovering total inventory opens a clean breakdown box;
- every value must be converted to the currently selected UI currency;
- never label a RUB source value as USD/EUR/DKK without conversion;
- preserve original source currency/minor units for auditability;
- use one exchange-rate snapshot consistently within a rendered listing.

Sold items should leave the active listing panel after being sold for one minute. This should not destroy required lifecycle history or notification audit records.

The LZT view should contain only LZT controls/data, not the general product tracker’s search configuration.

## 14. Haze notifications

The notification delivery direction changed several times. The final decision was:

- do not use a separate general Discord bot;
- use the existing Haze account worker integrated with FGP;
- FGP owns detection and a durable alert queue;
- `fgp-haze-notifier.service` sends messages;
- token/channel configuration is server-side only;
- a manual message button queues a Haze message without any LZT API request.

Notification rules requested at handoff time:

- notify for accounts at or below USD 5.00;
- also notify for accounts with at least 2,000 Rust hours at or below USD 6.00.

The test control allows custom:

- maximum amount/price;
- minimum games;
- minimum Rust hours.

Desired message structure was based on:

```text
RUST <hours> hours <items> items <kills> Kills <deaths> Deaths
$<usd> / €<eur> • LZT <listing id>
Rust: <hours in Rust>
Rust: <inventory value + DLC packs>
View listing
```

The final visual direction is a compact, clean, centered Haze-style card using the committed pixel font. It should show only account information—not market navigation tabs—and load games, Rust hours, and inventory accurately.

Haze delivery previously failed with “An invalid token was provided.” The token itself later passed the Discord `/users/@me` check and the service logged `FGP Haze notifier connected.` The lesson is to distinguish token validation, environment formatting, service restart, queue creation, and delivery outcome. A service being `active` or `connected` does not prove that a queued message was delivered; inspect the durable alert record and logs.

No token value belongs in this handoff. Rotate any credential ever pasted in chat.

## 15. Ranks and member sidebar

A Discord-like member list/rank system was requested and implemented:

- rank groups with name, colour, and position;
- user-to-rank assignments;
- permissions array;
- built-in managed ranks;
- right-side member directory/sidebar;
- LZT access controlled through a rank permission;
- administrative rank CRUD and assignment endpoints.

The original request included an inappropriate custom rank name. The shipped/desired safe product terminology is `LZT Access`. Do not reintroduce derogatory naming.

## 16. Important API groups

The server currently exposes authenticated routes for:

- health and initial setup;
- login/logout/current user;
- extension pair/heartbeat/start/stop;
- SSE events;
- Brave status/current search/start;
- scanner import/start/stop/reset/retry/result detail/failure export;
- Discord invite reconciliation and progress;
- Rust price search/import/start/stop/reset/delete/retry/rescan/export/debug;
- LZT snapshot/start/stop/restart/test/test alert/manual Haze/retry/recalculate/admin health;
- Leads list/detail/create/patch/delete/bulk/assignment/exports;
- notifications and tags;
- location checks;
- account/password settings;
- workspace and Scanner ID rotation;
- members/ranks/users/extensions/scanners/audit/backups.

Do not make protected endpoints anonymously accessible merely to support a `.bat` client. External scripts should authenticate through a supported session/token flow, or a narrowly scoped API credential feature should be designed explicitly with least privilege.

## 17. Data model overview

The Prisma schema contains major models for:

- workspaces, users, ranks, user-rank assignments, sessions, and rate limits;
- extension instances;
- search sessions/results;
- domains, Discord links, hosting locations;
- leads, tags, activities, and notifications;
- scanner state/results/sources/Discord links/failure history;
- general Rust/product scan state, sources, diagnostics, listings, and snapshots;
- LZT tracker state, listings, Haze alerts, manual messages, and market averages;
- settings, audit logs, and backup metadata.

Migrations are chronological and data-preserving. Do not edit an already-applied migration to change production behavior. Add a new migration or use a deliberate compatibility helper when SQLite type limitations require it.

## 18. Secrets and credential hygiene

Historical chat contained sensitive values, including:

- LZT API bearer token;
- Brave API keys;
- Discord user token;
- VPS password prompts and server details.

This handoff intentionally contains no secret values. The next operator/agent should:

1. Rotate every token that was pasted into chat.
2. Update only `/etc/fgp/fgp.env` using a private interactive session.
3. Avoid shell commands that echo the secret.
4. Restart only affected services.
5. Validate using non-secret status/health output.
6. Confirm logs do not contain credentials.
7. Never commit `.env`, database, backup, or output logs.

Git ignore and release builder rules already reject most sensitive runtime files. Keep the offline security scan in every release workflow.

## 19. Known remaining work and recommended order

### Immediate

1. Run a small controlled Searcher job and confirm progress persists after refresh.
2. Confirm a healthy home page with failed speculative paths is not falsely marked Timeout/Blocked.
3. Confirm Telegram/email recovery synchronizes to Leads.
4. Confirm automatic retry counters and failure history behave as intended.
5. Add a local mutual-exclusion guard to the deployment launcher so two windows cannot rebuild/upload the shared archive concurrently.

### Production measurement

The scanner reliability release is strongly covered by controlled tests, but third-party website behavior changes constantly. Run a bounded production sample and compare before/after:

- valid contact rate;
- false fallback success rate;
- timeout rate;
- block rate;
- worker error rate;
- median/p95 duration;
- retry recovery rate;
- number of domains removed after five contact failures.

Do not promise that all third-party sites can be scraped. Separate genuine access controls from implementation defects.

### Credentials

Rotate and privately reconfigure historically exposed Brave/LZT/Discord credentials. Verify only status codes and service outcomes, not token contents.

### Tooling

Install Node 22+ normally on Windows or keep the recovery wrapper documented. Confirm OpenCode can run the required full verification suite.

### Cleanup

Review untracked root patchers and staging folders individually. Preserve anything still useful in a clearly named `tools/` or documentation location; delete only with explicit understanding. Never bulk-commit them through the deployment workflow.

## 20. Suggested first OpenCode prompt

Use this after opening the repository in OpenCode:

```text
Read AGENTS.md and OPENCODE-HANDOFF.md completely. Inspect git status and confirm origin/main. Do not expose or reuse any secrets mentioned in historical material. Confirm the recorded production deployment evidence is still healthy, then run a small controlled Searcher smoke test focused on persisted progress, contact recovery, retry classification, and Leads synchronization. Report the exact GitHub HEAD, measured production outcomes, and any remaining blocker.
```

## 21. Final context for the next agent

The operator is ambitious and prefers rapid iteration. Many features were built through repeated screenshot-driven adjustments and production troubleshooting. The codebase now has substantially better automated coverage and safer deployment than it did initially. Preserve that progress.

The most important behavioral principle is evidence: accurate scanner classifications, persisted progress, inspectable diagnostics, explicit retry policy, honest third-party blocks, tested builds, exact Git state, and verified deployment. A polished dashboard is valuable, but it must reflect real server state.
