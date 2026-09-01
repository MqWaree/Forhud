import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
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
  Zap,
} from "lucide-react";
import { discordDestinationKind, extractHttpUrls } from "@lead/shared";
import {
  api,
  type DiscordReconciliationProgress,
  type DiscordReconciliationStart,
  type ScannerItem,
  type ScannerSnapshot,
} from "./api";
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
const retryableStatuses = new Set(["Failed", "Timeout", "Blocked"]);
type DiscoveryProgress = {
  operationId: string;
  query?: string;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  phase: string;
  requested: number;
  discovered: number;
  queued?: number;
  duplicates?: number;
  rejected?: number;
  excluded: number;
  leadsAdded?: number;
  requests: number;
  failedRequests: number;
  progressPercent?: number;
  startedAt?: string;
  updatedAt?: string;
  queryPagesChecked?: number;
  totalVariants?: number;
  activeVariants?: number;
  stopReason?:
    | "TARGET_REACHED"
    | "RESULTS_EXHAUSTED"
    | "REQUEST_LIMIT_REACHED"
    | "PROVIDER_DEGRADED";
};
export default function SearcherPage() {
  const [data, setData] = useState<ScannerSnapshot>(),
    [page, setPage] = useState(1),
    [search, setSearch] = useState(""),
    [debouncedSearch, setDebouncedSearch] = useState(""),
    [status, setStatus] = useState("All"),
    [detail, setDetail] = useState<ScannerItem>(),
    [detailLoading, setDetailLoading] = useState(false),
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
    [discoveryProgress, setDiscoveryProgress] = useState<DiscoveryProgress>(),
    [braveStatus, setBraveStatus] = useState<{
      configured: boolean;
      provider: string;
      maxRequests?: number;
      maxResults?: number;
    }>(),
    [discordProgress, setDiscordProgress] =
      useState<DiscordReconciliationProgress>();
  const loadController = useRef<AbortController>();
  const activeSearchOperation = useRef("");
  const lastDiscordProgressStatus =
    useRef<DiscordReconciliationProgress["status"]>();
  const load = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    try {
      const snapshot = await api.get<ScannerSnapshot>(
        `/scanner?page=${page}&pageSize=50&search=${encodeURIComponent(debouncedSearch)}&status=${encodeURIComponent(status)}`,
        { signal: controller.signal },
      );
      if (!controller.signal.aborted) setData(snapshot);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError"))
        notify(
          error instanceof Error ? error.message : "Scanner could not load.",
        );
    }
  }, [page, debouncedSearch, status]);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    void load();
    return () => loadController.current?.abort();
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
    void api
      .get<{ current: DiscoveryProgress | null }>("/search/brave/current")
      .then(({ current }) => {
        if (!current) return;
        activeSearchOperation.current = current.operationId;
        setDiscoveryProgress(current);
        if (current.status !== "RUNNING")
          setSearchOutcome({
            discovered: current.discovered,
            requested: current.requested,
          });
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    void api
      .get<DiscordReconciliationProgress | null>(
        "/scanner/discord-links/reconcile",
      )
      .then((current) => {
        if (!current) return;
        lastDiscordProgressStatus.current = current.status;
        setDiscordProgress(current);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    const es = new EventSource("/api/events");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleLoad = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void load();
      }, 900);
    };
    const updateDiscoveryProgress = (event: Event) => {
      try {
        const progress = JSON.parse(
          (event as MessageEvent<string>).data,
        ) as DiscoveryProgress;
        if (!progress.operationId) return;
        activeSearchOperation.current = progress.operationId;
        setDiscoveryProgress(progress);
      } catch {
        // Ignore malformed progress payloads and keep discovery running.
      }
    };
    const updateDiscordProgress = (event: Event) => {
      try {
        const progress = JSON.parse(
          (event as MessageEvent<string>).data,
        ) as DiscordReconciliationProgress;
        if (!progress.operationId) return;
        const previousStatus = lastDiscordProgressStatus.current;
        lastDiscordProgressStatus.current = progress.status;
        setDiscordProgress(progress);
        if (previousStatus === "RUNNING" && progress.status === "COMPLETED") {
          const failureDetail = progress.failed
            ? ` · ${progress.failed.toLocaleString()} temporary errors`
            : "";
          notify(
            `Discord check completed · ${(progress.uniqueServers || 0).toLocaleString()} unique servers · ${(progress.alternateInvites || 0).toLocaleString()} alternate invites${failureDetail}`,
          );
          scheduleLoad();
        } else if (
          previousStatus === "RUNNING" &&
          progress.status === "FAILED"
        ) {
          notify(progress.error || "Discord link check failed.");
        }
      } catch {
        // Ignore malformed progress payloads; the persisted status is reloaded.
      }
    };
    es.addEventListener("brave-search-progress", updateDiscoveryProgress);
    es.addEventListener(
      "discord-reconciliation-progress",
      updateDiscordProgress,
    );
    [
      "import",
      "scanner-progress",
      "scanner-performance",
      "scanner-state",
      "scanner-reset",
      "discord-links-reconciled",
      "lead-update",
    ].forEach((name) => es.addEventListener(name, scheduleLoad));
    return () => {
      clearTimeout(timer);
      es.removeEventListener("brave-search-progress", updateDiscoveryProgress);
      es.removeEventListener(
        "discord-reconciliation-progress",
        updateDiscordProgress,
      );
      es.close();
    };
  }, [load]);
  async function openDetail(item: ScannerItem) {
    setDetail(item);
    setDetailLoading(true);
    try {
      setDetail(await api.get<ScannerItem>(`/scanner/results/${item.id}`));
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : "Result details could not load.",
      );
    } finally {
      setDetailLoading(false);
    }
  }
  const running = ["RUNNING", "STOPPING"].includes(data?.state.status || ""),
    searchRunning = discoveryProgress?.status === "RUNNING",
    discordReconciling = discordProgress?.status === "RUNNING",
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
    } catch (error) {
      notify(error instanceof Error ? error.message : "Scanner action failed.");
    } finally {
      setBusy(false);
    }
  }
  async function retryRecoverable() {
    setBusy(true);
    try {
      const result = await api.send<{
        queued: number;
        skippedPermanent: number;
        recoveryProfile: {
          concurrency: number;
          timeoutSeconds: number;
          retries: number;
        } | null;
      }>("/scanner/retry-failed");
      const queuedMessage = result.queued
        ? `${result.queued.toLocaleString()} recoverable failure${result.queued === 1 ? "" : "s"} queued with the safer retry profile`
        : "No recoverable failures were waiting";
      const skippedMessage = result.skippedPermanent
        ? ` · ${result.skippedPermanent.toLocaleString()} explicit access block${result.skippedPermanent === 1 ? " was" : "s were"} left untouched`
        : "";
      notify(`${queuedMessage}${skippedMessage}.`);
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Retry could not start.");
    } finally {
      setBusy(false);
    }
  }
  async function reconcileDiscordInvites() {
    try {
      const result = await api.send<DiscordReconciliationStart>(
        "/scanner/discord-links/reconcile",
      );
      if (result.progress) {
        lastDiscordProgressStatus.current = result.progress.status;
        setDiscordProgress(result.progress);
      }
      notify(
        result.started
          ? "Discord link checker started in the background."
          : "The Discord link checker is already running.",
      );
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : "Discord invites could not be checked.",
      );
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
        `${result.created} new website${result.created === 1 ? "" : "s"} queued · Discord- or Telegram-qualified leads will appear as soon as contacts are found · ${result.duplicates} duplicate · ${result.excluded} platform link${result.excluded === 1 ? "" : "s"} ignored · ${result.rejected} rejected.`,
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
    const operationId = crypto.randomUUID();
    activeSearchOperation.current = operationId;
    setDiscoveryProgress({
      operationId,
      query: query.trim(),
      status: "RUNNING",
      phase: "Starting web discovery",
      requested: maxResults,
      discovered: 0,
      queued: 0,
      duplicates: 0,
      rejected: 0,
      excluded: 0,
      leadsAdded: 0,
      requests: 0,
      failedRequests: 0,
      progressPercent: 2,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
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
        failedRequests: number;
        leadsAdded: number;
        stopReason:
          | "TARGET_REACHED"
          | "RESULTS_EXHAUSTED"
          | "REQUEST_LIMIT_REACHED"
          | "PROVIDER_DEGRADED";
      }>("/search/brave", "POST", {
        query: query.trim(),
        maxResults,
        operationId,
      });
      notify(
        `${result.discovered} of ${result.requested} unique business websites found${result.complete ? "" : result.stopReason === "REQUEST_LIMIT_REACHED" ? " (provider request ceiling reached)" : result.stopReason === "PROVIDER_DEGRADED" ? " (Brave was partially unavailable; successful results were preserved)" : " (provider results exhausted)"} · ${result.created} new queued · Discord- or Telegram-qualified leads will appear as soon as contacts are found · ${result.excluded} platform result${result.excluded === 1 ? "" : "s"} ignored · ${result.requests} API request${result.requests === 1 ? "" : "s"}${result.failedRequests ? ` · ${result.failedRequests} failed after retry` : ""}.`,
      );
      setSearchOutcome({
        discovered: result.discovered,
        requested: result.requested,
      });
      setDiscoveryProgress((currentProgress) => ({
        operationId,
        query: currentProgress?.query || query.trim(),
        status: "COMPLETED",
        phase: result.complete
          ? "Target reached and websites queued"
          : result.stopReason === "REQUEST_LIMIT_REACHED"
            ? "Provider request ceiling reached"
            : result.stopReason === "PROVIDER_DEGRADED"
              ? "Provider partially unavailable"
              : "Provider search space exhausted",
        requested: result.requested,
        discovered: result.discovered,
        queued: result.created,
        duplicates: result.duplicates,
        rejected: result.rejected,
        excluded: result.excluded,
        leadsAdded: result.leadsAdded,
        requests: result.requests,
        failedRequests: result.failedRequests,
        progressPercent: 100,
        startedAt: currentProgress?.startedAt,
        updatedAt: new Date().toISOString(),
        queryPagesChecked: currentProgress?.queryPagesChecked,
        totalVariants: currentProgress?.totalVariants,
        activeVariants: currentProgress?.activeVariants,
        stopReason: result.stopReason,
      }));
      setPage(1);
      setSearch("");
      await load();
    } catch (error) {
      setDiscoveryProgress((currentProgress) => ({
        operationId,
        query: currentProgress?.query || query.trim(),
        status: "FAILED",
        phase: error instanceof Error ? error.message : "Search failed",
        requested: maxResults,
        discovered: currentProgress?.discovered || 0,
        excluded: currentProgress?.excluded || 0,
        requests: currentProgress?.requests || 0,
        failedRequests: currentProgress?.failedRequests || 0,
        progressPercent: currentProgress?.progressPercent || 0,
        startedAt: currentProgress?.startedAt,
        updatedAt: new Date().toISOString(),
        queryPagesChecked: currentProgress?.queryPagesChecked,
        totalVariants: currentProgress?.totalVariants,
        activeVariants: currentProgress?.activeVariants,
      }));
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
            <a className="btn secondary" href="/api/export/discord-links.csv">
              <Download /> Export Discord
            </a>
            <a
              className="btn secondary"
              href="/api/export/scanner-failures.csv"
            >
              <Download /> Failed history
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
          disabled={
            busy ||
            searchRunning ||
            !braveStatus?.configured ||
            query.trim().length < 2
          }
        >
          {busy || searchRunning ? <RefreshCw className="spin" /> : <Zap />}{" "}
          {searchRunning ? "Searching…" : "Find & scan"}
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
      {discoveryProgress && (
        <article
          className={`card brave-discovery-progress ${discoveryProgress.status.toLowerCase()}`}
          aria-live="polite"
        >
          <header>
            <div>
              <span className="brave-discovery-pulse" />
              <div>
                <b>{discoveryProgress.phase}</b>
                <small>
                  {discoveryProgress.discovered.toLocaleString()} of{" "}
                  {discoveryProgress.requested.toLocaleString()} unique business
                  websites
                  {discoveryProgress.query
                    ? ` · ${discoveryProgress.query}`
                    : ""}
                </small>
              </div>
            </div>
            <strong>
              {discoveryProgress.progressPercent ??
                Math.min(
                  100,
                  Math.round(
                    (discoveryProgress.discovered /
                      Math.max(1, discoveryProgress.requested)) *
                      100,
                  ),
                )}
              %
            </strong>
          </header>
          <Progress
            value={
              discoveryProgress.progressPercent ??
              (discoveryProgress.discovered /
                Math.max(1, discoveryProgress.requested)) *
                100
            }
          />
          <footer className="current-search-stats">
            <span>
              <small>Found</small>
              <b>
                {discoveryProgress.discovered.toLocaleString()} /{" "}
                {discoveryProgress.requested.toLocaleString()}
              </b>
            </span>
            <span>
              <small>Queued</small>
              <b>{(discoveryProgress.queued || 0).toLocaleString()}</b>
            </span>
            <span>
              <small>Duplicates</small>
              <b>{(discoveryProgress.duplicates || 0).toLocaleString()}</b>
            </span>
            <span>
              <small>Filtered</small>
              <b>
                {(
                  discoveryProgress.excluded + (discoveryProgress.rejected || 0)
                ).toLocaleString()}
              </b>
            </span>
            <span>
              <small>API</small>
              <b>{discoveryProgress.requests.toLocaleString()}</b>
            </span>
            {discoveryProgress.failedRequests > 0 && (
              <span className="warning">
                <small>Errors</small>
                <b>{discoveryProgress.failedRequests.toLocaleString()}</b>
              </span>
            )}
          </footer>
        </article>
      )}
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
          detail={`${data.stats.discordServers.toLocaleString()} servers · ${data.stats.discordAlternateInvites.toLocaleString()} alternate${data.stats.discordUnresolved ? ` · ${data.stats.discordUnresolved.toLocaleString()} unresolved` : ""}`}
          icon={
            <button
              type="button"
              className="stat-refresh"
              onClick={() => void reconcileDiscordInvites()}
              disabled={discordReconciling || data.stats.discord === 0}
              aria-label="Check Discord invites for duplicate servers"
              title="Check invite codes and group links that belong to the same Discord server"
            >
              <RefreshCw className={discordReconciling ? "spin" : ""} />
            </button>
          }
        />
        <Stat
          label="Leads added"
          value={data.stats.leads.toLocaleString()}
          detail="Saved to the funnel"
          icon={<Users />}
        />
      </div>
      {discordProgress && (
        <article
          className={`card discord-check-progress ${discordProgress.status.toLowerCase()}`}
          aria-live="polite"
          aria-label={`Discord link checker ${discordProgress.progressPercent} percent`}
        >
          <header>
            <div>
              <span className="discord-check-pulse">
                <RefreshCw className={discordReconciling ? "spin" : ""} />
              </span>
              <div>
                <b>{discordProgress.phase}</b>
                <small>
                  {discordProgress.checked.toLocaleString()} of{" "}
                  {discordProgress.total.toLocaleString()} links checked ·{" "}
                  {discordProgress.uniqueDestinations.toLocaleString()} unique
                  destinations
                </small>
              </div>
            </div>
            <strong>{discordProgress.progressPercent}%</strong>
          </header>
          <Progress value={discordProgress.progressPercent} />
          <footer>
            <span>
              <small>Valid</small>
              <b>{discordProgress.valid.toLocaleString()}</b>
            </span>
            <span>
              <small>Invalid</small>
              <b>{discordProgress.invalid.toLocaleString()}</b>
            </span>
            <span>
              <small>Errors</small>
              <b>{discordProgress.failed.toLocaleString()}</b>
            </span>
            <span>
              <small>Rate limited</small>
              <b>{discordProgress.rateLimited.toLocaleString()}</b>
            </span>
            <span>
              <small>Requests saved</small>
              <b>{discordProgress.requestsSaved.toLocaleString()}</b>
            </span>
            {discordProgress.status === "FAILED" && discordProgress.error && (
              <span className="discord-check-error">
                <small>Error</small>
                <b>{discordProgress.error}</b>
              </span>
            )}
          </footer>
        </article>
      )}
      <article
        className="card scan-progress enhanced"
        aria-label={`Scanner progress ${Math.round(progress)} percent`}
      >
        <header className="scan-progress-heading">
          <div>
            <b>
              {data.state.status === "RUNNING"
                ? "Scanning"
                : "Workspace progress"}
            </b>
            <span>
              {data.stats.scanned.toLocaleString()} of{" "}
              {data.stats.websites.toLocaleString()} websites processed
            </span>
          </div>
          <strong>{Math.min(100, Math.max(0, Math.round(progress)))}%</strong>
        </header>
        <Progress value={progress} />
        <footer
          className="scan-progress-summary"
          aria-label="Scanner statistics"
        >
          <span>
            <small>Pending</small>
            <b>{data.stats.pending.toLocaleString()}</b>
          </span>
          <span>
            <small>Active</small>
            <b>{data.stats.scanning.toLocaleString()}</b>
          </span>
          <span>
            <small>Discord</small>
            <b>{data.stats.discord.toLocaleString()}</b>
          </span>
          <span>
            <small>Failed</small>
            <b>{data.stats.failed.toLocaleString()}</b>
          </span>
          <span>
            <small>Timeout</small>
            <b>{data.stats.timeouts.toLocaleString()}</b>
          </span>
          <span>
            <small>Blocked</small>
            <b>{data.stats.blocked.toLocaleString()}</b>
          </span>
        </footer>
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
          disabled={busy}
          onClick={() => void retryRecoverable()}
        >
          <RotateCcw /> Retry recoverable
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
                  <tr key={item.id} onClick={() => void openDetail(item)}>
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
                        {item.sourceCount ?? item.sources.length}
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
                      {retryableStatuses.has(item.scanStatus) ? (
                        <button
                          className="btn ghost retry-row-btn"
                          disabled={busy}
                          aria-label={`Retry ${item.domain.hostname}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            void action(
                              `/scanner/results/${item.id}/rescan`,
                              `${item.domain.hostname} queued for retry.`,
                            );
                          }}
                        >
                          <RotateCcw /> Retry
                        </button>
                      ) : (
                        <ArrowRight />
                      )}
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
            {detailLoading && (
              <div className="loading inline-loading">
                <RefreshCw className="spin" /> Loading complete diagnostics…
              </div>
            )}
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
            {detail.discoveryFailureReason === "CONTACT_NOT_FOUND" ? (
              <div className="discovery-notice">
                <b>No supported contact found</b>
                <span>
                  No public Discord, Telegram, or email contact was detected
                  after checking {detail.pages.length} permitted relevant page
                  {detail.pages.length === 1 ? "" : "s"}. This result was not
                  added to Leads and can be rescanned later.
                </span>
              </div>
            ) : [
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
                  eligible when another supported contact exists and can be
                  rescanned later.
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
