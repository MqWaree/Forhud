import {
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useMemo,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  Banknote,
  Bell,
  BellRing,
  Download,
  FileJson,
  ExternalLink,
  Globe2,
  Link2,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  ShoppingCart,
  Square,
  Trash2,
  Radio,
  ShieldCheck,
  Warehouse,
} from "lucide-react";
import { extractHttpUrls } from "@lead/shared";
import { api, type LztTrackerSnapshot, type RustPriceSnapshot } from "./api";
import { useAuth } from "./Auth";
import {
  Badge,
  Button,
  Empty,
  PageHeader,
  Progress,
  SearchBox,
  Stat,
} from "./components";

const notify = (message: string) =>
  window.dispatchEvent(new CustomEvent("toast", { detail: message }));

type DisplayCurrency = "DKK" | "EUR" | "USD" | "RUB";
function formatCurrencyMinor(
  value: number | null | undefined,
  currency: DisplayCurrency,
) {
  if (value == null) return "Unknown";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value / 100);
  } catch {
    return `${(value / 100).toFixed(2)} ${currency}`;
  }
}
type ProductType = "RUST_NFA" | "GAME_ACCOUNTS" | "OTHER_ITEMS";
const displayCurrencies: DisplayCurrency[] = ["DKK", "EUR", "USD", "RUB"];
function lztStateLabel(value: string) {
  const state = value.toUpperCase();
  if (state === "SOLD") return "Sold";
  if (state === "REMOVED") return "Removed";
  if (state === "ACTIVE") return "Active";
  return "Unavailable";
}

function lztStateClass(value: string) {
  const state = value.toUpperCase();
  return ["ACTIVE", "SOLD", "REMOVED"].includes(state)
    ? state.toLowerCase()
    : "inactive";
}

export default function RustPricesPage() {
  const { user } = useAuth();
  const hasLztAccess =
    user.role === "ADMIN" ||
    user.ranks?.some((rank) => rank.permissions.includes("LZT_ACCESS"));
  const [view, setView] = useState<
    "search" | "lzt" | "providers" | "results" | "statistics"
  >("search");
  const [data, setData] = useState<RustPriceSnapshot>();
  const [lzt, setLzt] = useState<LztTrackerSnapshot>();
  const [lztSearch, setLztSearch] = useState("");
  const [lztSort, setLztSort] = useState("newest");
  const [lztPage, setLztPage] = useState(1);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [providerSearch, setProviderSearch] = useState("");
  const [preset, setPreset] = useState("All NFA");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [sort, setSort] = useState("newest");
  const [displayCurrency, setDisplayCurrency] = useState<DisplayCurrency>(
    () => {
      const saved = localStorage.getItem(
        "fgp-rust-price-currency",
      ) as DisplayCurrency | null;
      return saved && displayCurrencies.includes(saved) ? saved : "USD";
    },
  );
  const [busy, setBusy] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [query, setQuery] = useState("Rust NFA accounts for sale");
  const [target, setTarget] = useState("25");
  const [braveConfigured, setBraveConfigured] = useState(false);
  const [productType, setProductType] = useState<ProductType>("RUST_NFA");
  const [productName, setProductName] = useState("Rust NFA accounts");
  const [draftProductType, setDraftProductType] =
    useState<ProductType>("RUST_NFA");
  const [draftProductName, setDraftProductName] = useState("Rust NFA accounts");

  const load = useCallback(async () => {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: "50",
      search,
      preset,
      minPrice,
      maxPrice,
      sort,
      currency: displayCurrency,
      productType,
      productName,
    });
    setData(await api.get<RustPriceSnapshot>(`/rust-prices?${params}`));
  }, [
    page,
    search,
    preset,
    minPrice,
    maxPrice,
    sort,
    displayCurrency,
    productType,
    productName,
  ]);

  const loadLzt = useCallback(async () => {
    if (!hasLztAccess) return;
    const params = new URLSearchParams({
      page: String(lztPage),
      pageSize: "100",
      search: lztSearch,
      sort: lztSort,
      currency: displayCurrency,
    });
    setLzt(await api.get<LztTrackerSnapshot>(`/lzt-tracker?${params}`));
  }, [displayCurrency, hasLztAccess, lztPage, lztSearch, lztSort]);

  useEffect(
    () => localStorage.setItem("fgp-rust-price-currency", displayCurrency),
    [displayCurrency],
  );

  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (view === "lzt") void loadLzt();
  }, [view, loadLzt]);
  useEffect(() => {
    if (view !== "lzt" || !hasLztAccess) return;
    const refresh = window.setInterval(() => void loadLzt(), 10_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadLzt();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [view, hasLztAccess, loadLzt]);
  useEffect(() => {
    void api
      .get<{ configured: boolean }>("/search/brave/status")
      .then((result) => setBraveConfigured(result.configured))
      .catch(() => setBraveConfigured(false));
  }, []);
  useEffect(() => {
    const events = new EventSource("/api/events");
    let priceTimer: ReturnType<typeof setTimeout> | undefined;
    let lztTimer: ReturnType<typeof setTimeout> | undefined;
    const schedulePriceLoad = () => {
      clearTimeout(priceTimer);
      priceTimer = setTimeout(() => void load(), 150);
    };
    const scheduleLztLoad = () => {
      clearTimeout(lztTimer);
      lztTimer = setTimeout(() => void loadLzt(), 150);
    };
    ["rust-price-progress", "rust-price-state", "rust-price-reset"].forEach(
      (name) => events.addEventListener(name, schedulePriceLoad),
    );
    [
      "LZT_TRACKER_STATUS",
      "LZT_LISTING_ENRICHED",
      "LZT_MARKET_AVERAGE_UPDATED",
      "LZT_TRACKER_ERROR",
    ].forEach((name) => events.addEventListener(name, scheduleLztLoad));
    events.addEventListener("ready", scheduleLztLoad);
    events.addEventListener("LZT_LISTING_CREATED", scheduleLztLoad);
    events.addEventListener("LZT_LISTINGS_UPDATED", scheduleLztLoad);
    return () => {
      clearTimeout(priceTimer);
      clearTimeout(lztTimer);
      events.close();
    };
  }, [load, loadLzt]);

  const urls = useMemo(() => extractHttpUrls(importText), [importText]);
  const running = ["RUNNING", "STOPPING"].includes(data?.state.status || "");
  const progress = data?.stats.sources
    ? (data.stats.completed / data.stats.sources) * 100
    : 0;
  const providers = data?.providers ?? [];
  const filteredProviders = useMemo(() => {
    const term = providerSearch.trim().toLowerCase();
    if (!term) return providers;
    return providers.filter(
      (provider) =>
        provider.domain.toLowerCase().includes(term) ||
        provider.title.toLowerCase().includes(term),
    );
  }, [providers, providerSearch]);
  const providersWithStock = providers.filter(
    (provider) => provider.stock > 0,
  ).length;
  const totalProviderStock = providers.reduce(
    (total, provider) => total + provider.stock,
    0,
  );
  const priceSortDirection =
    sort === "price-asc"
      ? "ascending"
      : sort === "price-desc"
        ? "descending"
        : "none";

  function togglePriceSort() {
    setSort((current) =>
      current === "price-asc" ? "price-desc" : "price-asc",
    );
    setPage(1);
  }

  function formatMarketPrice(minor: number, currency: string) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(minor / 100);
    } catch {
      return `${(minor / 100).toFixed(2)} ${currency}`;
    }
  }

  function selectDisplayCurrency(value: string) {
    if (!displayCurrencies.includes(value as DisplayCurrency)) return;
    setDisplayCurrency(value as DisplayCurrency);
    setPage(1);
  }

  const productBody = { productType, productName };

  async function action(
    path: string,
    message: string,
    body?: Record<string, unknown>,
  ) {
    setBusy(true);
    try {
      await api.send(path, "POST", body);
      notify(message);
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  async function runSearch(event: FormEvent) {
    event.preventDefault();
    if (!braveConfigured) return notify("Brave Search is not configured.");
    const maxResults = Number(target);
    if (
      !query.trim() ||
      !Number.isInteger(maxResults) ||
      maxResults < 1 ||
      maxResults > 5000
    )
      return notify("Enter a query and a target from 1 to 5000.");
    setBusy(true);
    try {
      const result = await api.send<{
        requested: number;
        discovered: number;
        complete: boolean;
        created: number;
        duplicates: number;
        requests: number;
      }>("/rust-prices/search", "POST", { query, maxResults, ...productBody });
      if (!result.complete) {
        notify(
          `${result.discovered}/${result.requested} unique sites found after ${result.requests} searches · ${result.created} added · ${result.duplicates} already known.`,
        );
        await load();
        return;
      }
      notify(
        `${result.discovered} sources discovered · ${result.created} added · ${result.duplicates} already queued.`,
      );
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Search failed");
    } finally {
      setBusy(false);
    }
  }

  async function importUrls() {
    if (!urls.length)
      return notify("Paste at least one public HTTP or HTTPS URL.");
    setBusy(true);
    try {
      const result = await api.send<{
        created: number;
        duplicates: number;
        rejected: number;
      }>("/rust-prices/import", "POST", { urls, ...productBody });
      await api.send("/rust-prices/start", "POST", productBody);
      notify(
        `${result.created} sources queued · ${result.duplicates} duplicates · ${result.rejected} rejected.`,
      );
      setImportText("");
      setShowImport(false);
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (
      !confirm(
        `Reset ${productName}?\n\nThis removes its sources, listings, and price history.`,
      )
    )
      return;
    await action(
      "/rust-prices/reset",
      `${productName} workspace reset.`,
      productBody,
    );
  }

  async function deleteResults() {
    if (
      !confirm(
        `Delete every ${productName} result?\n\nSources remain available for a later rescan. This cannot be undone.`,
      )
    )
      return;
    await action(
      "/rust-prices/delete-results",
      `All ${productName} results deleted.`,
      { ...productBody, confirm: "DELETE" },
    );
  }

  function applyProduct() {
    const nextName =
      draftProductType === "RUST_NFA"
        ? "Rust NFA accounts"
        : draftProductName.trim();
    if (nextName.length < 2)
      return notify("Enter the product you want to find.");
    setProductType(draftProductType);
    setProductName(nextName);
    setQuery(
      draftProductType === "RUST_NFA"
        ? "Rust NFA accounts for sale"
        : `${nextName} for sale`,
    );
    setPreset("All NFA");
    setPage(1);
  }

  return (
    <div className="page rust-prices-page">
      <PageHeader
        eyebrow={
          view === "lzt"
            ? "Live market feed"
            : view === "providers"
              ? "Provider intelligence"
              : "Market intelligence"
        }
        title={
          view === "lzt"
            ? "LZT Market Tracker"
            : view === "providers"
              ? "NFA Provider Stock"
              : "Product Price Scanner"
        }
        subtitle={
          view === "lzt"
            ? "Official LZT Rust listings, price alerts, and market statistics."
            : view === "providers"
              ? "Every known provider grouped by website, with unique active account stock and converted prices."
              : `Finding public prices for ${productName}. Each product keeps its own sources, listings, and statistics.`
        }
        actions={
          view === "lzt" ? undefined : (
            <>
              <Button
                variant="secondary"
                onClick={() => setShowImport((value) => !value)}
              >
                <Link2 /> Import URLs
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  window.open(
                    `/api/export/rust-prices.csv?${new URLSearchParams(productBody)}`,
                    "_blank",
                  )
                }
              >
                <Download /> Export CSV
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  window.open("/api/export/rust-price-debug.json", "_blank")
                }
              >
                <FileJson /> Debug JSON
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  window.open("/api/export/rust-price-debug.csv", "_blank")
                }
              >
                <Download /> Debug CSV
              </Button>
              {running ? (
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() =>
                    action(
                      "/rust-prices/stop",
                      "Stopping after the current pages.",
                    )
                  }
                >
                  <Square /> Stop
                </Button>
              ) : (
                <Button
                  disabled={busy || !data?.stats.pending}
                  onClick={() =>
                    action(
                      "/rust-prices/start",
                      "Price scanner started.",
                      productBody,
                    )
                  }
                >
                  <Play /> Start scanner
                </Button>
              )}
            </>
          )
        }
      />

      <nav className="market-subtabs" aria-label="Market sections">
        <button
          className={view === "search" ? "active" : ""}
          onClick={() => setView("search")}
        >
          General NFA Search
        </button>
        <button
          className={view === "lzt" ? "active" : ""}
          onClick={() => setView("lzt")}
        >
          <Radio /> LZT Tracker{" "}
          {!hasLztAccess && <span aria-label="Locked">🔒</span>}
        </button>
        <button
          className={view === "providers" ? "active" : ""}
          onClick={() => setView("providers")}
        >
          <Warehouse /> NFA Providers
        </button>
        <button
          className={view === "results" ? "active" : ""}
          onClick={() => setView("results")}
        >
          Market Results
        </button>
        <button
          className={view === "statistics" ? "active" : ""}
          onClick={() => setView("statistics")}
        >
          Market Statistics
        </button>
      </nav>

      {view === "lzt" &&
        (hasLztAccess ? (
          <LztTrackerPanel
            data={lzt}
            displayCurrency={displayCurrency}
            setDisplayCurrency={selectDisplayCurrency}
            search={lztSearch}
            sort={lztSort}
            page={lztPage}
            setPage={setLztPage}
            setSearch={(value) => {
              setLztSearch(value);
              setLztPage(1);
            }}
            setSort={(value) => {
              setLztSort(value);
              setLztPage(1);
            }}
            reload={loadLzt}
            admin={user.role === "ADMIN"}
          />
        ) : (
          <section className="lzt-rank-lock card">
            <ShieldCheck />
            <div>
              <h2>LZT Scanner is rank-locked</h2>
              <p>
                An administrator must assign the <b>LZT Access</b> rank before
                you can view or control this scanner.
              </p>
            </div>
          </section>
        ))}

      {view === "search" && (
        <>
          <section className="product-switcher card">
            <div>
              <small>PRODUCT MODE</small>
              <h2>{productName}</h2>
              <p>Choose a game-account market or any other public product.</p>
            </div>
            <label>
              <span>Type</span>
              <select
                value={draftProductType}
                onChange={(event) => {
                  const type = event.target.value as ProductType;
                  setDraftProductType(type);
                  if (type === "RUST_NFA")
                    setDraftProductName("Rust NFA accounts");
                  else if (draftProductType === "RUST_NFA")
                    setDraftProductName("");
                }}
              >
                <option value="RUST_NFA">Rust NFA accounts</option>
                <option value="GAME_ACCOUNTS">Game accounts</option>
                <option value="OTHER_ITEMS">Other items</option>
              </select>
            </label>
            <label className="product-name-field">
              <span>Product</span>
              <input
                disabled={draftProductType === "RUST_NFA"}
                list="saved-market-products"
                value={draftProductName}
                onChange={(event) => setDraftProductName(event.target.value)}
                placeholder={
                  draftProductType === "GAME_ACCOUNTS"
                    ? "e.g. Fortnite accounts"
                    : "e.g. CS2 skins"
                }
              />
            </label>
            <datalist id="saved-market-products">
              {data?.products
                .filter((product) => product.type === draftProductType)
                .map((product) => (
                  <option key={product.key} value={product.name} />
                ))}
            </datalist>
            <Button variant="secondary" onClick={applyProduct}>
              Use product
            </Button>
          </section>

          <form className="price-search-card card" onSubmit={runSearch}>
            <div>
              <span className="price-search-icon">
                <Search />
              </span>
              <label>
                <small>SEARCH QUERY</small>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Rust NFA accounts for sale"
                />
              </label>
              <label className="price-target">
                <small>TARGET SOURCES</small>
                <input
                  type="number"
                  min="1"
                  max="5000"
                  step="1"
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                />
              </label>
              <Button disabled={busy || !braveConfigured}>
                <Search /> Discover & scan
              </Button>
            </div>
            <p>
              {braveConfigured
                ? "Searches public results, then scans static and safely rendered public pages."
                : "Brave Search is not configured. You can still import source URLs manually."}
            </p>
          </form>

          {showImport && (
            <section className="price-import card">
              <div className="card-head">
                <div>
                  <h2>Import public listing URLs</h2>
                  <p>One URL per line. Duplicates are ignored automatically.</p>
                </div>
                <Badge>{urls.length} valid</Badge>
              </div>
              <textarea
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
                placeholder={
                  "https://market.example/rust-nfa\nhttps://seller.example/product"
                }
              />
              <div className="price-import-actions">
                <Button variant="ghost" onClick={() => setShowImport(false)}>
                  Cancel
                </Button>
                <Button disabled={busy || !urls.length} onClick={importUrls}>
                  Import and scan
                </Button>
              </div>
            </section>
          )}
        </>
      )}

      {view !== "lzt" && (
        <>
          <section className="stats price-stats">
            <Stat
              label="Sources"
              value={data?.stats.sources ?? 0}
              detail={`${data?.stats.pending ?? 0} waiting`}
              icon={<Globe2 />}
            />
            <Stat
              label="Listings"
              value={data?.stats.listings ?? 0}
              detail="Distinct public products"
              icon={<ShoppingCart />}
            />
            <Stat
              label="Completed"
              value={data?.stats.completed ?? 0}
              detail="Source scans finished"
              icon={<Activity />}
            />
            <Stat
              label="Failed"
              value={data?.stats.failed ?? 0}
              detail="Sources to retry"
              icon={<RefreshCw />}
            />
          </section>

          <section className="scanner-progress-card card">
            <div>
              <span
                className={`scanner-live-dot ${running ? "running" : ""}`}
              />
              <div>
                <b>Scanner {data?.state.status?.toLowerCase() || "idle"}</b>
                <small>
                  {data?.stats.completed ?? 0} / {data?.stats.sources ?? 0}{" "}
                  sources · {data?.stats.failed ?? 0} failed
                </small>
              </div>
            </div>
            <Progress value={progress} />
            <div className="button-row">
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  action(
                    "/rust-prices/retry-failed",
                    "Failed sources queued again.",
                    productBody,
                  )
                }
              >
                <RefreshCw /> Retry failed
              </Button>
              <Button
                variant="ghost"
                disabled={busy || running}
                onClick={reset}
              >
                <RotateCcw /> Reset product
              </Button>
            </div>
            <div className="button-row">
              <Button
                variant="ghost"
                disabled={busy || running || !data?.stats.sources}
                onClick={() =>
                  action(
                    "/rust-prices/rescan-all",
                    "All sources queued for a diagnostic rescan.",
                    productBody,
                  )
                }
              >
                <Activity /> Rescan all with diagnostics
              </Button>
              <Button
                variant="danger"
                disabled={busy || running || !data?.stats.listings}
                onClick={deleteResults}
              >
                <Trash2 /> Delete all results
              </Button>
            </div>
          </section>
        </>
      )}

      {view === "providers" && (
        <section className="nfa-provider-directory">
          <div className="provider-overview">
            <article>
              <small>KNOWN PROVIDERS</small>
              <strong>{providers.length}</strong>
              <span>Unique provider domains</span>
            </article>
            <article>
              <small>IN STOCK</small>
              <strong>{providersWithStock}</strong>
              <span>Providers with active accounts</span>
            </article>
            <article>
              <small>ACTIVE ACCOUNTS</small>
              <strong>{totalProviderStock}</strong>
              <span>Unique listings across providers</span>
            </article>
          </div>

          <section className="table-card card provider-stock-table">
            <div className="card-head provider-toolbar">
              <div>
                <h2>Provider stock directory</h2>
                <p>
                  Stock counts only active, deduplicated listings. Providers
                  with no current stock remain visible.
                </p>
              </div>
              <div className="nfa-filters provider-filters">
                <SearchBox
                  value={providerSearch}
                  onChange={setProviderSearch}
                  placeholder="Search providers…"
                />
                <label className="currency-picker">
                  <span>
                    <Banknote /> Currency
                  </span>
                  <select
                    aria-label="Provider price currency"
                    value={displayCurrency}
                    onChange={(event) =>
                      selectDisplayCurrency(event.target.value)
                    }
                  >
                    {displayCurrencies.map((currency) => (
                      <option key={currency} value={currency}>
                        {currency}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
            {filteredProviders.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th>Scanner</th>
                      <th>Stock</th>
                      <th>Price range</th>
                      <th>Average</th>
                      <th>Last scan</th>
                      <th>Website</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredProviders.map((provider) => (
                      <tr key={provider.domain}>
                        <td>
                          <div className="provider-identity">
                            <b>{provider.domain}</b>
                            <small title={provider.title}>
                              {provider.title || "Provider website"}
                            </small>
                          </div>
                        </td>
                        <td>
                          <Badge tone={provider.scanStatus.toLowerCase()}>
                            {provider.scanStatus}
                          </Badge>
                        </td>
                        <td>
                          <span
                            className={`provider-stock ${provider.stock ? "available" : "empty"}`}
                          >
                            {provider.stock}
                          </span>
                        </td>
                        <td>
                          {provider.convertedListings ? (
                            <span className="provider-price-range">
                              {formatMarketPrice(
                                provider.lowestPriceMinor!,
                                displayCurrency,
                              )}
                              {provider.lowestPriceMinor !==
                                provider.highestPriceMinor && (
                                <>
                                  {" "}
                                  –{" "}
                                  {formatMarketPrice(
                                    provider.highestPriceMinor!,
                                    displayCurrency,
                                  )}
                                </>
                              )}
                            </span>
                          ) : (
                            <span className="provider-no-price">
                              No active prices
                            </span>
                          )}
                        </td>
                        <td>
                          {provider.averagePriceMinor === undefined
                            ? "—"
                            : formatMarketPrice(
                                provider.averagePriceMinor,
                                displayCurrency,
                              )}
                        </td>
                        <td>
                          <time dateTime={provider.lastScannedAt}>
                            {new Date(provider.lastScannedAt).toLocaleString()}
                          </time>
                        </td>
                        <td>
                          <a
                            className="provider-link"
                            href={provider.url}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`Open ${provider.domain}`}
                          >
                            Open <ExternalLink />
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty
                title="No matching providers"
                body="Try another domain or provider name."
              />
            )}
          </section>
        </section>
      )}

      {(view === "search" || view === "results") && (
        <section className="table-card card price-listings-table">
          <div className="card-head price-toolbar">
            <div>
              <h2>{productName} listings</h2>
              <p>
                Prices are converted automatically; the seller's original price
                stays underneath.
              </p>
            </div>
            <div className="nfa-filters">
              <label className="currency-picker">
                <span>
                  <Banknote /> Currency
                </span>
                <select
                  aria-label="Display currency"
                  value={displayCurrency}
                  onChange={(event) =>
                    selectDisplayCurrency(event.target.value)
                  }
                >
                  {displayCurrencies.map((currency) => (
                    <option key={currency} value={currency}>
                      {currency}
                    </option>
                  ))}
                </select>
              </label>
              <SearchBox
                value={search}
                onChange={(value) => {
                  setSearch(value);
                  setPage(1);
                }}
                placeholder="Search names…"
              />
              {productType === "RUST_NFA" && (
                <select
                  aria-label="Name preset"
                  value={preset}
                  onChange={(event) => {
                    setPreset(event.target.value);
                    setPage(1);
                  }}
                >
                  {[
                    "All NFA",
                    "Hours",
                    "Inactive",
                    "Premium",
                    "Inventory",
                    "Other NFA",
                  ].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              )}
              <input
                aria-label={`Minimum Price in ${displayCurrency}`}
                type="number"
                min="0"
                step="0.01"
                value={minPrice}
                onChange={(event) => {
                  setMinPrice(event.target.value);
                  setPage(1);
                }}
                placeholder={`Min ${displayCurrency}`}
              />
              <input
                aria-label={`Maximum Price in ${displayCurrency}`}
                type="number"
                min="0"
                step="0.01"
                value={maxPrice}
                onChange={(event) => {
                  setMaxPrice(event.target.value);
                  setPage(1);
                }}
                placeholder={`Max ${displayCurrency}`}
              />
              <select
                aria-label="Sort listings"
                value={sort}
                onChange={(event) => {
                  setSort(event.target.value);
                  setPage(1);
                }}
              >
                <option value="newest">Newest</option>
                <option value="price-asc">Price: low to high</option>
                <option value="price-desc">Price: high to low</option>
                <option value="name-asc">Name: A to Z</option>
              </select>
            </div>
          </div>
          {data?.listings.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th aria-sort={priceSortDirection}>
                      <button
                        className={`sortable-table-heading ${priceSortDirection !== "none" ? "active" : ""}`}
                        type="button"
                        onClick={togglePriceSort}
                        title="Sort by price"
                      >
                        Price{" "}
                        {sort === "price-asc" ? (
                          <ArrowUp />
                        ) : sort === "price-desc" ? (
                          <ArrowDown />
                        ) : (
                          <ArrowUpDown />
                        )}
                      </button>
                    </th>
                    <th>Link</th>
                  </tr>
                </thead>
                <tbody>
                  {data.listings.map((listing) => (
                    <tr key={listing.id}>
                      <td>
                        <b title={listing.name}>{listing.name}</b>
                      </td>
                      <td>
                        <strong className="listing-price">
                          {listing.convertedPriceAmount === undefined
                            ? listing.priceText
                            : formatMarketPrice(
                                listing.convertedPriceAmount,
                                displayCurrency,
                              )}
                        </strong>
                        {listing.convertedPriceAmount !== undefined &&
                          listing.currency !== displayCurrency && (
                            <small className="original-listing-price">
                              Original: {listing.priceText}
                            </small>
                          )}
                      </td>
                      <td>
                        <a
                          className="nfa-public-link"
                          href={listing.link}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <span>{listing.link}</span>
                          <ExternalLink />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title={`No ${productName} prices yet`}
              body="Run a public search or import a public product or marketplace URL to begin."
              action={
                <Button onClick={() => setShowImport(true)}>
                  <Link2 /> Import URLs
                </Button>
              }
            />
          )}
          {(data?.pagination.pages ?? 1) > 1 && (
            <footer className="price-pagination">
              <Button
                variant="ghost"
                disabled={page <= 1}
                onClick={() => setPage((value) => value - 1)}
              >
                <ArrowLeft /> Previous
              </Button>
              <span>
                Page {page} of {data?.pagination.pages}
              </span>
              <Button
                variant="ghost"
                disabled={page >= (data?.pagination.pages ?? 1)}
                onClick={() => setPage((value) => value + 1)}
              >
                Next <ArrowRight />
              </Button>
            </footer>
          )}
        </section>
      )}

      {(view === "search" || view === "results") && !!data?.sources.length && (
        <section className="price-source-strip card">
          <div className="card-head">
            <div>
              <h2>Recent source scans</h2>
              <p>
                Every scan outcome is retained. Export Debug JSON for complete
                nested attempts or Debug CSV for spreadsheet analysis.
              </p>
            </div>
            <Activity />
          </div>
          <div>
            {data.sources.slice(0, 12).map((source) => (
              <article key={source.id}>
                <span>
                  <b>{source.domain}</b>
                  <small>
                    {source.pagesChecked} pages ·{" "}
                    {source.durationMs
                      ? `${(source.durationMs / 1000).toFixed(1)}s`
                      : "not scanned"}
                    {source.error ? ` · ${source.error}` : ""}
                  </small>
                </span>
                <Badge tone={source.scanStatus.toLowerCase()}>
                  {source.scanStatus}
                </Badge>
              </article>
            ))}
          </div>
        </section>
      )}
      {(view === "search" || view === "statistics") &&
        !!data?.marketStats.totalListings && (
          <section className="market-summary card">
            <div className="card-head">
              <div>
                <h2>Total account market</h2>
                <p>
                  Every supported listing converted to {displayCurrency}. Rates{" "}
                  {data.conversion.stale
                    ? "are cached"
                    : `updated ${new Date(data.conversion.updatedAt).toLocaleDateString()}`}
                  .
                </p>
              </div>
              <label className="market-currency-selector">
                <span>Display currency</span>
                <select
                  aria-label="Market display currency"
                  value={displayCurrency}
                  onChange={(event) =>
                    selectDisplayCurrency(event.target.value)
                  }
                >
                  {displayCurrencies.map((currency) => (
                    <option key={currency} value={currency}>
                      {currency}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="market-overview">
              <article>
                <small>LISTINGS</small>
                <strong>{data.marketStats.totalListings}</strong>
                <span>Active price records</span>
              </article>
              <article>
                <small>PUBLIC LINKS</small>
                <strong>{data.marketStats.publicLinks}</strong>
                <span>Distinct listing pages</span>
              </article>
              <article>
                <small>SOURCES</small>
                <strong>{data.marketStats.sourcesRepresented}</strong>
                <span>Sites with prices</span>
              </article>
              <article>
                <small>CURRENCIES</small>
                <strong>{data.marketStats.currencies.length}</strong>
                <span>Reported separately</span>
              </article>
            </div>
            <div className="converted-market-stats">
              <header>
                <div>
                  <small>CONVERTED MARKET</small>
                  <strong>{data.marketStats.converted.currency}</strong>
                </div>
                <Badge>
                  {data.marketStats.converted.listings} converted prices
                </Badge>
              </header>
              <dl>
                <div>
                  <dt>Lowest</dt>
                  <dd>
                    {formatMarketPrice(
                      data.marketStats.converted.lowestMinor,
                      displayCurrency,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Median</dt>
                  <dd>
                    {formatMarketPrice(
                      data.marketStats.converted.medianMinor,
                      displayCurrency,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Average</dt>
                  <dd>
                    {formatMarketPrice(
                      data.marketStats.converted.averageMinor,
                      displayCurrency,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Highest</dt>
                  <dd>
                    {formatMarketPrice(
                      data.marketStats.converted.highestMinor,
                      displayCurrency,
                    )}
                  </dd>
                </div>
              </dl>
              <p>
                Indicative conversion via {data.conversion.source}. Original
                advertised prices remain visible in the listings.
              </p>
            </div>
            {!!data.marketStats.categories.length && (
              <div className="category-market-section">
                <div className="market-original-heading">
                  <span>Category statistics</span>
                  <small>Categories with at least 3 listings</small>
                </div>
                <div className="category-market-grid">
                  {data.marketStats.categories.map((category) => (
                    <article key={category.category}>
                      <header>
                        <strong>{category.category}</strong>
                        <Badge>{category.listings} prices</Badge>
                      </header>
                      <dl>
                        <div>
                          <dt>Lowest</dt>
                          <dd>
                            {formatMarketPrice(
                              category.lowestMinor,
                              displayCurrency,
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>Median</dt>
                          <dd>
                            {formatMarketPrice(
                              category.medianMinor,
                              displayCurrency,
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>Average</dt>
                          <dd>
                            {formatMarketPrice(
                              category.averageMinor,
                              displayCurrency,
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>Highest</dt>
                          <dd>
                            {formatMarketPrice(
                              category.highestMinor,
                              displayCurrency,
                            )}
                          </dd>
                        </div>
                      </dl>
                    </article>
                  ))}
                </div>
              </div>
            )}
            <div className="market-original-heading">
              <span>Original currency breakdown</span>
              <small>Unconverted seller prices</small>
            </div>
            <div className="market-currency-grid">
              {data.marketStats.currencies.map((currency) => (
                <article key={currency.currency}>
                  <header>
                    <strong>{currency.currency}</strong>
                    <Badge>{currency.listings} prices</Badge>
                  </header>
                  <dl>
                    <div>
                      <dt>Lowest</dt>
                      <dd>
                        {formatMarketPrice(
                          currency.lowestMinor,
                          currency.currency,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>Median</dt>
                      <dd>
                        {formatMarketPrice(
                          currency.medianMinor,
                          currency.currency,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>Average</dt>
                      <dd>
                        {formatMarketPrice(
                          currency.averageMinor,
                          currency.currency,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>Highest</dt>
                      <dd>
                        {formatMarketPrice(
                          currency.highestMinor,
                          currency.currency,
                        )}
                      </dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
          </section>
        )}
    </div>
  );
}

function LztInventoryValue({
  currency,
  cs2Minor,
  rustMinor,
  totalMinor,
}: {
  currency: DisplayCurrency;
  cs2Minor?: number;
  rustMinor?: number;
  totalMinor?: number;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({
    top: 0,
    left: 0,
    placement: "above" as "above" | "below",
  });
  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const tooltipWidth = 220;
    const edge = 12;
    const placement = rect.top >= 140 ? "above" : "below";
    setPosition({
      top: placement === "above" ? rect.top - 10 : rect.bottom + 10,
      left: Math.max(
        edge + tooltipWidth / 2,
        Math.min(
          window.innerWidth - edge - tooltipWidth / 2,
          rect.left + rect.width / 2,
        ),
      ),
      placement,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  if (totalMinor == null) return <>Unknown</>;
  const totalLabel = formatCurrencyMinor(totalMinor, currency);
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="lzt-inventory-total"
        aria-describedby={open ? tooltipId : undefined}
        aria-label={`Inventory total ${totalLabel}. Hover for breakdown.`}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        {totalLabel}
      </button>
      {open &&
        createPortal(
          <div
            id={tooltipId}
            className={`lzt-inventory-tooltip ${position.placement}`}
            role="tooltip"
            style={{ top: position.top, left: position.left }}
          >
            <strong>Inventory value</strong>
            <span>
              CS2 <b>{formatCurrencyMinor(cs2Minor, currency)}</b>
            </span>
            <span>
              Rust <b>{formatCurrencyMinor(rustMinor, currency)}</b>
            </span>
            <span className="total">
              Total <b>{totalLabel}</b>
            </span>
            <small>Converted to {currency}</small>
          </div>,
          document.body,
        )}
    </>
  );
}

function LztTrackerPanel({
  data,
  search,
  displayCurrency,
  setDisplayCurrency,
  sort,
  page,
  setPage,
  setSearch,
  setSort,
  reload,
  admin,
}: {
  data?: LztTrackerSnapshot;
  search: string;
  displayCurrency: DisplayCurrency;
  setDisplayCurrency: (value: string) => void;
  sort: string;
  page: number;
  setPage: (value: number | ((current: number) => number)) => void;
  setSearch: (value: string) => void;
  setSort: (value: string) => void;
  reload: () => Promise<void>;
  admin: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState<"scanner" | "notifications">(
    "scanner",
  );
  const [testMaximumPriceUsd, setTestMaximumPriceUsd] = useState("15");
  const [testMinimumGames, setTestMinimumGames] = useState("0");
  const [testMinimumRustHours, setTestMinimumRustHours] = useState("2000");
  const [manualHazeMessage, setManualHazeMessage] = useState("");
  const command = async (path: string, body?: unknown) => {
    setBusy(true);
    try {
      await api.send(path, "POST", body);
      await reload();
    } catch (error) {
      notify(error instanceof Error ? error.message : "LZT action failed");
    } finally {
      setBusy(false);
    }
  };
  const testCriteria = {
    maximumPriceUsd: Number(testMaximumPriceUsd),
    minimumGames: Number(testMinimumGames),
    minimumRustHours: Number(testMinimumRustHours),
  };
  const testCriteriaValid =
    Number.isFinite(testCriteria.maximumPriceUsd) &&
    testCriteria.maximumPriceUsd > 0 &&
    testCriteria.maximumPriceUsd <= 1_000 &&
    Number.isInteger(testCriteria.minimumGames) &&
    testCriteria.minimumGames >= 0 &&
    testCriteria.minimumGames <= 10_000 &&
    Number.isInteger(testCriteria.minimumRustHours) &&
    testCriteria.minimumRustHours >= 0 &&
    testCriteria.minimumRustHours <= 100_000;
  const sendLiveHazeTest = async () => {
    if (!testCriteriaValid) {
      notify("Enter valid price, games, and Rust-hours criteria");
      return;
    }
    setBusy(true);
    try {
      const result = await api.send<{
        itemId: string;
        priceUsdMinor: number;
        gamesCount: number;
        rustHours: number;
      }>("/lzt-tracker/test-alert", "POST", testCriteria);
      notify(
        "Queued LZT " +
          result.itemId +
          ": $" +
          (result.priceUsdMinor / 100).toFixed(2) +
          ", " +
          result.gamesCount.toLocaleString() +
          " games, " +
          Math.round(result.rustHours).toLocaleString() +
          " Rust hours",
      );
      await reload();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Haze test alert failed");
    } finally {
      setBusy(false);
    }
  };
  const sendManualHazeMessage = async () => {
    const content = manualHazeMessage.trim();
    if (!content) return notify("Enter a message for Haze to send");
    setBusy(true);
    try {
      await api.send("/lzt-tracker/haze-message", "POST", { content });
      setManualHazeMessage("");
      notify("Message queued for Haze. No LZT request was made.");
      await reload();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Haze message failed");
    } finally {
      setBusy(false);
    }
  };
  const state = data?.state.state || "STOPPED";
  const running = ["RUNNING", "STARTING", "DEGRADED", "RATE_LIMITED"].includes(
    state,
  );
  const priceSortDirection =
    sort === "price-asc"
      ? "ascending"
      : sort === "price-desc"
        ? "descending"
        : "none";
  const togglePriceSort = () =>
    setSort(sort === "price-asc" ? "price-desc" : "price-asc");
  const resolvedCurrency = data?.displayCurrency || displayCurrency;
  const currencyFormatter = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: resolvedCurrency,
  });
  const thresholdLabel = currencyFormatter.format(
    (data?.notifyBelowDisplayMinor ?? 250) / 100,
  );
  const highHoursThresholdLabel = currencyFormatter.format(
    (data?.notifyHighHoursBelowDisplayMinor ?? 600) / 100,
  );
  const highHoursMinimum = data?.notifyHighHoursMinimum ?? 2_000;
  const enableDesktopNotifications = async () => {
    if (!("Notification" in window))
      return notify("Desktop notifications are not supported by this browser.");
    const permission = await window.Notification.requestPermission();
    notify(
      permission === "granted"
        ? "Desktop LZT alerts enabled."
        : "Desktop notifications were not enabled.",
    );
  };
  const time = (value?: string) =>
    value ? new Date(value).toLocaleTimeString() : "—";
  return (
    <div className="lzt-tracker-view">
      <section className="lzt-hero card">
        <div>
          <small>LIVE MARKET FEED</small>
          <h2>LZT Market Tracker</h2>
          <p>
            {data?.sourceMode === "OFFICIAL_API"
              ? "Uses the official Market API."
              : "Reads publicly accessible listing pages without marketplace credentials."}
          </p>
        </div>
        <Badge tone={running ? "completed" : "failed"}>{state}</Badge>
      </section>
      <nav className="lzt-subtabs" aria-label="LZT scanner sections">
        <button
          className={section === "scanner" ? "active" : ""}
          onClick={() => setSection("scanner")}
        >
          <Radio /> Scanner
        </button>
        <button
          className={section === "notifications" ? "active" : ""}
          onClick={() => setSection("notifications")}
        >
          <Bell /> Notifications <span>{data?.notificationCount ?? 0}</span>
        </button>
      </nav>
      {section === "notifications" ? (
        <>
          <section className="lzt-alert-summary card">
            <div>
              <BellRing />
              <span>
                <small>PRICE ALERT RULE</small>
                <h2>Haze alerts: {thresholdLabel} or less</h2>
                <p>
                  Historical baseline listings are excluded. Haze also alerts
                  for accounts above {highHoursMinimum.toLocaleString()} Rust
                  hours at or below {highHoursThresholdLabel}.
                </p>
              </span>
            </div>
            <Button variant="secondary" onClick={enableDesktopNotifications}>
              <Bell /> Enable desktop alerts
            </Button>
          </section>
          <section className="table-card card lzt-listings lzt-notifications">
            <div className="card-head">
              <div>
                <h2>Price notifications</h2>
                <p>
                  Newest alerts are shown first and remain available after
                  restarts.
                </p>
              </div>
              <Badge tone={data?.haze.configured ? "completed" : "failed"}>
                Haze {data?.haze.configured ? "configured" : "not configured"}
                {data?.haze.pending
                  ? " · " + data.haze.pending + " pending"
                  : ""}
              </Badge>
            </div>
            {data?.haze.latest && (
              <div
                className={`lzt-haze-delivery ${data.haze.latest.status.toLowerCase()}`}
              >
                <div>
                  <small>LATEST HAZE DELIVERY</small>
                  <strong>{data.haze.latest.alertLabel}</strong>
                  <span>
                    {data.haze.latest.status} · {data.haze.latest.attempts}{" "}
                    attempt
                    {data.haze.latest.attempts === 1 ? "" : "s"} ·{" "}
                    {new Date(data.haze.latest.updatedAt).toLocaleString()}
                  </span>
                  {data.haze.latest.lastError && (
                    <code>{data.haze.latest.lastError}</code>
                  )}
                </div>
                {admin &&
                  data.haze.latest.status === "FAILED" &&
                  data.haze.latest.alertCode === "TEST_CUSTOM" && (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => command("/lzt-tracker/retry-test-alert")}
                    >
                      <RefreshCw /> Retry failed test
                    </Button>
                  )}
              </div>
            )}
            {data?.notifications?.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Alert price</th>
                      <th>Listed</th>
                      <th>Detected</th>
                      <th>Link</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.notifications.map((item) => (
                      <tr key={item.lztItemId}>
                        <td>
                          <b>{item.title}</b>
                        </td>
                        <td>
                          <strong className="listing-price lzt-alert-price">
                            {formatCurrencyMinor(
                              item.priceDisplayMinor,
                              resolvedCurrency,
                            )}
                          </strong>
                        </td>
                        <td>
                          <small>
                            {new Date(item.publishedAt).toLocaleString()}
                          </small>
                        </td>
                        <td>
                          <small>
                            {new Date(item.firstSeenAt).toLocaleString()}
                          </small>
                        </td>
                        <td>
                          <a
                            className="nfa-public-link"
                            href={item.publicUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open <ExternalLink />
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty
                title="No price notifications yet"
                body={`New accounts listed below ${thresholdLabel} will appear here automatically.`}
              />
            )}
          </section>
        </>
      ) : (
        <>
          <section className="lzt-status-grid">
            <article>
              <small>LAST POLL</small>
              <strong>{time(data?.state.lastSuccessfulPollAt)}</strong>
              <span>Next {time(data?.state.nextPollAt)}</span>
            </article>
            <article>
              <small>API LATENCY</small>
              <strong>
                {data?.state.apiLatencyMs ?? "—"}
                {data?.state.apiLatencyMs !== undefined ? " ms" : ""}
              </strong>
              <span>
                Per request · average {data?.metrics.averageApiLatencyMs ?? "—"}{" "}
                ms
              </span>
            </article>
            <article>
              <small>RATE LIMIT</small>
              <strong>{data?.state.rateLimitRemaining ?? "—"}</strong>
              <span>requests remaining</span>
            </article>
            <article>
              <small>DETECTION</small>
              <strong>
                {data?.metrics.averageDetectionLatencyMs ?? "—"}
                {data?.metrics.averageDetectionLatencyMs !== undefined
                  ? " ms"
                  : ""}
              </strong>
              <span>poll-to-save average</span>
            </article>
            <article>
              <small>TODAY'S AVERAGE ≤ $20</small>
              <strong>
                {data?.latestAverage?.averagePriceDisplayMinor == null
                  ? "No eligible listings"
                  : formatCurrencyMinor(
                      data.latestAverage.averagePriceDisplayMinor,
                      resolvedCurrency,
                    )}
              </strong>
              <span>
                {data?.latestAverage?.eligibleCount ?? 0} active listings
              </span>
            </article>
          </section>
          <section className="lzt-controls card">
            <div className="button-row">
              {running ? (
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => command("/lzt-tracker/stop")}
                >
                  <Square /> Stop
                </Button>
              ) : (
                <Button
                  disabled={busy}
                  onClick={() =>
                    command("/lzt-tracker/start", {
                      importBaseline: true,
                      notifyExisting: false,
                    })
                  }
                >
                  <Play /> Start
                </Button>
              )}
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => command("/lzt-tracker/restart")}
              >
                <RefreshCw /> Restart
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => command("/lzt-tracker/recalculate")}
              >
                <Activity /> Recalculate
              </Button>
              {admin && data?.sourceMode === "OFFICIAL_API" && (
                <>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => command("/lzt-tracker/test")}
                  >
                    Test API connection
                  </Button>
                  <div className="lzt-test-panel">
                    <label>
                      <span>Max price (USD)</span>
                      <input
                        aria-label="Maximum test price in USD"
                        type="number"
                        min="0.01"
                        max="1000"
                        step="0.01"
                        value={testMaximumPriceUsd}
                        onChange={(event) =>
                          setTestMaximumPriceUsd(event.target.value)
                        }
                      />
                    </label>
                    <label>
                      <span>Min games</span>
                      <input
                        aria-label="Minimum Steam games"
                        type="number"
                        min="0"
                        max="10000"
                        step="1"
                        value={testMinimumGames}
                        onChange={(event) =>
                          setTestMinimumGames(event.target.value)
                        }
                      />
                    </label>
                    <label>
                      <span>Min Rust hours</span>
                      <input
                        aria-label="Minimum Rust hours"
                        type="number"
                        min="0"
                        max="100000"
                        step="1"
                        value={testMinimumRustHours}
                        onChange={(event) =>
                          setTestMinimumRustHours(event.target.value)
                        }
                      />
                    </label>
                    <Button
                      variant="secondary"
                      disabled={busy || !testCriteriaValid}
                      onClick={sendLiveHazeTest}
                    >
                      Send custom test
                    </Button>
                  </div>
                </>
              )}
              {admin && (
                <div className="haze-message-panel">
                  <label>
                    <span>Direct Haze message</span>
                    <textarea
                      aria-label="Direct Haze message"
                      maxLength={2000}
                      rows={2}
                      value={manualHazeMessage}
                      onChange={(event) =>
                        setManualHazeMessage(event.target.value)
                      }
                      placeholder="Write a message for Haze to send…"
                    />
                  </label>
                  <Button
                    variant="secondary"
                    disabled={busy || !manualHazeMessage.trim()}
                    onClick={sendManualHazeMessage}
                  >
                    <Send /> Send with Haze
                  </Button>
                </div>
              )}
            </div>
            <small>
              Haze alerts at {thresholdLabel} or less, plus accounts above{" "}
              {highHoursMinimum.toLocaleString()} Rust hours at or below{" "}
              {highHoursThresholdLabel}. Public mode never bypasses login,
              CAPTCHA, or human-verification challenges.
            </small>
          </section>
          {data?.state.lastError && (
            <section className="lzt-error card">
              <b>{data.state.lastErrorCode}</b>
              <span>{data.state.lastError}</span>
            </section>
          )}
          <section className="table-card card lzt-listings">
            <div className="card-head price-toolbar">
              <div>
                <h2>Newest Rust listings</h2>
                <p>
                  Fast price/title/link delivery followed by games and
                  Rust-hours enrichment.
                </p>
              </div>
              <div className="nfa-filters">
                <label className="currency-picker lzt-currency-picker">
                  <span>
                    <Banknote /> Currency
                  </span>
                  <select
                    aria-label="LZT display currency"
                    value={displayCurrency}
                    onChange={(event) => setDisplayCurrency(event.target.value)}
                  >
                    {displayCurrencies.map((currency) => (
                      <option key={currency}>{currency}</option>
                    ))}
                  </select>
                </label>
                <SearchBox
                  value={search}
                  onChange={setSearch}
                  placeholder="Search titles…"
                />
                <select
                  aria-label="Sort LZT listings"
                  value={sort}
                  onChange={(event) => setSort(event.target.value)}
                >
                  <option value="newest">Newest</option>
                  <option value="price-asc">Price: low to high</option>
                  <option value="price-desc">Price: high to low</option>
                  <option value="hours-asc">Lowest hours</option>
                </select>
              </div>
            </div>
            {data?.listings.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Status</th>
                      <th aria-sort={priceSortDirection}>
                        <button
                          className={`sortable-table-heading ${priceSortDirection !== "none" ? "active" : ""}`}
                          type="button"
                          onClick={togglePriceSort}
                          title={`Sort by price shown in ${resolvedCurrency}`}
                        >
                          Price{" "}
                          {sort === "price-asc" ? (
                            <ArrowUp />
                          ) : sort === "price-desc" ? (
                            <ArrowDown />
                          ) : (
                            <ArrowUpDown />
                          )}
                        </button>
                      </th>
                      <th>Games</th>
                      <th>Inventory</th>
                      <th>Rust hours</th>
                      <th>Added / detected</th>
                      <th>Link</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.listings.map((item) => (
                      <tr key={item.lztItemId}>
                        <td>
                          <b>{item.title}</b>
                          {item.baseline && (
                            <small className="original-listing-price">
                              Historical baseline
                            </small>
                          )}
                        </td>
                        <td>
                          <span
                            className={`lzt-listing-state ${lztStateClass(item.itemState)}`}
                          >
                            {lztStateLabel(item.itemState)}
                          </span>
                        </td>
                        <td>
                          <strong className="listing-price">
                            {formatCurrencyMinor(
                              item.priceDisplayMinor,
                              resolvedCurrency,
                            )}
                          </strong>
                        </td>
                        <td>{item.gamesCount ?? "Unknown"}</td>
                        <td>
                          <LztInventoryValue
                            currency={resolvedCurrency}
                            cs2Minor={item.inventoryCs2DisplayMinor}
                            rustMinor={item.inventoryRustDisplayMinor}
                            totalMinor={item.inventoryTotalDisplayMinor}
                          />
                        </td>
                        <td>
                          {item.rustHours == null
                            ? "Unknown"
                            : item.rustHours.toLocaleString()}
                        </td>
                        <td>
                          <small>
                            {new Date(item.publishedAt).toLocaleString()}
                            <br />
                            Detected{" "}
                            {new Date(item.firstSeenAt).toLocaleTimeString()}
                          </small>
                        </td>
                        <td>
                          <a
                            className="nfa-public-link"
                            href={item.publicUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open <ExternalLink />
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty
                title="No LZT listings stored"
                body="Start the tracker to establish a historical baseline, then new listings will appear live."
              />
            )}
            {(data?.pagination.pages ?? 1) > 1 && (
              <footer className="price-pagination">
                <Button
                  variant="ghost"
                  disabled={page <= 1}
                  onClick={() => setPage((value) => value - 1)}
                >
                  <ArrowLeft /> Previous
                </Button>
                <span>
                  Page {page} of {data?.pagination.pages} ·{" "}
                  {data?.pagination.total} listings
                </span>
                <Button
                  variant="ghost"
                  disabled={page >= (data?.pagination.pages ?? 1)}
                  onClick={() => setPage((value) => value + 1)}
                >
                  Next <ArrowRight />
                </Button>
              </footer>
            )}
          </section>
        </>
      )}
    </div>
  );
}
