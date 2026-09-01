# FGP Agent Instructions

This repository is **FGP / Forhuds Panel**, a production lead-research and market-tracking platform hosted at `https://forhud.shop`. These instructions are mandatory for OpenCode and any other coding agent working in this repository.

Read `OPENCODE-HANDOFF.md` before substantial work. It contains the current release state, architectural context, historical decisions, operational constraints, and unfinished priorities. Treat the repository as the source of truth whenever the handoff and code differ.

## Primary objective

Keep FGP reliable, secure, responsive, and easy for a non-technical operator to use. The highest-priority product areas are:

1. The Brave-powered business Searcher.
2. The persistent website/contact scanner.
3. Discord, Telegram, and email contact extraction.
4. Leads synchronization and the Leads Kanban board.
5. The general product-price scanner.
6. The rank-gated LZT Market Rust tracker and Haze notifications.
7. Safe, recoverable production deployment.

Do not optimize only for a happy-path demo. Preserve persistence across refreshes/restarts, accurate progress, bounded retries, clear failure reasons, exports, workspace isolation, and safe recovery.

## Communication and operator expectations

- The operator prefers plain, direct language and visible outcomes over implementation jargon.
- When asked to change or fix something, implement it, verify it, and report the exact result.
- Do not claim something is deployed, live, fixed, or tested without evidence.
- Distinguish among `committed locally`, `pushed to GitHub`, `deployed to VPS`, and `verified publicly`.
- Avoid repeated permission or clarification questions when the answer can be safely inferred from the repository. Never treat this preference as authority to bypass platform security, expose secrets, force-push, delete data, or circumvent third-party access controls.
- The UI should remain dark, compact, sleek, consistent, and visually blended. Avoid bright native-looking controls that clash with the panel.
- The user strongly values speed, but correctness, security, and useful diagnostics must not be traded away for superficial throughput.

## Security and legal boundaries

- Never commit or print passwords, API tokens, session cookies, Discord credentials, SSH credentials, database files, production environment files, or private backups.
- Secrets belong only in local ignored `.env` files or `/etc/fgp/fgp.env` on the VPS.
- Several credentials were pasted into the historical chat. Treat every historically shared Brave, LZT, or Discord token as compromised until rotated. Never copy historical values into documentation or code.
- Never disable authentication in production. A temporary authentication bypass existed historically but is not the desired state.
- Preserve HttpOnly/Secure/SameSite cookie sessions, role checks, workspace isolation, rank checks, persistent rate limiting, initial-setup protection, and password guess-resistance checks.
- Password policy intentionally has no fixed minimum length. Do not replace it with a simplistic length rule. It must reject common passwords and predictable transformations such as leetspeak, case changes, years, and suffixes while allowing genuinely strong passphrases or random credentials.
- Preserve SSRF protection at every redirect and crawl boundary. DNS validation and curl/browser pinning are defense-in-depth controls, not optional performance features.
- Do not add proxy rotation, CAPTCHA solving, stealth/fingerprint evasion, authentication bypasses, rate-limit circumvention, or anti-bot bypass logic.
- A third-party block, CAPTCHA, login wall, or human-verification challenge must be recorded honestly and retried only within conservative policy. It cannot be reported as a successful extraction.
- Respect robots policy and same-domain crawl boundaries. External social/profile pages may only be followed through the explicitly bounded recovery logic.
- Review Discord and other third-party terms before expanding automation. The Haze worker uses an operator-provided account credential and must never log or expose it.

## Repository layout

- `apps/dashboard` — React/Vite dashboard and all operator-facing pages.
- `apps/server` — Express/TypeScript API, authentication, persistence, scanner orchestration, Brave search, market scanners, SSE, exports, backups, ranks, and notifications.
- `apps/scraper` — loopback-only Python/Scrapling service for static fetching, selective dynamic rendering, and deterministic extraction.
- `apps/server/prisma` — SQLite schema and ordered migrations.
- `apps/extension` — Chrome Manifest V3 extension that imports organic URLs from a Google results page manually opened by the user.
- `packages/shared` — shared validation, URL normalization, Discord normalization, CSV, and splitter utilities.
- `deploy` — Caddy and systemd definitions plus the generated ignored release archive.
- `scripts/build-release.mjs` — audited allowlist-based release builder.
- `deploy-release.ps1` — GitHub publication, upload, backup, migration, rollout, health check, and rollback workflow.
- `DEPLOY-FGP.cmd` — normal interactive Windows deployment launcher.

## Architecture invariants

- Node is the scanner source of truth. It owns queues, persistence, retries, recovery, stop/resume, progress, concurrency, URL policy, and lead synchronization.
- Python is a private worker, not a public API. Production binds it to loopback and protects it with a unique token.
- Every workspace-owned database record must remain isolated by `workspaceId`.
- Search and scanner progress must survive browser refreshes and application restarts.
- The same canonical business domain must not create duplicate scanner entries or duplicate Leads.
- A scanner result may enrich an existing Lead but must not overwrite operator-entered fields with empty or lower-quality data.
- Discord invite deduplication must use normalized destinations and, when available, resolved Discord server identity—not merely the invite string.
- Telegram-only and email-only contacts are valid fallbacks. If both Discord and Telegram are present, preserve both.
- `DISCORD_NOT_FOUND` is a valid completed extraction outcome, not a transport failure. Timeouts, blocks, worker failures, HTTP failures, and contact-not-found must remain separately classified.
- After five failed contact-extraction attempts, a website may leave the active retry set, but its full failure history must remain exportable.
- Automatic retries are only for transient classes and must use bounded exponential backoff. Permanent blocks and policy failures must not loop forever.
- Stop actions must interrupt queued retry waits promptly.

## Searcher and scanner requirements

- The selected target is a count of unique business domains, not raw Brave results.
- The Searcher should continue pagination/query variations until it reaches the requested target, exhausts its safe request budget, or Brave has no new business domains.
- Default production settings currently expect `BRAVE_MAX_REQUESTS=300`, `BRAVE_SEARCH_CONCURRENCY=3`, a positive result cache, and a configured maximum target large enough for 500-result searches.
- Filter social platforms, marketplaces, directories, review sites, search engines, gaming stores, and link hubs before consuming scanner capacity unless explicitly allowlisted.
- Normalize `www`, scheme, path, query, and known prefix/suffix variants into the canonical domain key where appropriate.
- The progress bar and current-search statistics must come from persisted server state and remain accurate after reload.
- Keep small, subtle metrics: percent complete, queued, active, completed, valid contacts, failed, timeout, blocked, throughput, concurrency, median/p95 latency, and retry activity.
- The Discord checker is a persisted background reconciliation job with its own progress. It must group duplicate invite destinations, respect Discord rate limits, and expose useful outcomes.
- Leads URLs and contact URLs in the Kanban must remain clickable.
- Drag-and-drop should feel immediate while still persisting and rolling back visibly on server failure.

## Failure handling expectations

- Preserve original and fallback HTTP statuses, every attempted page, elapsed time, extraction methods, worker codes, retry-after values, and final classification.
- Do not label a result `Completed with fallback` unless a requested valid contact was actually extracted. A recovered page with no Discord/Telegram/email is not a contact success.
- Classify remote DNS, TLS, timeout, connection, 408/425/429, and 5xx conditions before generic local-worker errors.
- Preserve `Retry-After` from the worker/API and use it when scheduling a retry.
- Reduce adaptive concurrency immediately when the local worker is busy/offline or the remote service is applying pressure; recover concurrency gradually after healthy work.
- A healthy homepage must not be converted into a domain-level Timeout or Blocked result merely because speculative `/discord`, `/community`, or `/contact` paths fail.
- Successful recovery pages must contribute Telegram and email contacts as well as Discord contacts.
- Safe positive DNS caching and in-flight lookup deduplication are allowed; private-address validation must still be enforced.

## General product-price scanner

- Product scopes are isolated. Supported operator choices include Rust NFA, game accounts, and arbitrary other items.
- Sources, listings, deletion, exports, debug data, search terms, and statistics must remain scoped to the selected product.
- Price sorting must work by clicking the Price header and through the visible sort control.
- Support display conversion among DKK, EUR, USD, and RUB without mutating stored source values.
- Show aggregate market statistics and category statistics only when a category has at least three comparable results.
- Provide an explicit delete-all-results action with a destructive confirmation.
- Every scan, passed or failed, must have exportable debug information.
- Duplicate source sites must be canonicalized across prefix/suffix and hostname variations.

## LZT tracker requirements

- LZT is a separate subview under the product scanner; do not mix general tracker controls into the LZT view.
- Access is controlled through the built-in `LZT Access` rank/permission.
- `LZT_API_TOKEN` is optional. Token mode uses the official Market API. Public mode must poll no faster than once per minute and must never bypass login, CAPTCHA, or human verification.
- Track newest Rust listings, sold status, price, games, Rust hours, kills/deaths where available, inventory items, Rust inventory value, CS2 inventory value, total inventory value, DLC, and source timestamps.
- Currency conversion must apply consistently to listing price and every inventory subtotal/total shown in the hover panel.
- Sold listings should be removed from the active panel after they have remained sold for one minute while lifecycle history remains in persistence as designed.
- LZT listing sorting must include price.
- Notification rules currently requested are:
  - standard alert at or below USD 5.00;
  - high-hours alert for at least 2,000 Rust hours at or below USD 6.00.
- Test alerts accept custom maximum price, minimum games, and minimum Rust hours.
- The manual Haze message action must queue a message without making an LZT API request.
- Haze notifications are sent by the existing `fgp-haze-notifier.service`; do not introduce a separate Discord bot unless the operator explicitly reverses that decision.
- Baseline imports must not generate notification spam. Failed deliveries use a durable queue and bounded retry/backoff.

## Authentication and ranks

- Login is required in production.
- Initial production setup requires a one-time `INITIAL_SETUP_TOKEN` when no administrator exists.
- Usernames are normalized and validated server-side.
- Passwords are salted `scrypt` hashes. Never expose or attempt to recover a user's current password; use an administrative reset flow.
- Persistent account/IP rate limits use SQLite-safe atomic writes. Do not reintroduce competing parallel interactive transactions; this previously caused Prisma P1008 login timeouts.
- Workspace ranks mirror Discord-style grouping/colour/position behavior. The member sidebar and rank management must remain consistent with server permissions.
- Scanner ID rotation revokes paired extension tokens and requires reconnection.

## Local tooling

Preferred requirements:

- Node.js 22+
- pnpm compatible with the checked-in lockfile
- Python 3.10–3.13
- Chrome/Chromium for dynamic Scrapling tests
- Git and GitHub CLI

On the recovered Windows workstation, Node may not be on the ordinary shell `PATH`. The current fallback wrapper is:

```text
C:\Users\Mohammad\Documents\Codex\recovery-installers\Run-With-FgpTools.cmd
```

Use it as a prefix when necessary, for example:

```text
C:\Users\Mohammad\Documents\Codex\recovery-installers\Run-With-FgpTools.cmd pnpm run test
```

Do not bake this workstation-specific path into production application code. The deployment launcher may use it only as a local fallback when Node is otherwise unavailable.

## Required verification

Before committing a substantial change or deploying, run the checks relevant to the change. Before a production release, run all of them:

```text
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run security:scan
pnpm run release:build
```

Current validated baseline from 2026-09-01:

- 24 JavaScript/TypeScript test files passed.
- 252 JavaScript/TypeScript tests passed.
- 42 Python/Scrapling tests passed.
- Lint passed with zero warnings.
- Type checking passed for every workspace.
- Production build passed.
- Offline security scan passed.
- Release archive inspection passed with 233 entries.

If a test fails because the sandbox cannot read the restored Node/esbuild runtime, rerun it with the required filesystem permission instead of weakening or deleting the test.

## Git rules

- Primary repository: `https://github.com/MqWaree/Forhud`.
- Primary branch: `main`.
- Do not force-push `main`.
- Do not discard, reset, or overwrite unrelated user changes.
- Before deployment, fetch and confirm that `origin/main` is an ancestor of local `main`. Reconcile divergence explicitly.
- Deployment is configured to commit and push release-scoped changes before touching the VPS.
- The deployment allowlist intentionally excludes local patch probes, temporary staging folders, diagnostic experiments, environment files, databases, logs, and archives.
- Use descriptive commits. Keep a release commit recoverable even if production rollout fails.

## Deployment rules

Production details:

- Site: `https://forhud.shop`
- VPS: Ubuntu at `162.35.162.136`
- Application: `/opt/fgp`
- Environment: `/etc/fgp/fgp.env`
- Database: `/var/lib/fgp/lead-intelligence.db`
- Backups: `/var/backups/fgp`
- Services: `fgp-api.service`, `fgp-scraper.service`, and `fgp-haze-notifier.service`
- Reverse proxy/static hosting: Caddy

Normal Windows deployment:

```text
DEPLOY-FGP.cmd
```

The launcher builds a fresh audited archive. `deploy-release.ps1` then:

1. Fetches the corresponding GitHub branch.
2. Refuses behind/diverged history.
3. Stages only release/operational allowlisted paths.
4. Commits changes if necessary.
5. Pushes the exact source to GitHub.
6. Hashes and uploads the release archive.
7. Verifies the archive and lockfile on the VPS before downtime.
8. Backs up the SQLite database.
9. Moves the previous release to a timestamped rollback directory.
10. Installs dependencies, generates Prisma, updates schema, and builds.
11. Installs/reloads systemd and Caddy configuration.
12. Starts services and verifies loopback plus public health.
13. Restores the previous release automatically if rollout health fails.

The VPS root password is entered interactively and must never be stored in the repository or handoff.

After every deployment, verify:

- the deployment log ends with `FGP_DEPLOYMENT_OK`;
- `/api/health` reports database connected and Scrapling healthy;
- all required systemd services are active;
- the public dashboard loads;
- the changed workflow passes a production smoke test;
- GitHub `main` contains the deployed source commit.

## Current release state

At the time this file was created:

- GitHub `main` contains application release commit `7ecf02d` plus the later OpenCode handoff documentation. Resolve the current remote HEAD instead of assuming a documentation commit hash.
- Application commit `7ecf02d` merges the recovered feature release and the previous GitHub security/login fixes.
- The newest successful deployment log available locally is `outputs/deploy-release-20260901-035242.log`, ending in `FGP_DEPLOYMENT_OK` with healthy loopback/public responses.
- That log predates the final application-release validation/push. Therefore **do not assume the application changes in `7ecf02d` are live until current `main` is deployed successfully and verified**.
- The working tree contains several untracked one-off patch/diagnostic helpers. They are intentionally not part of the release and must not be bulk-added without individual review.

## Definition of done

A task is done only when:

1. The requested behavior exists in the correct layer.
2. Failure states and persistence are handled.
3. Tests cover the regression or important new logic.
4. Relevant verification passes.
5. No secrets or runtime data are staged.
6. Git state is understood and reported accurately.
7. If deployment was requested, GitHub push, VPS rollout, health checks, and a public smoke test all succeed.
