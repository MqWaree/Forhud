import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Download,
  ExternalLink,
  Globe2,
  Link2,
  ListPlus,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Square,
  Trash2,
  Users,
  Wifi,
  Zap,
} from "lucide-react";
import { discordDestinationKind, extractHttpUrls } from "@lead/shared";
import { api, type ScannerItem, type ScannerSnapshot } from "./api";
import {
  Badge,
  Button,
  Drawer,
  Empty,
  PageHeader,
  Progress,
  SearchBox,
  Stat,
} from "./components";

const notify = (message: string) =>
  window.dispatchEvent(new CustomEvent("toast", { detail: message }));
const formatScanStatus = (status: string) =>
  status
    .replace("CompletedWithFallback", "Completed with fallback")
    .replace("CompletedWithWarnings", "Completed with warnings");
const discordDestinationLabel = (url: string) => {
  const kind = discordDestinationKind(url);
  return `${kind === "channel" ? "Channel" : "Invite"} · ${url.replace("https://", "")}`;
};
const formatDuration = (milliseconds: number) =>
  milliseconds > 0
    ? milliseconds < 1_000
      ? `${milliseconds} ms`
      : `${(milliseconds / 1_000).toFixed(1)} s`
    : "—";
export default function SearcherPage() {
  const [data, setData] = useState<ScannerSnapshot>(),
    [page, setPage] = useState(1),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState("All"),
    [detail, setDetail] = useState<ScannerItem>(),
    [busy, setBusy] = useState(false),
    [showImport, setShowImport] = useState(false),
    [importText, setImportText] = useState(""),
    [importLabel, setImportLabel] = useState("Manual link import"),
    [query, setQuery] = useState(""),
    [targetPreset, setTargetPreset] = useState("25"),
    [customTarget, setCustomTarget] = useState("375"),
    [searchOutcome, setSearchOutcome] = useState<{
      discovered: number;
      requested: number;
    }>(),
    [braveStatus, setBraveStatus] = useState<{
      configured: boolean;
      provider: string;
      maxRequests?: number;
      maxResults?: number;
    }>();
  const load = useCallback(
    async () =>
      setData(
        await api.get<ScannerSnapshot>(
          `/scanner?page=${page}&pageSize=50&search=${encodeURIComponent(search)}&status=${encodeURIComponent(status)}`,
        ),
      ),
    [page, search, status],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void api
      .get<{
        configured: boolean;
        provider: string;
        maxRequests?: number;
        maxResults?: number;
      }>("/search/brave/status")
      .then(setBraveStatus)
      .catch(() =>
        setBraveStatus({ configured: false, provider: "Brave Search" }),
      );
  }, []);
  useEffect(() => {
    const es = new EventSource("/api/events");
    [
      "import",
      "scanner-progress",
      "scanner-performance",
      "scanner-state",
      "scanner-reset",
      "lead-update",
    ].forEach((name) => es.addEventListener(name, () => void load()));
    return () => es.close();
  }, [load]);
  const running = ["RUNNING", "STOPPING"].includes(data?.state.status || ""),
    progress = data?.stats.websites
      ? (data.stats.scanned / data.stats.websites) * 100
      : 0,
    current = useMemo(
      () => data?.items.find((x) => x.id === data.state.currentResultId),
      [data],
    ),
    importAnalysis = useMemo(() => {
      const lines = importText.split(/\r?\n/).filter((line) => line.trim());
      const occurrences = lines.flatMap((line) => extractHttpUrls(line));
      const urls = extractHttpUrls(importText);
      return {
        urls,
        total: lines.length,
        valid: urls.length,
        duplicates: Math.max(0, occurrences.length - urls.length),
        invalid: lines.filter((line) => extractHttpUrls(line).length === 0)
          .length,
      };
    }, [importText]),
    importUrls = importAnalysis.urls;
  async function action(path: string, message: string) {
    setBusy(true);
    try {
      await api.send(path);
      notify(message);
      await load();
    } finally {
      setBusy(false);
    }
  }
  async function reset() {
    if (
      !confirm(
        "Reset Scanner?\n\nThis removes the scanner workspace and progress. Saved Leads will not be deleted.",
      )
    )
      return;
    await action("/scanner/reset", "Scanner workspace reset.");
  }
  async function importLinks() {
    if (!importUrls.length) {
      notify("Paste at least one valid HTTP or HTTPS link.");
      return;
    }
    setBusy(true);
    try {
      const result = await api.send<{
        imported: number;
        created: number;
        duplicates: number;
        rejected: number;
        excluded: number;
        leadsAdded: number;
      }>("/scanner/import-links", "POST", {
        label: importLabel,
        urls: importUrls,
      });
      await api.send("/scanner/start");
      notify(
        `${result.created} new website${result.created === 1 ? "" : "s"} queued · ${result.leadsAdded} new lead${result.leadsAdded === 1 ? "" : "s"} synced automatically · ${result.duplicates} duplicate · ${result.excluded} platform link${result.excluded === 1 ? "" : "s"} ignored · ${result.rejected} rejected.`,
      );
      setShowImport(false);
      setImportText("");
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Link import failed.");
    } finally {
      setBusy(false);
    }
  }
  async function discoverAndScan(event?: FormEvent) {
    event?.preventDefault();
    if (query.trim().length < 2) {
      notify("Enter a search query first.");
      return;
    }
    const maxResults = Number(
      targetPreset === "CUSTOM" ? customTarget : targetPreset,
    );
    if (
      !Number.isInteger(maxResults) ||
      maxResults <= 0 ||
      maxResults > (braveStatus?.maxResults || 5_000)
    ) {
      notify(
        `Target Results must be a positive whole number up to ${(braveStatus?.maxResults || 5_000).toLocaleString()}.`,
      );
      return;
    }
    setBusy(true);
    try {
      const result = await api.send<{
        discovered: number;
        requested: number;
        created: number;
        duplicates: number;
        rejected: number;
        excluded: number;
        complete: boolean;
        requests: number;
        leadsAdded: number;
      }>("/search/brave", "POST", {
        query: query.trim(),
        maxResults,
      });
      notify(
        `${result.discovered} of ${result.requested} unique business websites found${result.complete ? "" : " (no more unique results available)"} · ${result.leadsAdded} new lead${result.leadsAdded === 1 ? "" : "s"} synced automatically · ${result.created} new queued · ${result.excluded} platform result${result.excluded === 1 ? "" : "s"} ignored · ${result.requests} API request${result.requests === 1 ? "" : "s"}.`,
      );
      setSearchOutcome({
        discovered: result.discovered,
        requested: result.requested,
      });
      setPage(1);
      setSearch("");
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Search failed.");
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return (
      <section className="page">
        <div className="loading">
          <RefreshCw /> Loading scanner workspace…
        </div>
      </section>
    );
  return (
    <section className="page">
      <PageHeader
        eyebrow="Persistent workspace discovery"
        title="Searcher / Scanner"
        subtitle="Accumulate, deduplicate, and scan captured websites across every search session."
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setShowImport(true);
              }}
            >
              <ListPlus /> Import links
            </Button>
            <a className="btn secondary" href="/api/export/scanner.csv">
              <Download /> Export
            </a>
            <Button
              disabled={busy || running}
              onClick={() =>
                action(
                  "/scanner/start",
                  data.state.status === "STOPPED"
                    ? "Scanner resumed and will stay on."
                    : "Scanner started and will stay on.",
                )
              }
            >
              <Play /> {data.state.status === "STOPPED" ? "Resume" : "Start"}
            </Button>
            <Button
              variant="secondary"
              disabled={busy || data.state.status !== "RUNNING"}
              onClick={() => action("/scanner/stop", "Scanner stopped safely.")}
            >
              <Square /> Stop
            </Button>
            <Button
              variant="danger"
              disabled={busy || running || !data.stats.websites}
              onClick={reset}
            >
              <Trash2 /> Reset
            </Button>
          </>
        }
      />
      <form className="brave-search-card card" onSubmit={discoverAndScan}>
        <div className="brave-search-heading">
          <span className="brave-search-icon">
            <Search />
          </span>
          <div>
            <small>Automatic discovery</small>
            <b>Search the web and scan every result</b>
          </div>
        </div>
        <label className="brave-query">
          <Search />
          <input
            value={query}
            maxLength={300}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="e.g. cybersecurity agencies in France"
            aria-label="Search query"
          />
        </label>
        <label className="brave-limit">
          <small>Target Results</small>
          <select
            value={targetPreset}
            onChange={(event) => setTargetPreset(event.target.value)}
            aria-label="Target Results"
          >
            {[10, 25, 50, 100, 250, 500, 1000].map((amount) => (
              <option key={amount} value={amount}>
                {amount}
              </option>
            ))}
            <option value="CUSTOM">Custom</option>
          </select>
        </label>
        {targetPreset === "CUSTOM" && (
          <label className="brave-custom">
            <small>Target Amount</small>
            <input
              type="number"
              min="1"
              step="1"
              max={braveStatus?.maxResults || 5_000}
              inputMode="numeric"
              value={customTarget}
              onChange={(event) => setCustomTarget(event.target.value)}
              aria-label="Custom Target Results"
            />
          </label>
        )}
        <Button
          type="submit"
          disabled={busy || !braveStatus?.configured || query.trim().length < 2}
        >
          {busy ? <RefreshCw className="spin" /> : <Zap />} Find &amp; scan
        </Button>
        <div
          className={`provider-status ${braveStatus?.configured ? "ready" : "offline"}`}
          title={
            braveStatus?.configured
              ? "The API key is stored securely on the local server."
              : "Add BRAVE_SEARCH_API_KEY to the local .env file."
          }
        >
          <i />
          {braveStatus?.configured ? "Brave connected" : "Brave not configured"}
          <small>
            Business filter on · up to {braveStatus?.maxRequests || 5} API
            requests while replacing platform results · Target Results means
            unique business domains collected
          </small>
          {searchOutcome && (
            <small className="target-outcome">
              Last search: {searchOutcome.discovered.toLocaleString()} /{" "}
              {searchOutcome.requested.toLocaleString()} Target Results
            </small>
          )}
        </div>
      </form>
      <article className="scanner-state card">
        <div className={`state-orb ${data.state.status.toLowerCase()}`}>
          <Activity />
        </div>
        <div>
          <small>Scanner status</small>
          <b>{data.state.status}</b>
        </div>
        <span>
          {data.state.status === "RUNNING"
            ? current
              ? `Processing ${current.domain.hostname}`
              : "Listening for new extension captures"
            : data.state.status === "STOPPED"
              ? "Progress saved · ready to resume"
              : data.state.status === "COMPLETED"
                ? "Ready to start persistent mode"
                : "Ready when you are"}
        </span>
        <div
          className={`engine-health ${data.engine.healthy ? "healthy" : "offline"}`}
          title={data.engine.error || `Scrapling ${data.engine.version || ""}`}
        >
          <i />
          Scrapling {data.engine.healthy ? "healthy" : "offline"}
        </div>
      </article>
      <article className="scanner-performance card">
        <header>
          <div>
            <small>Adaptive performance</small>
            <b>
              {data.performance.enabled
                ? "Automatic pressure control"
                : "Fixed concurrency"}
            </b>
          </div>
          <Badge tone={data.performance.enabled ? "connected" : undefined}>
            {data.performance.enabled ? "Adaptive" : "Manual"}
          </Badge>
        </header>
        <div className="performance-metrics">
          <span>
            <small>Concurrency</small>
            <b>
              {data.performance.currentConcurrency} /{" "}
              {data.performance.configuredConcurrency}
            </b>
          </span>
          <span>
            <small>Throughput</small>
            <b>{data.performance.throughputPerMinute.toFixed(1)} / min</b>
          </span>
          <span>
            <small>Median</small>
            <b>{formatDuration(data.performance.recent.medianDurationMs)}</b>
          </span>
          <span>
            <small>P95</small>
            <b>{formatDuration(data.performance.recent.p95DurationMs)}</b>
          </span>
          <span>
            <small>Completion</small>
            <b>{data.performance.recent.successRate.toFixed(1)}%</b>
          </span>
        </div>
        <footer>
          <span>{data.performance.lastAdjustmentReason}</span>
          <small>
            {data.performance.pressureEvents} pressure events ·{" "}
            {data.performance.rateLimited} rate limits ·{" "}
            {data.performance.timeoutEvents} timeouts · last{" "}
            {data.performance.recent.sampleSize} scans
          </small>
        </footer>
      </article>
      <div className="stats scanner-stats">
        <Stat
          label="Websites found"
          value={data.stats.websites.toLocaleString()}
          detail="Canonical workspace results"
          icon={<Globe2 />}
        />
        <Stat
          label="Scanned"
          value={data.stats.scanned.toLocaleString()}
          detail={`${Math.round(progress)}% processed`}
          icon={<Zap />}
        />
        <Stat
          label="Pending"
          value={data.stats.pending.toLocaleString()}
          detail={`${data.stats.scanning} currently active`}
          icon={<Activity />}
        />
        <Stat
          label="Discord links"
          value={data.stats.discord.toLocaleString()}
          detail="Normalized invites"
          icon={<Wifi />}
        />
        <Stat
          label="Leads added"
          value={data.stats.leads.toLocaleString()}
          detail="Saved to the funnel"
          icon={<Users />}
        />
      </div>
      <article className="card scan-progress enhanced">
        <div>
          <b>
            {data.state.status === "RUNNING"
              ? "Scanning"
              : "Workspace progress"}
          </b>
          <span>
            {data.stats.scanned.toLocaleString()} /{" "}
            {data.stats.websites.toLocaleString()} · {data.stats.failed} failed
            · {data.stats.timeouts} timeout
          </span>
        </div>
        <Progress value={progress} />
        {current && <small>Current: {current.domain.hostname}</small>}
      </article>
      <div className="toolbar card scanner-toolbar">
        <SearchBox
          value={search}
          onChange={(v) => {
            setSearch(v);
            setPage(1);
          }}
          placeholder="Search the scanner workspace…"
        />
        <select
          value={status}
          aria-label="Filter scanner results by status"
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option>All</option>
          {[
            "Pending",
            "Queued",
            "Scanning",
            "Completed",
            "CompletedWithFallback",
            "CompletedWithWarnings",
            "Excluded",
            "Failed",
            "Timeout",
            "Blocked",
          ].map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
        <Button
          variant="ghost"
          onClick={() =>
            action(
              "/scanner/retry-failed",
              "Failed results returned to the queue.",
            )
          }
        >
          <RotateCcw /> Retry failed
        </Button>
        <span className="count auto-lead-sync">
          Leads sync automatically · {data.pagination.total.toLocaleString()}{" "}
          results
        </span>
      </div>
      <article className="card table-card">
        {data.items.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Website</th>
                  <th>Sources</th>
                  <th>Discord</th>
                  <th>Hosting</th>
                  <th>First seen</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.id} onClick={() => setDetail(item)}>
                    <td>
                      <div className="domain-cell">
                        <span>{item.domain.hostname[0]?.toUpperCase()}</span>
                        <div>
                          <b>{item.domain.hostname}</b>
                          <small>{item.title || item.url}</small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="source-count">
                        {item.sources.length}
                      </span>{" "}
                      {item.sources[0]?.query || "—"}
                    </td>
                    <td>
                      {item.discordLinks[0] ? (
                        discordDestinationLabel(item.discordLinks[0].url)
                      ) : (
                        <span className="muted">Not found</span>
                      )}
                    </td>
                    <td>{item.domain.location?.country || "Not checked"}</td>
                    <td>{new Date(item.firstSeen).toLocaleDateString()}</td>
                    <td>
                      <Badge>{formatScanStatus(item.scanStatus)}</Badge>
                    </td>
                    <td>
                      <ArrowRight />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="No scanner results"
            body="Run a Brave search above, import links, or use the extension on a manually viewed Google results page. New searches accumulate here until you reset the workspace."
          />
        )}
        <footer className="pagination">
          <Button
            variant="ghost"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            <ArrowLeft /> Previous
          </Button>
          <span>
            Page {data.pagination.page} of {data.pagination.pages}
          </span>
          <Button
            variant="ghost"
            disabled={page >= data.pagination.pages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next <ArrowRight />
          </Button>
        </footer>
      </article>
      {detail && (
        <Drawer
          title={detail.domain.hostname}
          onClose={() => setDetail(undefined)}
        >
          <div className="drawer-body">
            <div className="engine-summary">
              <span>
                <small>Scan engine</small>
                <b>{detail.scanEngine || "Scrapling"}</b>
              </span>
              <span>
                <small>Fetch mode</small>
                <b>{detail.fetchMode || "Pending"}</b>
              </span>
              <span>
                <small>Original status</small>
                <b>{detail.originalHttpStatus || detail.httpStatus || "—"}</b>
              </span>
              <span>
                <small>Pages visited</small>
                <b>{detail.pagesVisited || 0}</b>
              </span>
            </div>
            <Detail label="Website" value={detail.finalUrl || detail.url} />
            <Detail
              label="Status"
              value={formatScanStatus(detail.scanStatus)}
            />
            {detail.fallbackUsed && (
              <Detail
                label="Fallback recovery"
                value={`${detail.fallbackUrl || "Alternate page"}${
                  detail.fallbackHttpStatus
                    ? ` (HTTP ${detail.fallbackHttpStatus})`
                    : ""
                }`}
              />
            )}
            <Detail
              label="Robots policy"
              value={detail.robotsStatus || "Not recorded"}
            />
            {detail.metaDescription && (
              <Detail label="Description" value={detail.metaDescription} />
            )}
            {detail.discordLinks.length ? (
              <div className="source-history">
                <h3>Discord destinations</h3>
                {detail.discordLinks.map((link) => (
                  <div key={link.id}>
                    <span>
                      <b>{discordDestinationLabel(link.url)}</b>
                      <small>
                        {link.discoveryMethod || "unknown method"} ·{" "}
                        {link.discoverySection || "UNKNOWN"} ·{" "}
                        {link.interaction || "NONE"} ·{" "}
                        {link.fetchMode || "HTTP"} ·{" "}
                        {link.validationStatus || "UNVALIDATED"}
                      </small>
                      <small>
                        {link.sourcePage || detail.finalUrl || detail.url}
                      </small>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <Detail label="Discord" value="None found" />
            )}
            <Detail
              label="Emails"
              value={detail.emails.join(", ") || "None found"}
            />
            <Detail
              label="Social links"
              value={
                detail.socialLinks
                  .map((link) => `${link.type}: ${link.url}`)
                  .join(", ") || "None found"
              }
            />
            <Detail
              label="Duration"
              value={
                detail.scanDuration
                  ? `${(detail.scanDuration / 1000).toFixed(2)} seconds`
                  : "—"
              }
            />
            <Detail
              label="Hosting location"
              value={detail.domain.location?.country || "Not checked"}
            />
            <Detail
              label="First discovered"
              value={new Date(detail.firstSeen).toLocaleString()}
            />
            <Detail
              label="Last discovered"
              value={new Date(detail.lastSeen).toLocaleString()}
            />
            <div className="source-history">
              <h3>Found from searches</h3>
              {detail.sources.map((s) => (
                <div key={s.id}>
                  <span>
                    <b>{s.query}</b>
                    <small>
                      Position #{s.position} ·{" "}
                      {new Date(s.discoveredAt).toLocaleString()}
                    </small>
                  </span>
                </div>
              ))}
            </div>
            {detail.pages.length > 0 && (
              <div className="pages-scanned">
                <h3>Pages scanned</h3>
                {detail.pages.map((page, index) => (
                  <div
                    className="scan-page-record"
                    key={`${page.url}-${index}`}
                  >
                    <span>
                      <b>{page.path || "/"}</b>
                      <small>
                        Depth {page.depth} · {page.fetchMode || "HTTP"}
                        {page.durationMs ? ` · ${page.durationMs} ms` : ""}
                      </small>
                    </span>
                    <Badge>{page.status}</Badge>
                    {page.attempts && page.attempts.length > 0 && (
                      <div className="scan-attempts">
                        {page.attempts.map((attempt) => (
                          <small key={`${attempt.attempt}-${attempt.url}`}>
                            Attempt {attempt.attempt} ·{" "}
                            {attempt.status
                              ? `HTTP ${attempt.status}`
                              : attempt.errorCode || "Fetch failed"}
                            {attempt.dynamicResult &&
                            attempt.dynamicResult !== "NOT_ATTEMPTED"
                              ? ` · Dynamic ${attempt.dynamicResult.toLowerCase()}`
                              : ""}
                            {` · ${attempt.durationMs} ms`}
                          </small>
                        ))}
                        {page.redirectChain?.map((hop) => (
                          <small key={`${hop.url}-${hop.location}`}>
                            Redirect HTTP {hop.status} · {hop.url} →{" "}
                            {hop.location}
                          </small>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {detail.error && <div className="error-box">{detail.error}</div>}
            {[
              "SCAN_LIMIT_REACHED",
              "NO_DISCORD_FOUND",
              "DISCORD_NOT_FOUND",
            ].includes(detail.discoveryFailureReason) ? (
              <div className="discovery-notice">
                <b>Discovery scan completed</b>
                <span>
                  No public Discord link was detected after checking{" "}
                  {detail.pages.length} permitted relevant page
                  {detail.pages.length === 1 ? "" : "s"}. The website is still
                  saved as a lead and can be rescanned later.
                </span>
              </div>
            ) : detail.discoveryFailureReason ? (
              <div className="error-box">
                Discovery issue:{" "}
                {detail.discoveryFailureReason.replaceAll("_", " ")}
              </div>
            ) : null}
            <div className="drawer-actions">
              <a
                className="btn primary"
                href={detail.finalUrl || detail.url}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink /> Open website
              </a>
              <Button
                variant="secondary"
                onClick={() =>
                  action(
                    `/scanner/results/${detail.id}/rescan`,
                    "Result queued for rescan.",
                  )
                }
              >
                <RotateCcw /> Rescan
              </Button>
              <a className="btn primary" href="/leads">
                <Users /> View in leads
              </a>
            </div>
          </div>
        </Drawer>
      )}
      {showImport && (
        <Drawer title="Import links" onClose={() => setShowImport(false)}>
          <div className="drawer-body import-links-drawer">
            <div className="import-intro">
              <span>
                <Link2 />
              </span>
              <div>
                <b>Bulk link intake</b>
                <p>
                  Paste URLs, bare domains, or CSV/TXT content. Duplicates are
                  merged automatically and private network targets are rejected.
                </p>
              </div>
            </div>
            <label className="editor-field">
              <small>Import label</small>
              <input
                value={importLabel}
                maxLength={300}
                onChange={(event) => setImportLabel(event.target.value)}
                placeholder="Manual link import"
              />
            </label>
            <label className="editor-field">
              <small>Links</small>
              <textarea
                className="notes import-links-input"
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
                placeholder={"example.com\nhttps://another-site.com/contact"}
                autoFocus
              />
            </label>
            <label className="editor-field import-file-picker">
              <small>TXT or CSV file</small>
              <input
                type="file"
                accept=".txt,.csv,text/plain,text/csv"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  void file
                    .text()
                    .then(setImportText)
                    .catch(() =>
                      notify("The selected file could not be read."),
                    );
                }}
              />
            </label>
            <div className="import-summary">
              <span>
                <b>{importAnalysis.valid.toLocaleString()}</b>
                <small>valid unique links</small>
              </span>
              <span>
                <b>{importAnalysis.duplicates.toLocaleString()}</b>
                <small>duplicates</small>
              </span>
              <span>
                <b>{importAnalysis.invalid.toLocaleString()}</b>
                <small>invalid rows</small>
              </span>
              <span>
                <b>{importAnalysis.total.toLocaleString()}</b>
                <small>input rows</small>
              </span>
            </div>
            <div className="drawer-actions sticky">
              <Button variant="secondary" onClick={() => setShowImport(false)}>
                Cancel
              </Button>
              <Button
                disabled={busy || !importUrls.length || !importLabel.trim()}
                onClick={importLinks}
              >
                <Play /> Import &amp; scan
              </Button>
            </div>
          </div>
        </Drawer>
      )}
    </section>
  );
}
function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail">
      <small>{label}</small>
      <span>{value}</span>
    </div>
  );
}
