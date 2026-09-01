# FGP — Failed, Partial, Superseded, and No-Result Attempt Ledger

Last rebuilt: 2026-09-02 (Europe/Paris)

Audience: DeepSeek V4 Pro in OpenCode and future FGP maintainers.

Purpose: preserve the approaches already tried during the long FGP development and recovery process, especially optimizations and bug fixes that failed, produced no useful result, introduced a regression, were only partially effective, or were later superseded.

This prevents a new agent from confidently repeating an old dead end.

## 1. How to interpret this ledger

Each entry is one of:

- **Failed** — the attempt produced a concrete error or did not achieve its goal.
- **No useful result** — the action ran but did not produce the required product outcome.
- **Partial** — it improved one layer but left the user-visible problem unresolved.
- **Regressed** — it solved one symptom while creating a correctness, security, or reliability problem.
- **Superseded** — a later design replaced the approach.
- **Abandoned by design** — the approach conflicts with security, legality, provider policy, or the final product architecture.
- **Needs production proof** — code/tests exist, but real-world behavior was not measured strongly enough to call it solved.

Evidence levels:

- **Recorded** — supported by repository history, logs, screenshots, or committed code.
- **Operator-reported** — repeatedly reported in the historical conversation, but the exact temporary implementation may not be committed.
- **Inferred** — the repository state strongly suggests the sequence, but the original one-off artifact is incomplete.

Do not turn operator-reported history into a stronger factual claim without checking current source and logs.

When an entry is conclusively resolved, do not delete it. Add the resolution date, commit, production log, and measured outcome.

## 2. Quick index of approaches not to repeat blindly

Do not repeat these as a first response to the associated problem:

1. Do not disable login to fix authentication.
2. Do not replace password quality with a fixed length or a character-pool entropy formula.
3. Do not attempt to retrieve a current password from a scrypt hash.
4. Do not raise scanner concurrency alone to solve slow scanning.
5. Do not render every page in Chromium.
6. Do not let guessed fallback-path failures overwrite a healthy homepage result.
7. Do not mark `Completed with fallback` unless a requested contact was found.
8. Do not retry permanent blocks forever.
9. Do not count raw Brave rows as unique businesses.
10. Do not keep requesting Brave pages after safe provider exhaustion merely to display the requested number.
11. Do not deduplicate Discord invites only by invite URL.
12. Do not run Discord reconciliation as one long synchronous request.
13. Do not treat an active/connected Haze service as proof of message delivery.
14. Do not expose an authenticated API route publicly to make a batch script easier.
15. Do not scrape LZT faster to cure LZT 503/timeouts.
16. Do not label RUB inventory values as USD/EUR/DKK.
17. Do not run two deployment windows concurrently.
18. Do not rebuild a release from the entire workspace.
19. Do not bulk-stage historical root patch scripts.
20. Do not weaken tests because the recovered Windows runtime is awkward.

## 3. Authentication and password-policy attempts

### 3.1 Temporarily removing the login system

- Status: **Regressed; abandoned by design**
- Evidence: **Recorded in product history and operator requests**
- Goal: restore access while login was broken.
- Attempt: temporarily bypass or remove authentication so the panel could be used.
- Result: anyone could view and modify everything, including users and settings.
- Why it failed: it converted a login bug into full unauthenticated production compromise.
- Current rule: login remains required. Fix login in the authentication/database/session layer.
- Do not repeat: never introduce a production authentication bypass, even temporarily.

### 3.2 Removing the fixed password minimum without a robust replacement

- Status: **Regressed; superseded**
- Evidence: **Recorded security finding**
- Goal: allow strong short random passwords and long passphrases without a rigid minimum.
- Attempt: replace minimum length with a bespoke character-pool/estimated-bit formula and a short common-password pattern.
- Result: obvious transformed passwords such as `P@ssw0rd!` were accepted.
- Why it failed: character pools measure possible alphabets, not human predictability. The common-password check missed leetspeak transformations.
- Current design: no fixed minimum, but a shared guess-resistance policy rejects common/predictable transformations across every password-setting path.
- Do not repeat: do not use Shannon-style pool math as the primary password-strength control.

### 3.3 Removing the visible validation message only

- Status: **No useful security result**
- Evidence: **Operator-reported**
- Goal: eliminate the UI response `Choose a less predictable password`.
- Attempt: focus on removing/suppressing the error text.
- Result: changing the message alone does not change the underlying password policy and can hide a useful reason from the user.
- Correct approach: return a clean, user-facing validation message while keeping the secure shared policy.
- Do not repeat: do not confuse presentation cleanup with policy correction.

### 3.4 Attempting to learn the existing dashboard password

- Status: **Impossible by design**
- Evidence: **Recorded architecture**
- Goal: determine the current password for an existing user.
- Result: the database stores salted scrypt hashes, not reversible passwords.
- Correct approach: use an authorized reset flow.
- Do not repeat: do not query, print, export, or crack the password hash.

### 3.5 Parallel SQLite login-counter transactions

- Status: **Failed in production; fixed by later commit**
- Evidence: **Recorded; commit `ef9b089`**
- Goal: update persistent account and IP rate-limit counters efficiently.
- Attempt: competing parallel interactive transactions on SQLite.
- Result: Prisma P1008 timeouts and broken login behavior.
- Why it failed: SQLite permits one writer; concurrent transactions contended for the write lock.
- Resolution: short atomic UPSERTs executed sequentially.
- Do not repeat: do not parallelize interactive SQLite writes in authentication paths.

## 4. Brave Searcher attempts and optimization dead ends

### 4.1 Treating the requested count as raw provider results

- Status: **No useful result; superseded**
- Evidence: **Repeated operator reports**
- Goal: return 250 or 500 business websites.
- Attempt: rely on raw Brave result counts or a small number of result pages.
- Result: the panel returned figures such as 74, 106, or 40 of 100.
- Why it failed:
  - provider pages contain duplicates;
  - excluded social/platform/directory results are not businesses;
  - multiple URLs can map to one canonical domain;
  - one API call returns only a bounded number of rows;
  - provider exhaustion can occur before the requested unique-domain count.
- Current design: target unique qualifying business domains, paginate and vary business-intent queries within a safe request budget.
- Do not repeat: do not display raw search rows as the completed business target.

### 4.2 One query/page strategy for large targets

- Status: **Failed to reach target; superseded**
- Evidence: **Operator-reported**
- Goal: satisfy 500-result searches.
- Attempt: use one query formulation and too few pages.
- Result: discovery exhausted early with far fewer unique sites.
- Correct approach: safe pagination, closely related query variations, canonical deduplication, and honest provider-exhaustion reporting.

### 4.3 Continuing indefinitely until the requested target

- Status: **Abandoned by design**
- Evidence: **Product requirement evolution**
- Goal: never stop until the UI target is reached.
- Problem: if Brave has no new domains, continuing wastes tokens and can loop through duplicate/excluded results.
- Current design: stop at target, safe request-budget exhaustion, or no-new-domain provider exhaustion.
- Do not repeat: do not trade unlimited API usage for a cosmetic completion number.

### 4.4 Raising Brave/scanner concurrency as the only speed optimization

- Status: **Partial; can regress reliability**
- Evidence: **Repeated operator reports and adaptive-concurrency work**
- Goal: make Searcher/scanner drastically faster.
- Attempt: increase concurrency aggressively.
- Result: throughput did not improve proportionally; timeout, 429, 5xx, worker pressure, and crashes increased.
- Why it failed: bottlenecks included provider limits, dynamic browser capacity, remote servers, DNS, SQLite persistence, and duplicate work—not only worker count.
- Current approach:
  - bounded Brave concurrency;
  - static/dynamic tiers;
  - adaptive scanner concurrency;
  - positive caching;
  - in-flight deduplication;
  - canonical-domain filtering before scanning;
  - latency/pressure metrics.
- Do not repeat: benchmark the actual bottleneck before changing concurrency.

### 4.5 Brave key replacement helper failing with `base64: invalid input`

- Status: **Failed operational helper; later replaced/retried**
- Evidence: **Recorded screenshot/history**
- Goal: update the production Brave API key privately.
- Attempt: pass an encoded value through a Windows-to-SSH helper.
- Result: `base64: invalid input`; server update or verification failed.
- Likely causes: quoting/encoding/newline handling across Windows, shell, and SSH boundaries.
- Correct approach: private interactive entry, no echoed value, server-side status verification, sanitized logs.
- Do not repeat: do not shuttle secrets through fragile multi-shell quoting or print them for diagnosis.

### 4.6 Repeated API key changes without end-to-end provider validation

- Status: **Partial/no useful result**
- Evidence: **Operator-reported**
- Goal: cure Searcher errors by swapping keys.
- Result: a new value alone did not prove the server loaded it, the service restarted, the plan/quota was valid, or Brave returned usable results.
- Correct verification sequence:
  1. privately update environment;
  2. restart only the API;
  3. verify service state;
  4. call the provider status path;
  5. run a small search;
  6. inspect sanitized provider status/quota/error output.

## 5. Website/contact scanner attempts and performance dead ends

### 5.1 Rendering every site/page dynamically

- Status: **Too slow and unstable; superseded**
- Evidence: **Architecture and repeated speed/crash reports**
- Goal: improve JavaScript-heavy contact extraction.
- Attempt: rely broadly on browser rendering.
- Result: scan speed became worse than manual checking, Chromium capacity became the bottleneck, and load increased crash/timeout risk.
- Current design: static-first fetching; render only unresolved JS shells and selected recovery pages; separately cap dynamic concurrency.
- Do not repeat: do not make Chromium the default path.

### 5.2 Increasing scanner concurrency without separating dynamic work

- Status: **Regressed under load; superseded**
- Evidence: **Operator reports: crash under load, slow scans, timeout/blocked counts**
- Goal: scan many sites at once.
- Result: expensive rendered jobs could starve ordinary sites, worker timeouts accumulated, and remote pressure increased.
- Current design: broad static concurrency, independently bounded dynamic concurrency, adaptive pressure response.

### 5.3 Letting speculative path failures override a useful homepage

- Status: **Classification bug; fixed in reliability release**
- Evidence: **Recorded handoff and tests**
- Goal: find contacts on `/discord`, `/community`, `/contact`, and similar paths.
- Attempt: add guessed recovery pages, then fold their failures into the domain result.
- Result: a healthy homepage could be reported as Timeout or Blocked because a speculative child path failed.
- Resolution: track useful/original outcome separately from speculative recovery outcomes.
- Regression test expectation: a healthy homepage stays healthy when guessed child paths fail.

### 5.4 Reporting `Completed with fallback` without a contact

- Status: **False positive; corrected by requirements/code**
- Evidence: **Operator-reported and recorded invariant**
- Goal: show that recovery fetched a page.
- Attempt: mark fallback page retrieval as completed success.
- Result: results appeared valid even when no Discord link was extracted.
- Current rule: no contact means no contact. A loaded fallback page is not a contact success.
- Do not repeat: tie valid success to requested contact extraction.

### 5.5 Discord-only lead qualification

- Status: **Incomplete; superseded**
- Evidence: **Operator requirement evolution**
- Goal: keep the Leads page high quality.
- Attempt: add only sites with Discord.
- Result: valid Telegram contacts were dropped; email fallback was unavailable when both social channels failed.
- Current rule: Discord or Telegram is valid; preserve both; email is fallback if both are absent.

### 5.6 Retry-all without transient/permanent classification

- Status: **Wasteful and potentially looping; superseded**
- Evidence: **Persistent retry design and operator failure reports**
- Goal: recover failed extraction.
- Attempt: retry failures generically.
- Result: permanent blocks/no-contact/policy failures consumed time alongside recoverable DNS/timeout/429/5xx failures.
- Current design: retry transient classes only, bounded exponential backoff, preserve `Retry-After`, stop promptly, retire after the fifth extraction failure while retaining history.

### 5.7 Treating scraper worker errors as the root remote cause

- Status: **Misclassification; corrected**
- Evidence: **Recorded scanner reliability work**
- Goal: report fetch failures.
- Attempt: surface the worker's generic 5xx/error as the final category.
- Result: remote DNS, TLS, timeout, connection, 429, or 5xx causes were obscured.
- Current design: preserve structured worker codes and classify the original remote cause before the generic local wrapper error.

### 5.8 Browser refresh clearing progress

- Status: **Client-only state failed; superseded**
- Evidence: **Repeated operator report**
- Goal: show active scan progress.
- Attempt: progress derived only from the loaded dashboard session.
- Result: refreshing made progress disappear or look stuck even though work continued.
- Current design: persisted server state and SSE/polling rehydration.
- Do not repeat: do not make the browser the authoritative queue/progress owner.

### 5.9 Keeping failed websites forever in the active retry set

- Status: **Operational clutter; superseded**
- Evidence: **Operator request**
- Goal: avoid losing possible leads.
- Result: repeatedly failed sites accumulated and consumed attention/work.
- Current design: after five failed contact-extraction attempts, remove from active work while preserving full downloadable failure history.

### 5.10 Trying to scrape every blocked site

- Status: **Abandoned by design**
- Evidence: **Security and legal boundaries**
- Goal: reduce Blocked counts to zero.
- Problem: some sites deliberately require login, CAPTCHA, human verification, or deny automated access.
- Current approach: bounded retries only for transient conditions; record permanent access controls honestly.
- Do not repeat: no proxy rotation, CAPTCHA solving, stealth, fingerprint evasion, or access-control bypass.

### 5.11 Speed improvements with no controlled baseline

- Status: **No reliable conclusion**
- Evidence: **Many repeated “make it faster” requests and live-site audit artifacts**
- Goal: drastically improve scan speed.
- Problem: changing concurrency/timeouts/extraction together against changing third-party sites made before/after comparisons unreliable.
- Correct approach:
  - controlled fixture set;
  - fixed known-positive/no-contact/retry samples;
  - record median/p95, throughput, contact rate, timeout, blocked, and worker pressure;
  - change one bottleneck at a time;
  - then run a bounded production sample.

## 6. Discord invite checker attempts

### 6.1 Deduplicating by invite string only

- Status: **Incomplete; superseded**
- Evidence: **Operator request and migration `20260901030000_discord_invite_identity`**
- Goal: remove duplicate Discord results.
- Attempt: normalize invite URLs/codes.
- Result: different invite codes for the same Discord server still appeared as different destinations.
- Current design: use resolved Discord server identity when available, with normalized invite fallback.

### 6.2 One long synchronous reconciliation request

- Status: **Timed out/appeared broken; superseded**
- Evidence: **Operator-reported checker errors and persisted job requirement**
- Goal: recheck all Discord links from one button.
- Result: long requests were vulnerable to browser/server timeouts, rate limits, refresh loss, and poor progress visibility.
- Current design: persisted background reconciliation job with separate progress and SSE/API state.

### 6.3 Rechecking without 429-aware scheduling

- Status: **Regressed provider pressure; superseded**
- Evidence: **Operator-reported HTTP 429 and discovery errors**
- Goal: process invites faster.
- Result: Discord returned 429; retries could amplify the rate limit.
- Current design: group duplicate destinations, use bounded concurrency, preserve/honor `Retry-After`, continue safely.

### 6.4 Treating 403, 429, 5xx, timeout, and invalid invite as one failure

- Status: **Insufficient diagnostics; corrected by design/tests**
- Result: the checker could not determine which outcomes were retryable or permanent.
- Current requirement: classify each outcome separately and expose useful progress/result counts.

## 7. Leads and Kanban attempts

### 7.1 Waiting for the server before moving a card visually

- Status: **Felt unresponsive; superseded by optimistic UX requirement**
- Evidence: **Operator-reported**
- Goal: persist Kanban moves safely.
- Result: drag/drop felt delayed and rough.
- Current approach: update immediately, persist in background, visibly roll back if the server rejects the change.

### 7.2 Adding only Discord-qualified leads

- Status: **Superseded**
- Evidence: **Requirement changed later**
- Result: Telegram-only and email-only opportunities were lost.
- Current approach: Discord or Telegram is a valid social contact; email is fallback.

### 7.3 Exporting full metadata when only links were requested

- Status: **Wrong output shape; superseded**
- Evidence: **Operator-reported**
- Goal: download Discord destinations for use elsewhere.
- Result: CSV/metadata was unwanted.
- Current requirement: the simple Discord export contains only normalized links.

## 8. General product-price scanner attempts

### 8.1 Hard-coding the scanner to Rust NFA only

- Status: **Superseded**
- Evidence: **Requirement evolution**
- Goal: scan Rust account prices.
- Result: could not support other game accounts/items.
- Current design: isolated product scopes for Rust NFA, game accounts, and arbitrary other items.

### 8.2 Counting hostname/path variants as separate providers

- Status: **Duplicate noise; superseded by canonicalization requirement**
- Evidence: **Operator-reported**
- Goal: maximize source count.
- Result: the same provider appeared multiple times through prefixes, suffixes, schemes, `www`, or paths.
- Current design: canonicalize source identity before statistics and capacity accounting.

### 8.3 Showing category statistics for tiny samples

- Status: **Misleading; superseded**
- Evidence: **Operator requirement**
- Result: one or two listings looked like meaningful market statistics.
- Current rule: show a category only with at least three comparable hits.

### 8.4 Non-exportable scan failures

- Status: **Blocked diagnosis; superseded**
- Evidence: **Operator reported all scans failed and requested exportable debugging**
- Result: failures could not be compared or fixed confidently.
- Current design: passed and failed scans expose debug JSON/CSV with source-specific evidence.

## 9. LZT Market tracker attempts and dead ends

### 9.1 Public tracking without a token when LZT required human verification

- Status: **Access challenge; cannot be “fixed” by bypass**
- Evidence: **Recorded screenshot**
- Goal: run without an LZT Market API token.
- Result: `ACCESS_CHALLENGE`; LZT required human verification.
- Correct behavior: record challenge and retry later at a respectful interval.
- Do not repeat: do not bypass login, CAPTCHA, or human verification.

### 9.2 Polling faster to cure stale listings

- Status: **Regressed reliability; superseded by backoff/reconciliation**
- Evidence: **Operator-reported HTTP 503 and category timeout**
- Goal: make newest listings update faster.
- Result: `LZT API returned HTTP 503` and `LZT category request timed out` persisted or worsened.
- Why it failed: upstream capacity/rate behavior cannot be solved by more pressure.
- Current approach: official API token mode, bounded polling, timeout classification, backoff, and separate reconciliation.

### 9.3 Requiring a requested EUR price unit and rejecting otherwise usable data

- Status: **Over-strict response handling; superseded**
- Evidence: **Recorded error `INVALID_RESPONSE`**
- Goal: ensure price display correctness.
- Attempt: require LZT to return the exact requested EUR unit.
- Result: the whole response failed when the provider returned a different source unit.
- Correct approach: validate the source unit, preserve it, and convert through the currency service.

### 9.4 Labeling RUB inventory total as the selected display currency

- Status: **Incorrect display; superseded by source-aware conversion**
- Evidence: **Operator-reported listing example**
- Goal: display inventory in USD/EUR/DKK.
- Result: an LZT RUB total appeared under another currency label without conversion.
- Correct approach: preserve source currency/minor units, convert every subtotal/total using one rate snapshot, and label accurately.

### 9.5 Assuming newest-listing UI staleness was only a frontend refresh problem

- Status: **Partial/no useful result**
- Evidence: **Repeated operator reports**
- Goal: auto-update newest listings.
- Problem: stale data could originate from upstream LZT errors, stopped polling, leader lease, service state, persistence, SSE, or frontend refresh.
- Correct diagnosis: trace source fetch -> tracker lease -> database write -> event -> dashboard rehydration.
- Do not repeat: do not add a client timer before confirming server ingestion.

### 9.6 Absurd multi-billion-millisecond detection time

- Status: **Metric type/normalization bug; later fixed**
- Evidence: **Recorded operator screenshot/history**
- Goal: show detection latency.
- Result: values such as `2762457784 ms` appeared.
- Likely causes: mixed timestamp units, old column width/type, or migration compatibility.
- Resolution direction: bigint-safe metric fields, normalized timestamps, compatibility helper, realistic independent latency measurements.
- Do not repeat: do not hide or clamp the number without fixing its units/source.

### 9.7 Treating sold listings as permanently active

- Status: **Lifecycle gap; superseded by reconciliation requirement**
- Evidence: **Operator request**
- Goal: keep active listings current.
- Result: sold accounts remained visible.
- Current rule: reconcile sold status and remove from active UI after one minute while preserving lifecycle history.

### 9.8 Mixing general-tracker controls into the LZT tab

- Status: **Rejected UX; superseded**
- Evidence: **Operator-reported**
- Goal: reuse controls.
- Result: the LZT panel contained irrelevant general-search UI.
- Current rule: separate subview and state.

## 10. Haze/Discord notification attempts

### 10.1 Building a separate Discord bot

- Status: **Superseded/explicitly rejected**
- Evidence: **Operator decision**
- Goal: notify Discord about LZT listings.
- Attempt: local `radar_stream.js`/bot-style scripts and layouts.
- Result: the operator chose integration with the existing Haze account instead of a separate bot.
- Current architecture: FGP durable queue + `fgp-haze-notifier.service`.
- Do not repeat: do not add another Discord bot unless the operator explicitly reverses the decision.

### 10.2 Running the local Haze script without Node installed

- Status: **Failed workstation setup**
- Evidence: **Recorded screenshot**
- Goal: test local notification posting.
- Result: `ERROR: Node.js is not installed.`
- Resolution: restore/install Node or use the recovered FGP tool wrapper.
- Lesson: verify the runtime before debugging application logic.

### 10.3 Treating `systemctl is-active` as proof notifications work

- Status: **False confidence; superseded by queue/delivery checks**
- Evidence: **Recorded service screenshots**
- Goal: confirm the bot was live updating.
- Result: service was `active`/`connected`, but messages were still not posted.
- Correct verification: inspect alert row, attempts, last error, next retry, service logs, and actual channel delivery.

### 10.4 Token succeeds at `/users/@me` but worker says invalid token

- Status: **Partial diagnosis; environment/service formatting issue remained**
- Evidence: **Recorded screenshots**
- Goal: validate Haze credential.
- Result:
  - direct Discord identity request returned HTTP 200;
  - worker still logged `An invalid token was provided` during some restarts;
  - later logs showed `FGP Haze notifier connected.`
- Likely causes: wrong environment entry, quoting/newline, duplicate variable, stale systemd environment, or service not restarted with the new value.
- Lesson: external credential validation and service environment loading are separate checks.
- Do not print the token while diagnosing.

### 10.5 Test-alert row exists but message is not posted

- Status: **Delivery path failure; later reported working**
- Evidence: **Recorded database output**
- Result: an alert row showed `FAILED`, multiple attempts, and `Unknown Haze delivery error` while the service process existed.
- Correct diagnosis: queue state -> worker lease -> credential/channel -> API response -> retry schedule -> actual delivery.
- Lesson: creating the database row is not equivalent to sending the message.

### 10.6 “Notify for every new account” testing mode

- Status: **Useful only as a bounded test; dangerous as a permanent rule**
- Evidence: **Operator request**
- Goal: prove end-to-end delivery.
- Risk: baseline imports or normal market volume can spam the channel.
- Correct use: bounded test window, baseline suppression, clear deduplication, then restore price/hour thresholds.

## 11. UI/layout attempts that did not become reliable product changes

### 11.1 Multiple one-off Haze card patchers

- Status: **Mixed/partial; many remain untracked**
- Evidence: **Current workspace**
- Examples:
  - `apply-graphical-card-update.*`
  - `apply-compact-sleek-card.cjs`
  - `apply-centered-smallest-pixel-card.cjs`
  - `apply-account-card-fix.cjs`
  - `polish-centered-card-dots.cjs`
  - `haze-card-staging/`
  - `haze-layout-staging/`
- Goal: repeatedly refine Discord/Haze card appearance.
- Result: some patchers had quoting/backtick/syntax repair scripts; staging variants are not automatically the shipped source of truth.
- Current rule: inspect committed `lzt-discord-card.ts`, its tests, and actual production output. Do not rerun patchers blindly.

### 11.2 Fixing appearance only in a local preview/staging folder

- Status: **No production result unless integrated**
- Evidence: **Untracked staging directories and historical requests**
- Goal: make cards smaller, cleaner, centered, and use a pixel font.
- Result: a preview can look correct while the FGP server renderer still emits the old card.
- Correct approach: integrate into source, test generated payload/layout, build, deploy, and send a controlled live test.

### 11.3 Native white inputs in a dark panel

- Status: **Rejected visual result; later styling direction established**
- Evidence: **Operator screenshot/request**
- Goal: add filters/test controls quickly.
- Result: default browser inputs/buttons did not blend with the dashboard.
- Current rule: use the shared compact dark control styles and test responsive layout.

### 11.4 Hover inventory box fixed visually but not semantically

- Status: **Partial**
- Evidence: **Operator reports**
- Goal: show inventory breakdown on hover.
- Result: tooltip existence/layout improved, but selected-currency conversion remained wrong.
- Lesson: visual completion does not prove data correctness.

## 12. API and external-script attempts

### 12.1 Making `/api/lzt-tracker` unauthenticated for a `.bat` script

- Status: **Rejected by security model**
- Evidence: **Operator question and handoff rule**
- Goal: let an external script call the tracker easily.
- Problem: making a protected endpoint public would expose production data/actions.
- Correct alternatives:
  - authenticate through a supported session flow; or
  - explicitly design a narrowly scoped, revocable API credential with least privilege.
- Do not repeat: convenience is not authority to remove authentication.

### 12.2 Automatic lead contacting before contact coverage was mature

- Status: **Not completed as a safe product workflow**
- Evidence: **Operator discussion**
- Goal: automatically contact leads.
- Limitation: email availability may be sparse; Discord/Telegram terms and messaging rules matter; automation needs consent, rate limits, templates, opt-out, auditing, and workspace controls.
- Current priority: reliable lead discovery/export first.
- Do not add unsolicited bulk messaging as an incidental scanner feature.

## 13. Deployment failures and operational dead ends

### 13.1 Git unavailable on PATH

- Status: **Failed environment setup; worked around**
- Evidence: **Recorded first deployment screenshot**
- Result: deployment tooling could not find Git.
- Resolution: restored bundled/local Git path and GitHub CLI setup.

### 13.2 Git `dubious ownership`

- Status: **Failed push until scoped safe-directory override**
- Evidence: **Recorded screenshot**
- Goal: push a recovered temporary repository.
- Result: Git refused because directory ownership differed.
- Correct handling: use a precise `safe.directory` entry for the exact repository, not a broad unsafe override.

### 13.3 Creating a pull request before pushing its head branch

- Status: **Failed order of operations**
- Evidence: **Recorded GitHub CLI output**
- Result: GraphQL reported blank head/base SHA and no commits between branches.
- Resolution: push the branch first, then create the PR.

### 13.4 Missing local output directory

- Status: **Deployment script failure; later fixed**
- Evidence: **Recorded screenshot**
- Result: `Tee-Object` could not create the deployment log because `outputs/` did not exist.
- Resolution: create the logging directory before starting the remote operation.

### 13.5 Windows CRLF breaking the Linux remote script

- Status: **Remote failure; later fixed**
- Evidence: **Recorded `set: pipefail` screenshot and commit `a1291d3`**
- Result: Bash received carriage returns and rejected `set -o pipefail`/options.
- Resolution: normalize/strip carriage returns from the generated remote script.
- Do not repeat: preserve line-ending normalization at the exact Windows-to-Linux boundary.

### 13.6 Frozen lockfile mismatch

- Status: **Deployment stopped/rolled back; later preflighted**
- Evidence: **Recorded screenshot and commit `ad0d449`**
- Result: pnpm refused install and instructed updating the lockfile.
- Resolution: keep source/lockfile consistent and validate the exact archive remotely before downtime.
- Do not bypass frozen-lockfile protection as a quick fix.

### 13.7 `Get-FileHash` unavailable

- Status: **Launcher failure; later fixed**
- Evidence: **Recorded screenshot**
- Result: PowerShell environment did not recognize `Get-FileHash`.
- Resolution: use .NET SHA-256 directly.

### 13.8 Immediate `127.0.0.1:3001` health checks

- Status: **False early failure risk; bounded retry later used**
- Evidence: **Recorded repeated curl connection refusals followed by success in later logs**
- Goal: verify API after restart.
- Result: the API was still starting/building and early checks failed.
- Correct approach: bounded readiness retries, then require healthy loopback/public responses.
- Do not ignore persistent refusal; only tolerate it when a bounded startup window ends successfully.

### 13.9 Overlapping deployment windows

- Status: **Checksum failure; current local mutex fix uncommitted**
- Evidence: **Recorded deployment evidence and dirty files**
- Goal: retry deployment quickly.
- Result: one window rebuilt the shared archive after another had hashed it, so the VPS rejected the checksum.
- Current local solution: named mutex in `invoke-fgp-deployment.ps1` and launcher routing changes.
- Remaining work: review, test contention behavior, commit, push, deploy once, and verify.

### 13.10 Concluding deployment success from a build

- Status: **False confidence**
- Evidence: **Repeated historical confusion**
- Result: build output looked successful even when later service/health stages rolled back.
- Current rule: require `FGP_DEPLOYMENT_OK`, health, services, public assets, and workflow smoke test.

### 13.11 PowerShell/CET incompatibility on recovered Windows

- Status: **Environment limitation; workaround exists**
- Evidence: **Current handoff rebuild and workstation history**
- Result: some PowerShell/Node launches terminate with a message that Windows does not fully support CET.
- Workaround: compatible command shell and `Run-With-FgpTools.cmd`.
- Do not rewrite application code to accommodate this local runtime problem.

### 13.12 In-app/built-in terminal could not accept the interactive password

- Status: **No useful deployment result; visible launcher used instead**
- Evidence: **Recorded workflow history**
- Goal: deploy through an embedded terminal.
- Result: the operator could not type into the expected prompt.
- Resolution: visible `OPEN-DEPLOY.vbs`/CMD launcher for interactive VPS password entry.
- Do not store the password to remove interactivity.

## 14. Recovery and Git attempts

### 14.1 Relying only on recovered local files after the OS failure

- Status: **Insufficient by itself; GitHub became the baseline**
- Evidence: **Recorded OS recovery history**
- Goal: restore the project from `C:\Windows.old`.
- Result: local artifacts included many one-off scripts, generated outputs, and uncertain source states.
- Resolution: reconcile the recovered application with `https://github.com/MqWaree/Forhud`, preserve history, test the merged tree, then deploy.
- Lesson: Git history plus validated recovery artifacts is safer than blindly copying the old workspace.

### 14.2 Bulk-staging the recovered workspace

- Status: **Explicitly avoided**
- Reason: the workspace contains databases, logs, archives, diagnostics, staging folders, and patchers.
- Current protection: audited release allowlist and deployment publication allowlist.
- Do not repeat: never use `git add -A` without a deliberate file-by-file review.

## 15. Live-site testing limitations

### 15.1 Assuming a live positive stays positive

- Status: **Unreliable conclusion**
- Evidence: **Many live Discord audit outputs**
- Problem: third-party pages, invites, DNS, rate limits, and access policies change.
- Correct use: live audits are time-stamped evidence, not permanent test fixtures.
- Preserve deterministic local fixtures for regressions.

### 15.2 Treating all failures as FGP bugs

- Status: **Incorrect diagnosis**
- Problem: some failures are provider exhaustion, DNS/TLS outages, 429, 5xx, permanent blocks, removed invites, or no contact.
- Correct approach: compare controlled fixture behavior with structured live failure categories.

### 15.3 Treating all blocks/timeouts as unavoidable third-party behavior

- Status: **Also incorrect diagnosis**
- Problem: FGP previously created false domain-level failures through speculative pages, worker wrapping, and over-aggressive concurrency.
- Correct approach: separate real external state from implementation defects using preserved attempt evidence.

## 16. Optimization changes that helped but did not prove the entire problem solved

These are not failures, but they should not be oversold.

### 16.1 Static-first plus selective rendering

- Helped: reduced Chromium pressure.
- Still requires proof: production median/p95, contact success, and crash rate on a bounded sample.

### 16.2 Adaptive concurrency

- Helped: backs off on 429/timeouts/5xx/worker pressure.
- Still requires proof: recovery curve, throughput under mixed static/dynamic workloads, and fairness.

### 16.3 Positive DNS caching and in-flight deduplication

- Helped: removes repeated lookup overhead.
- Still requires proof: cache safety, expiry behavior, and measured latency gain.

### 16.4 Brave result caching and canonical-domain deduplication

- Helped: reduces API-token waste and duplicate scanning.
- Still requires proof: cache hit rate, unique-domain yield per request, and stale-result behavior.

### 16.5 Bounded transient retries

- Helped: recovers temporary failures.
- Still requires proof: retry recovery percentage versus extra latency and load.

### 16.6 Persisted scanner/search/checker progress

- Helped: page refresh no longer needs to be the state owner.
- Still requires proof: active jobs after browser refresh and process restart in production.

## 17. Open questions that must be measured, not guessed

1. What is the current Brave unique-business yield per API request for the operator's real query set?
2. What are current scanner median/p95 latency and throughput by static versus dynamic method?
3. How many historical Timeout/Blocked rows were false classifications versus genuine external conditions?
4. What percentage of transient retries recover a valid contact?
5. Does the fifth-failure retirement path preserve every required history/export field?
6. Does Discord reconciliation survive restart and honor rate limits under the current production dataset?
7. Are all LZT listing and inventory amounts converted with the same selected-currency rate snapshot?
8. Does sold cleanup remove active entries after one minute without deleting history?
9. Does every qualifying Haze alert progress from queued to delivered with accurate retry evidence?
10. Does the current local deployment mutex prevent a second build before it touches the shared archive?

## 18. Required method before another optimization pass

Before changing timeouts, concurrency, retries, or extraction breadth:

1. Select a fixed controlled dataset.
2. Record current code commit and configuration names, without secret values.
3. Capture:
   - total sites;
   - static/dynamic split;
   - successful contacts by type;
   - no-contact completions;
   - DNS/TLS/connection/timeout/429/5xx/block/worker counts;
   - median and p95 latency;
   - throughput;
   - current/configured concurrency;
   - retry count and recovery;
   - CPU/memory/browser pressure where available.
4. Change one bottleneck or policy at a time.
5. Run unit/integration fixtures.
6. Repeat the controlled dataset.
7. Compare both correctness and speed.
8. Run a small production sample.
9. Preserve raw debug evidence.
10. Only then claim improvement.

## 19. Receiving-agent checklist

When a new bug resembles a historical issue:

- Search this ledger first.
- Inspect the current code; the old attempt may already be superseded.
- Locate a deterministic regression test.
- Check whether the symptom is product, provider, environment, deployment, or UI-only.
- Do not rerun untracked patch scripts without reading them.
- Do not rotate credentials as a generic debugging step.
- Do not increase concurrency without metrics.
- Do not bypass authentication/access controls.
- Update this ledger with new evidence after resolving the issue.

## 20. Final takeaway

The recurring failure pattern was treating a visible symptom as if it identified the failing layer:

- slow page -> raise concurrency;
- missing contact -> render/retry everything;
- login broken -> remove login;
- stale LZT UI -> poll faster;
- active service -> assume message delivered;
- build passed -> assume deployment succeeded;
- fallback loaded -> call scan successful;
- provider returned fewer results -> keep spending requests indefinitely.

FGP is most reliable when each layer is measured separately and final claims are tied to durable evidence.

