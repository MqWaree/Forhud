import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Navigate,
  NavLink,
  Route,
  Routes,
  useNavigate,
} from "react-router-dom";
import {
  Activity,
  ArrowRight,
  Bell,
  CheckCircle2,
  CheckCheck,
  Chrome,
  Clipboard,
  Columns3,
  Database,
  Download,
  ExternalLink,
  Filter,
  Globe2,
  History as HistoryIcon,
  LayoutDashboard,
  MapPin,
  LogOut,
  Menu,
  PanelLeft,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Scissors,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Square,
  Trash2,
  Users,
  Wifi,
  Zap,
} from "lucide-react";
import {
  api,
  type ExpandedLead,
  type Lead,
  type SearchResult,
  type Session,
} from "./api";
import SearcherPage from "./SearcherPage";
import LeadsPage from "./LeadsPage";
import AdminPage from "./AdminPage";
import { useAuth } from "./Auth";
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
import {
  leadStatuses,
  priorities,
  splitRows,
  splitWebsiteDiscordRows,
} from "@lead/shared";
const Funnel = Filter;
// Legacy page implementations remain during the data-model transition; routes use the expanded pages below.
void Searcher;
void Leads;

const nav = [
  ["Dashboard", "/", LayoutDashboard],
  ["Searcher", "/searcher", Search],
  ["Splitter", "/splitter", Scissors],
  ["Leads", "/leads", Funnel],
  ["My Leads", "/my-leads", Users],
  ["Location Checker", "/location", MapPin],
  ["History", "/history", HistoryIcon],
  ["Settings", "/settings", SettingsIcon],
] as const;
function useData() {
  const [sessions, setSessions] = useState<Session[]>([]),
    [leads, setLeads] = useState<ExpandedLead[]>([]),
    [locations, setLocations] = useState<any[]>([]),
    [health, setHealth] = useState<any>({}),
    [clients, setClients] = useState<string[]>([]),
    [notifications, setNotifications] = useState<
      Array<{
        id: string;
        title: string;
        body: string;
        readAt?: string | null;
        createdAt: string;
      }>
    >([]),
    [workspace, setWorkspace] = useState<any>({});
  const refresh = useCallback(async () => {
    const [a, b, c, d, e, f, g] = await Promise.allSettled([
      api.get<Session[]>("/search/sessions"),
      api.get<ExpandedLead[]>("/leads"),
      api.get<any[]>("/location"),
      api.get("/health"),
      api.get<string[]>("/clients"),
      api.get<any>("/workspace"),
      api.get<typeof notifications>("/notifications"),
    ]);
    if (a.status === "fulfilled") setSessions(a.value);
    if (b.status === "fulfilled") setLeads(b.value);
    if (c.status === "fulfilled") setLocations(c.value);
    if (d.status === "fulfilled") setHealth(d.value);
    if (e.status === "fulfilled") setClients(e.value);
    if (f.status === "fulfilled") setWorkspace(f.value);
    if (g.status === "fulfilled") setNotifications(g.value);
  }, []);
  useEffect(() => {
    void refresh();
    const es = new EventSource("/api/events");
    [
      "import",
      "scan-progress",
      "scan-complete",
      "lead-update",
      "location-complete",
    ].forEach((e) => es.addEventListener(e, () => void refresh()));
    return () => es.close();
  }, [refresh]);
  return {
    sessions,
    leads,
    locations,
    health,
    clients,
    notifications,
    workspace,
    refresh,
  };
}
type Ctx = ReturnType<typeof useData>;
let ctx: Ctx;
export default function App() {
  const { user, logout } = useAuth();
  ctx = useData();
  const [mobile, setMobile] = useState(false),
    [notificationsOpen, setNotificationsOpen] = useState(false),
    [toast, setToast] = useState("");
  const unreadNotifications = ctx.notifications.filter(
    (notification) => !notification.readAt,
  );
  useEffect(() => {
    const fn = (e: any) => {
      setToast(e.detail);
      setTimeout(() => setToast(""), 3000);
    };
    window.addEventListener("toast", fn);
    return () => window.removeEventListener("toast", fn);
  }, []);
  return (
    <div className="app">
      <aside className={`sidebar ${mobile ? "open" : ""}`}>
        <div className="brand">
          <img className="brand-logo" src="/fgp-logo.png" alt="FGP" />
          <div>
            <b>FGP</b>
            <small>Forhuds Panel</small>
          </div>
        </div>
        <nav>
          {nav.map(([name, to, I]) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              onClick={() => setMobile(false)}
            >
              <I />
              <span>{name}</span>
            </NavLink>
          ))}
          {user.role === "ADMIN" && (
            <>
              <div className="admin-nav-label">Administration</div>
              <NavLink to="/admin" onClick={() => setMobile(false)}>
                <ShieldCheck />
                <span>Control center</span>
              </NavLink>
            </>
          )}
        </nav>
        <div className="system">
          <p>
            <i className="dot green" />
            Database connected
          </p>
          <p>
            <i className="dot blue" />
            Extension listening
          </p>
          <small>v1.4.0 · {user.workspace.name}</small>
        </div>
      </aside>
      <main>
        <div className="identity-bar">
          <span className="identity-label">SCANNER ID</span>
          <b className="identity-id">
            {ctx.workspace.scannerId || user.workspace.scannerId}
          </b>
          <button
            className="identity-action"
            onClick={() => {
              void navigator.clipboard.writeText(
                ctx.workspace.scannerId || user.workspace.scannerId,
              );
              window.dispatchEvent(
                new CustomEvent("toast", { detail: "Scanner ID copied" }),
              );
            }}
          >
            <Clipboard /> <span>Copy</span>
          </button>
          <small>
            {ctx.workspace.connectedExtensions || 0} extensions online
          </small>
          <div className="notification-center">
            <button
              className="identity-action notification-trigger"
              aria-label="Notifications"
              aria-expanded={notificationsOpen}
              onClick={() => setNotificationsOpen((open) => !open)}
            >
              <Bell />
              {unreadNotifications.length > 0 && (
                <span>{Math.min(99, unreadNotifications.length)}</span>
              )}
            </button>
            {notificationsOpen && (
              <section className="notification-menu card">
                <header>
                  <div>
                    <b>Notifications</b>
                    <small>{unreadNotifications.length} unread</small>
                  </div>
                  <button
                    disabled={!unreadNotifications.length}
                    onClick={async () => {
                      await api.send("/notifications/read", "POST", {
                        ids: unreadNotifications.map((item) => item.id),
                      });
                      await ctx.refresh();
                    }}
                  >
                    <CheckCheck /> Mark read
                  </button>
                </header>
                <div>
                  {ctx.notifications.length ? (
                    ctx.notifications.slice(0, 12).map((notification) => (
                      <article
                        key={notification.id}
                        className={notification.readAt ? "read" : "unread"}
                      >
                        <i />
                        <span>
                          <b>{notification.title}</b>
                          <p>{notification.body}</p>
                          <small>
                            {new Date(notification.createdAt).toLocaleString()}
                          </small>
                        </span>
                      </article>
                    ))
                  ) : (
                    <p className="notification-empty">No notifications yet.</p>
                  )}
                </div>
              </section>
            )}
          </div>
          <span className="identity-spacer" />
          <div className="identity-user">
            <b>{user.username}</b>
            <small>{user.role.toLowerCase()}</small>
          </div>
          {!user.authBypassEnabled && (
            <button className="identity-action" onClick={() => void logout()}>
              <LogOut /> <span>Sign out</span>
            </button>
          )}
        </div>
        <button
          className="mobile-menu"
          aria-label={mobile ? "Close navigation menu" : "Open navigation menu"}
          aria-expanded={mobile}
          onClick={() => setMobile(!mobile)}
        >
          <Menu />
        </button>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/searcher" element={<SearcherPage />} />
          <Route path="/splitter" element={<Splitter />} />
          <Route
            path="/leads"
            element={<LeadsPage leads={ctx.leads} refresh={ctx.refresh} />}
          />
          <Route
            path="/my-leads"
            element={
              <LeadsPage
                leads={ctx.leads.filter(
                  (lead) => lead.assignedTo?.id === user.id,
                )}
                refresh={ctx.refresh}
              />
            }
          />
          <Route path="/location" element={<Locations />} />
          <Route path="/history" element={<History />} />
          <Route path="/settings" element={<Settings />} />
          {user.role === "ADMIN" && (
            <Route path="/admin" element={<AdminPage />} />
          )}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      {toast && (
        <div className="toast">
          <CheckCircle2 />
          {toast}
        </div>
      )}
    </div>
  );
}
const toast = (s: string) =>
  window.dispatchEvent(new CustomEvent("toast", { detail: s }));

function Dashboard() {
  const n = useNavigate();
  const websites = ctx.sessions.reduce((x, s) => x + s.results.length, 0),
    discord = ctx.sessions.reduce(
      (x, s) => x + s.results.reduce((y, r) => y + r.discordLinks.length, 0),
      0,
    );
  return (
    <section className="page">
      <PageHeader
        eyebrow="Intelligence overview"
        title="Welcome back"
        subtitle="Everything you need to manage your lead research — at a glance."
        actions={
          <Button onClick={() => n("/searcher")}>
            <Play /> Start scanning
          </Button>
        }
      />
      <div className="stats">
        <Stat
          label="Websites found"
          value={websites}
          detail="Captured from Chrome"
          icon={<Globe2 />}
        />
        <Stat
          label="Discord links"
          value={discord}
          detail="Unique invites detected"
          icon={<Wifi />}
        />
        <Stat
          label="Active leads"
          value={ctx.leads.length}
          detail="Across your funnel"
          icon={<Users />}
        />
        <Stat
          label="Search sessions"
          value={ctx.sessions.length}
          detail="Manual Google captures"
          icon={<HistoryIcon />}
        />
      </div>
      <div className="section-title">
        <div>
          <h2>Quick actions</h2>
          <p>Jump back into your research workflow.</p>
        </div>
      </div>
      <div className="quick-grid">
        {[
          [
            Search,
            "Start search",
            "Capture results with the extension",
            "/searcher",
          ],
          [Funnel, "Open leads", "Review and progress prospects", "/leads"],
          [
            Scissors,
            "Use splitter",
            "Clean structured lists quickly",
            "/splitter",
          ],
          [MapPin, "Check hosting", "Resolve hosting locations", "/location"],
        ].map(([I, t, d, to]: any) => (
          <button className="quick card" key={t} onClick={() => n(to)}>
            <span>
              <I />
            </span>
            <div>
              <b>{t}</b>
              <small>{d}</small>
            </div>
            <ArrowRight />
          </button>
        ))}
      </div>
      <div className="dashboard-grid">
        <article className="card table-card">
          <div className="card-head">
            <div>
              <h2>Recent searches</h2>
              <p>Latest Google result captures</p>
            </div>
            <Button variant="ghost" onClick={() => n("/history")}>
              View all <ArrowRight />
            </Button>
          </div>
          {ctx.sessions.length ? (
            <table>
              <thead>
                <tr>
                  <th>Query</th>
                  <th>Websites</th>
                  <th>Discord</th>
                  <th>Date</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {ctx.sessions.slice(0, 5).map((s) => (
                  <tr key={s.id}>
                    <td>
                      <b>{s.query}</b>
                    </td>
                    <td>{s.results.length}</td>
                    <td>
                      {s.results.reduce((n, r) => n + r.discordLinks.length, 0)}
                    </td>
                    <td>{new Date(s.createdAt).toLocaleDateString()}</td>
                    <td>
                      <Badge>{s.completedAt ? "Completed" : "Ready"}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty
              title="No searches yet"
              body="Install the extension and send a Google result page to begin."
            />
          )}
        </article>
        <article className="card status-card">
          <div className="card-head">
            <div>
              <h2>System status</h2>
              <p>Local services</p>
            </div>
            <ShieldCheck />
          </div>
          {[
            ["Chrome extension", "Listening", Chrome],
            [
              "Scraper engine",
              ctx.health.scraper?.healthy ? "Scrapling healthy" : "Offline",
              Activity,
            ],
            [
              "SQLite database",
              ctx.health.ok ? "Connected" : "Offline",
              Database,
            ],
          ].map(([a, b, I]: any) => (
            <div className="status-row" key={a}>
              <span>
                <I />
              </span>
              <div>
                <b>{a}</b>
                <small>{b}</small>
              </div>
              <i className={`dot ${b === "Offline" ? "red" : "green"}`} />
            </div>
          ))}
          <div className="security-note">
            <ShieldCheck />
            <span>
              <b>Protected crawler</b>
              <small>SSRF filters and response limits active</small>
            </span>
          </div>
        </article>
      </div>
    </section>
  );
}

function Searcher() {
  const session = ctx.sessions[0];
  const [detail, setDetail] = useState<SearchResult>();
  const total = session?.results.length || 0,
    done =
      session?.results.filter((r) =>
        ["Completed", "Failed", "Blocked", "Timeout"].includes(r.scanStatus),
      ).length || 0,
    discord =
      session?.results.reduce((n, r) => n + r.discordLinks.length, 0) || 0;
  async function scan() {
    if (!session) return;
    await api.send(`/search/${session.id}/scan`);
    toast(`Scanning ${total} websites.`);
    void ctx.refresh();
  }
  return (
    <section className="page">
      <PageHeader
        eyebrow="Discovery engine"
        title="Searcher"
        subtitle="Capture Google results and discover Discord communities."
        actions={
          <>
            <Button variant="secondary" onClick={() => ctx.refresh()}>
              <RefreshCw /> Refresh
            </Button>
            <Button disabled={!session} onClick={scan}>
              <Play /> Scan all
            </Button>
          </>
        }
      />
      <article className="connection card">
        <span className="extension-icon">
          <Chrome />
        </span>
        <div>
          <small>Chrome extension</small>
          <b>Ready for manual captures</b>
        </div>
        <Badge tone="connected">
          <i className="dot green" /> Connected
        </Badge>
        <div className="connection-meta">
          <span>
            Current search <b>{session?.query || "Waiting for results"}</b>
          </span>
          <span>
            API endpoint <b>forhud.shop</b>
          </span>
        </div>
      </article>
      <div className="stats compact">
        <Stat
          label="URLs received"
          value={total}
          detail="Organic results"
          icon={<Globe2 />}
        />
        <Stat
          label="Scanned"
          value={`${done} / ${total}`}
          detail="Processed pages"
          icon={<Zap />}
        />
        <Stat
          label="Discord links"
          value={discord}
          detail="Invites discovered"
          icon={<Wifi />}
        />
        <Stat
          label="Success rate"
          value={total ? `${Math.round((done / total) * 100)}%` : "—"}
          detail="Current session"
          icon={<Activity />}
        />
      </div>
      {session && (
        <article className="card scan-progress">
          <div>
            <b>Scan progress</b>
            <span>
              {done} of {total} processed
            </span>
          </div>
          <Progress value={total ? (done / total) * 100 : 0} />
        </article>
      )}
      <article className="card table-card">
        <div className="card-head">
          <div>
            <h2>Captured websites</h2>
            <p>
              {session
                ? `Results for “${session.query}”`
                : "No active search session"}
            </p>
          </div>
          <div>
            <Button
              variant="secondary"
              disabled={!session}
              onClick={() => session && api.send(`/search/${session.id}/stop`)}
            >
              <Square /> Stop
            </Button>
            <a className="btn secondary" href="/api/export/leads.csv">
              <Download /> Export
            </a>
          </div>
        </div>
        {session?.results.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Website</th>
                  <th>Position</th>
                  <th>Discord</th>
                  <th>Hosting location</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {session.results.map((r) => (
                  <tr key={r.id} onClick={() => setDetail(r)}>
                    <td>
                      <div className="domain-cell">
                        <span>{r.domain.hostname[0]?.toUpperCase()}</span>
                        <div>
                          <b>{r.domain.hostname}</b>
                          <small>{r.title || r.url}</small>
                        </div>
                      </div>
                    </td>
                    <td>#{r.position}</td>
                    <td>
                      {r.discordLinks[0] ? (
                        <a
                          href={r.discordLinks[0].url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {r.discordLinks[0].url.replace("https://", "")}
                        </a>
                      ) : (
                        <span className="muted">Not found</span>
                      )}
                    </td>
                    <td>{r.domain.location?.country || "Not checked"}</td>
                    <td>
                      <Badge>{r.scanStatus}</Badge>
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
            title="No search results received yet"
            body="Install the extension, perform a Google search normally, then choose Send Results."
            action={
              <Button variant="secondary">
                <Chrome /> Extension setup
              </Button>
            }
          />
        )}
      </article>
      {detail && (
        <Drawer
          title={detail.domain.hostname}
          onClose={() => setDetail(undefined)}
        >
          <div className="drawer-body">
            <Detail label="Original URL" value={detail.url} />
            <Detail label="Google position" value={`#${detail.position}`} />
            <Detail label="Scan status" value={detail.scanStatus} />
            <Detail
              label="Hosting location"
              value={detail.domain.location?.country || "Not checked"}
            />
            <Detail
              label="Discord links"
              value={
                detail.discordLinks.map((d) => d.url).join(", ") || "None found"
              }
            />
            {detail.error && <div className="error-box">{detail.error}</div>}
            <div className="drawer-actions">
              <a
                className="btn primary"
                href={detail.url}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink /> Open website
              </a>
              <Button
                variant="secondary"
                onClick={async () => {
                  await api.send(`/search/result/${detail.id}/rescan`);
                  toast("Website queued for rescan.");
                }}
              >
                <RotateCcw /> Rescan
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
function Splitter() {
  const [input, setInput] = useState(""),
    [mode, setMode] = useState<"COLON" | "WEBSITE_DISCORD" | "CUSTOM">("COLON"),
    [delimiter, setDelimiter] = useState(":"),
    [all, setAll] = useState(false),
    [ran, setRan] = useState(false);
  const data = useMemo(
    () =>
      ran
        ? mode === "WEBSITE_DISCORD"
          ? splitWebsiteDiscordRows(input)
          : {
              ...splitRows(input, mode === "COLON" ? ":" : delimiter, all),
              duplicates: 0,
            }
        : { rows: [], malformed: [], total: 0, duplicates: 0 },
    [input, mode, delimiter, all, ran],
  );
  const copy = (side: "left" | "right") => {
    void navigator.clipboard.writeText(
      data.rows.map((r) => r[side]).join("\n"),
    );
    toast(`${side === "left" ? "Left" : "Right"} column copied.`);
  };
  const exportCsv = () => {
    const text =
      "Left,Right\n" +
      data.rows
        .map(
          (r) =>
            `"${r.left.replaceAll('"', '""')}","${r.right.replaceAll('"', '""')}"`,
        )
        .join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    a.download = "split-results.csv";
    a.click();
    toast("CSV exported.");
  };
  return (
    <section className="page">
      <PageHeader
        eyebrow="Data utility"
        title="Splitter"
        subtitle="Separate structured data into individual columns."
      />
      <div className="split-grid">
        <article className="card split-input">
          <div className="card-head">
            <div>
              <h2>Source data</h2>
              <p>One record per line</p>
            </div>
            <Badge>{input.split(/\n/).filter(Boolean).length} rows</Badge>
          </div>
          <textarea
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setRan(false);
            }}
            placeholder={"john:password123\nhello:world\nabc:xyz"}
          />
          <div className="split-controls">
            <label>
              <small>Mode</small>
              <select
                value={mode}
                onChange={(event) => {
                  setMode(event.target.value as typeof mode);
                  setRan(false);
                }}
              >
                <option value="COLON">Colon (left:right)</option>
                <option value="WEBSITE_DISCORD">Website / Discord</option>
                <option value="CUSTOM">Custom delimiter</option>
              </select>
            </label>
            {mode === "CUSTOM" && (
              <label>
                <small>Custom delimiter</small>
                <input
                  value={delimiter}
                  maxLength={8}
                  onChange={(e) => setDelimiter(e.target.value)}
                />
              </label>
            )}
            {mode !== "WEBSITE_DISCORD" && (
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={all}
                  onChange={(e) => setAll(e.target.checked)}
                />
                <span />
                Split all occurrences
              </label>
            )}
          </div>
          <div className="button-row">
            <Button onClick={() => setRan(true)}>
              <Scissors /> Split data
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setInput("");
                setRan(false);
              }}
            >
              <Trash2 /> Clear
            </Button>
          </div>
        </article>
        <article className="card split-output">
          <div className="card-head">
            <div>
              <h2>Output preview</h2>
              <p>
                {ran
                  ? `${data.rows.length} valid · ${data.duplicates} duplicate · ${data.malformed.length} malformed`
                  : "Results appear here"}
              </p>
            </div>
            <div>
              <Button
                variant="ghost"
                disabled={!data.rows.length}
                onClick={() => copy("left")}
              >
                <Clipboard /> Copy left
              </Button>
              <Button
                variant="ghost"
                disabled={!data.rows.length}
                onClick={() => copy("right")}
              >
                <Clipboard /> Copy right
              </Button>
              <Button
                variant="secondary"
                disabled={!data.rows.length}
                onClick={exportCsv}
              >
                <Download /> CSV
              </Button>
            </div>
          </div>
          {data.rows.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>{mode === "WEBSITE_DISCORD" ? "Website" : "Left"}</th>
                    <th>{mode === "WEBSITE_DISCORD" ? "Discord" : "Right"}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r, i) => (
                    <tr key={i}>
                      <td>{i + 1}</td>
                      <td>{r.left}</td>
                      <td>{r.right}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="Ready to split"
              body="Paste structured rows, choose a delimiter, and run the splitter."
            />
          )}
          {data.malformed.length > 0 && (
            <div className="malformed">
              <b>Malformed rows</b>
              <pre>{data.malformed.join("\n")}</pre>
            </div>
          )}
        </article>
      </div>
    </section>
  );
}

function Leads() {
  const [view, setView] = useState<"table" | "kanban">("table"),
    [query, setQuery] = useState(""),
    [status, setStatus] = useState("All"),
    [detail, setDetail] = useState<Lead>();
  const filtered = ctx.leads.filter(
    (l) =>
      (status === "All" || l.status === status) &&
      l.domain.hostname.includes(query.toLowerCase()),
  );
  async function patch(id: string, data: any) {
    await api.send(`/leads/${id}`, "PATCH", data);
    toast("Lead updated.");
    await ctx.refresh();
  }
  async function add() {
    const url = prompt("Enter a public website URL");
    if (url) {
      await api.send("/leads", "POST", { url });
      toast("Lead added.");
      await ctx.refresh();
    }
  }
  return (
    <section className="page">
      <PageHeader
        eyebrow="Relationship workspace"
        title="Leads funnel"
        subtitle="Qualify, organize, and progress every discovered opportunity."
        actions={
          <>
            <a className="btn secondary" href="/api/export/leads.csv">
              <Download /> Export
            </a>
            <Button onClick={add}>
              <Plus /> Add lead
            </Button>
          </>
        }
      />
      <div className="toolbar card">
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder="Search domains…"
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option>All</option>
          {leadStatuses.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
        <div className="view-toggle">
          <button
            className={view === "table" ? "active" : ""}
            onClick={() => setView("table")}
          >
            <PanelLeft /> Table
          </button>
          <button
            className={view === "kanban" ? "active" : ""}
            onClick={() => setView("kanban")}
          >
            <Columns3 /> Kanban
          </button>
        </div>
        <span className="count">{filtered.length} leads</span>
      </div>
      {view === "table" ? (
        <article className="card table-card">
          {filtered.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Website</th>
                    <th>Discord</th>
                    <th>Hosting country</th>
                    <th>Search query</th>
                    <th>Status</th>
                    <th>Priority</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((l) => (
                    <tr key={l.id} onClick={() => setDetail(l)}>
                      <td>
                        <div className="domain-cell">
                          <span>{l.domain.hostname[0]?.toUpperCase()}</span>
                          <b>{l.domain.hostname}</b>
                        </div>
                      </td>
                      <td>
                        {l.searchResult?.discordLinks[0]?.url.replace(
                          "https://",
                          "",
                        ) || <span className="muted">—</span>}
                      </td>
                      <td>{l.domain.location?.country || "Unknown"}</td>
                      <td>
                        {l.searchResult?.searchSession?.query || "Manual"}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <select
                          value={l.status}
                          onChange={(e) =>
                            patch(l.id, { status: e.target.value })
                          }
                        >
                          {leadStatuses.map((x) => (
                            <option key={x}>{x}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <Badge tone={l.priority.toLowerCase()}>
                          {l.priority}
                        </Badge>
                      </td>
                      <td>{new Date(l.updatedAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="No leads yet"
              body="Scanned websites and manually added prospects will appear here."
              action={
                <Button onClick={add}>
                  <Plus /> Add first lead
                </Button>
              }
            />
          )}
        </article>
      ) : (
        <div className="kanban">
          {leadStatuses.slice(0, 7).map((s) => (
            <section
              key={s}
              className="kanban-column"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                const id = e.dataTransfer.getData("text/plain");
                if (id) void patch(id, { status: s });
              }}
            >
              <header>
                <span>{s}</span>
                <b>{filtered.filter((l) => l.status === s).length}</b>
              </header>
              {filtered
                .filter((l) => l.status === s)
                .map((l) => (
                  <article
                    draggable
                    onDragStart={(e) =>
                      e.dataTransfer.setData("text/plain", l.id)
                    }
                    key={l.id}
                    className="lead-card card"
                    onClick={() => setDetail(l)}
                  >
                    <div>
                      <span className="site-icon">
                        {l.domain.hostname[0]?.toUpperCase()}
                      </span>
                      <Badge tone={l.priority.toLowerCase()}>
                        {l.priority}
                      </Badge>
                    </div>
                    <b>{l.domain.hostname}</b>
                    <small>
                      {l.searchResult?.discordLinks[0]?.url.replace(
                        "https://",
                        "",
                      ) || "No Discord link"}
                    </small>
                    <footer>
                      <span>{l.domain.location?.country || "Unknown"}</span>
                      <span>
                        {l.searchResult?.searchSession?.query || "Manual"}
                      </span>
                    </footer>
                  </article>
                ))}
            </section>
          ))}
        </div>
      )}
      {detail && (
        <Drawer
          title={detail.domain.hostname}
          onClose={() => setDetail(undefined)}
        >
          <div className="drawer-body">
            <div className="form-grid">
              <label>
                <small>Status</small>
                <select
                  value={detail.status}
                  onChange={(e) => {
                    void patch(detail.id, { status: e.target.value });
                    setDetail({ ...detail, status: e.target.value });
                  }}
                >
                  {leadStatuses.map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </label>
              <label>
                <small>Priority</small>
                <select
                  value={detail.priority}
                  onChange={(e) => {
                    void patch(detail.id, { priority: e.target.value });
                    setDetail({ ...detail, priority: e.target.value });
                  }}
                >
                  {priorities.map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </label>
            </div>
            <Detail
              label="Discord"
              value={
                detail.searchResult?.discordLinks
                  .map((d) => d.url)
                  .join(", ") || "None"
              }
            />
            <Detail
              label="Hosting location"
              value={
                [detail.domain.location?.city, detail.domain.location?.country]
                  .filter(Boolean)
                  .join(", ") || "Not checked"
              }
            />
            <Detail
              label="Original search"
              value={
                detail.searchResult?.searchSession?.query || "Added manually"
              }
            />
            <label>
              <small>Notes</small>
              <textarea
                className="notes"
                defaultValue={detail.notes}
                onBlur={(e) => void patch(detail.id, { notes: e.target.value })}
              />
            </label>
            <div className="timeline">
              <h3>Activity</h3>
              {detail.activities.map((a) => (
                <div key={a.id}>
                  <i />
                  <span>
                    <b>{a.description}</b>
                    <small>{new Date(a.createdAt).toLocaleString()}</small>
                  </span>
                </div>
              ))}
            </div>
            <div className="drawer-actions">
              <a
                className="btn primary"
                href={
                  detail.searchResult?.url ||
                  `https://${detail.domain.hostname}`
                }
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink /> Open website
              </a>
              <Button
                variant="danger"
                onClick={async () => {
                  if (confirm("Delete this lead?")) {
                    await api.send(`/leads/${detail.id}`, "DELETE");
                    setDetail(undefined);
                    void ctx.refresh();
                  }
                }}
              >
                <Trash2 /> Delete
              </Button>
            </div>
          </div>
        </Drawer>
      )}
    </section>
  );
}

function Locations() {
  const [query, setQuery] = useState(""),
    [busy, setBusy] = useState(false);
  const rows = ctx.locations.filter((d) =>
    d.hostname.includes(query.toLowerCase()),
  );
  const checked = rows.filter((d) => d.location),
    countries = new Set(rows.map((d) => d.location?.country).filter(Boolean));
  async function check() {
    setBusy(true);
    try {
      const r = await api.send<any>("/location/check", "POST", {});
      toast(`Hosting lookup completed: ${r.checked} checked.`);
      await ctx.refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="page">
      <PageHeader
        eyebrow="Infrastructure intelligence"
        title="Hosting location"
        subtitle="Identify where discovered websites are hosted — not the physical location of their owners."
        actions={
          <>
            <a className="btn secondary" href="/api/export/leads.csv">
              <Download /> Export CSV
            </a>
            <Button disabled={busy || !rows.length} onClick={check}>
              <MapPin /> {busy ? "Checking…" : "Check all"}
            </Button>
          </>
        }
      />
      <div className="notice">
        <ShieldCheck />
        <div>
          <b>Hosting infrastructure only</b>
          <span>
            Results are derived from DNS and IP geolocation and may reflect a
            CDN or hosting provider.
          </span>
        </div>
      </div>
      <div className="stats compact">
        <Stat
          label="Domains checked"
          value={checked.length}
          detail={`${rows.length} discovered`}
          icon={<Globe2 />}
        />
        <Stat
          label="Countries"
          value={countries.size}
          detail="Unique locations"
          icon={<MapPin />}
        />
        <Stat
          label="Unknown"
          value={rows.length - checked.length}
          detail="Awaiting lookup"
          icon={<Filter />}
        />
        <Stat
          label="Failed"
          value={0}
          detail="Retry available"
          icon={<Activity />}
        />
      </div>
      <article className="card table-card">
        <div className="card-head">
          <div>
            <h2>Domain infrastructure</h2>
            <p>Cached DNS and geolocation results</p>
          </div>
          <SearchBox
            value={query}
            onChange={setQuery}
            placeholder="Search domains…"
          />
        </div>
        {rows.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Domain</th>
                  <th>IP address</th>
                  <th>Country</th>
                  <th>City</th>
                  <th>Hosting provider</th>
                  <th>Last checked</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <b>{d.hostname}</b>
                    </td>
                    <td className="mono">{d.location?.ipAddress || "—"}</td>
                    <td>
                      {d.location?.countryCode && (
                        <span className="flag">{d.location.countryCode}</span>
                      )}
                      {d.location?.country || "Unknown"}
                    </td>
                    <td>{d.location?.city || "—"}</td>
                    <td>{d.location?.provider || "—"}</td>
                    <td>
                      {d.location
                        ? new Date(d.location.checkedAt).toLocaleDateString()
                        : "Never"}
                    </td>
                    <td>
                      <Badge>{d.location ? "Completed" : "Queued"}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="No domains discovered"
            body="Captured and manually added websites will appear here."
          />
        )}
      </article>
    </section>
  );
}

function History() {
  const [detail, setDetail] = useState<Session>();
  return (
    <section className="page">
      <PageHeader
        eyebrow="Research archive"
        title="Search history"
        subtitle="Review every result capture and its discovery outcome."
        actions={
          <a className="btn secondary" href="/api/export/history.csv">
            <Download /> Export history
          </a>
        }
      />
      <article className="card table-card">
        {ctx.sessions.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Search query</th>
                  <th>URLs found</th>
                  <th>Discord links</th>
                  <th>Leads created</th>
                  <th>Duration</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {ctx.sessions.map((s) => (
                  <tr key={s.id} onClick={() => setDetail(s)}>
                    <td>{new Date(s.createdAt).toLocaleString()}</td>
                    <td>
                      <b>{s.query}</b>
                    </td>
                    <td>{s.results.length}</td>
                    <td>
                      {s.results.reduce((n, r) => n + r.discordLinks.length, 0)}
                    </td>
                    <td>
                      {
                        s.results.filter((r) => r.scanStatus === "Completed")
                          .length
                      }
                    </td>
                    <td>
                      {s.completedAt
                        ? `${Math.round((new Date(s.completedAt).getTime() - new Date(s.createdAt).getTime()) / 1000)}s`
                        : "—"}
                    </td>
                    <td>
                      <Badge>{s.completedAt ? "Completed" : "Ready"}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="No searches yet"
            body="Google result captures from the Chrome extension will be archived here."
          />
        )}
      </article>
      {detail && (
        <Drawer title={detail.query} onClose={() => setDetail(undefined)}>
          <div className="drawer-body">
            <Detail
              label="Captured"
              value={new Date(detail.createdAt).toLocaleString()}
            />
            <Detail
              label="Source"
              value="Manual Google results via Chrome extension"
            />
            <Detail label="Websites" value={String(detail.results.length)} />
            <Detail
              label="Discord links"
              value={String(
                detail.results.reduce((n, r) => n + r.discordLinks.length, 0),
              )}
            />
            <div className="mini-list">
              {detail.results.map((r) => (
                <div key={r.id}>
                  <span>
                    <b>{r.domain.hostname}</b>
                    <small>Google position #{r.position}</small>
                  </span>
                  <Badge>{r.scanStatus}</Badge>
                </div>
              ))}
            </div>
          </div>
        </Drawer>
      )}
    </section>
  );
}

function Settings() {
  const { user } = useAuth();
  const [data, setData] = useState<any>(user.role === "ADMIN" ? undefined : {});
  useEffect(() => {
    if (user.role === "ADMIN") api.get("/settings").then(setData);
  }, [user.role]);
  if (!data)
    return (
      <section className="page">
        <div className="loading">
          <RefreshCw /> Loading settings…
        </div>
      </section>
    );
  const set = (k: string, v: any) => setData({ ...data, [k]: v });
  async function save() {
    await api.send("/settings", "PATCH", data);
    toast("Settings saved.");
  }
  return (
    <section className="page">
      <PageHeader
        eyebrow="Workspace controls"
        title="Settings"
        subtitle="Tune how FGP searches, scans, and stores your research."
        actions={
          user.role === "ADMIN" ? (
            <Button onClick={save}>
              <Save /> Save workspace settings
            </Button>
          ) : undefined
        }
      />
      <div className="settings-grid">
        <AccountSettings />
        {user.role === "ADMIN" && (
          <>
            <article className="card settings-section">
              <header>
                <span>
                  <SettingsIcon />
                </span>
                <div>
                  <h2>General</h2>
                  <p>Workspace preferences</p>
                </div>
              </header>
              <label>
                <span>
                  <b>Theme</b>
                  <small>Application appearance</small>
                </span>
                <select disabled>
                  <option>Dark</option>
                </select>
              </label>
              <label>
                <span>
                  <b>Default lead status</b>
                  <small>Applied to new discoveries</small>
                </span>
                <select
                  value={data.defaultLeadStatus}
                  onChange={(e) => set("defaultLeadStatus", e.target.value)}
                >
                  {leadStatuses.map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </label>
            </article>
            <article className="card settings-section">
              <header>
                <span>
                  <Zap />
                </span>
                <div>
                  <h2>Searcher</h2>
                  <p>Responsible crawler limits</p>
                </div>
              </header>
              <NumberSetting
                label="Crawler concurrency"
                detail="Maximum parallel domain scans"
                value={data.crawlerConcurrency}
                onChange={(v) => set("crawlerConcurrency", v)}
              />
              <label>
                <span>
                  <b>Adaptive concurrency</b>
                  <small>
                    Reduce pressure on slow or rate-limited sites, then recover
                    automatically
                  </small>
                </span>
                <input
                  type="checkbox"
                  checked={data.adaptiveConcurrency}
                  onChange={(e) => set("adaptiveConcurrency", e.target.checked)}
                />
              </label>
              <NumberSetting
                label="Timeout (seconds)"
                detail="Maximum per request"
                value={data.timeoutSeconds}
                onChange={(v) => set("timeoutSeconds", v)}
              />
              <NumberSetting
                label="Retries"
                detail="Attempts after transient errors"
                value={data.retries}
                onChange={(v) => set("retries", v)}
              />
              <label>
                <span>
                  <b>Scraping engine</b>
                  <small>Specialized page fetching and parsing</small>
                </span>
                <Badge>Scrapling</Badge>
              </label>
              <label>
                <span>
                  <b>Dynamic fallback</b>
                  <small>Render JavaScript only for empty page shells</small>
                </span>
                <input
                  type="checkbox"
                  checked={data.dynamicFallback}
                  onChange={(e) => set("dynamicFallback", e.target.checked)}
                />
              </label>
              <label>
                <span>
                  <b>Respect robots.txt</b>
                  <small>Honor public crawling instructions</small>
                </span>
                <input
                  type="checkbox"
                  checked={data.robotsRespect}
                  onChange={(e) => set("robotsRespect", e.target.checked)}
                />
              </label>
              <label>
                <span>
                  <b>Deep scan</b>
                  <small>Follow selected same-domain pages</small>
                </span>
                <input
                  type="checkbox"
                  checked={data.deepScan}
                  onChange={(e) => set("deepScan", e.target.checked)}
                />
              </label>
              <NumberSetting
                label="Max pages per domain"
                detail="Deep scan safety limit"
                value={data.maxPages}
                onChange={(v) => set("maxPages", v)}
              />
              <NumberSetting
                label="Maximum depth"
                detail="Internal link distance"
                value={data.maxDepth}
                onChange={(v) => set("maxDepth", v)}
              />
            </article>
            <article className="card settings-section">
              <header>
                <span>
                  <Chrome />
                </span>
                <div>
                  <h2>Extension</h2>
                  <p>Local companion status</p>
                </div>
              </header>
              <label>
                <span>
                  <b>Connection status</b>
                  <small>Chrome companion</small>
                </span>
                <Badge>Connected</Badge>
              </label>
              <label>
                <span>
                  <b>FGP API URL</b>
                  <small>Extension destination</small>
                </span>
                <code>https://forhud.shop/api</code>
              </label>
              <div className="setup-steps">
                <b>Load unpacked extension</b>
                <ol>
                  <li>
                    Open <code>chrome://extensions</code>
                  </li>
                  <li>Enable Developer mode</li>
                  <li>
                    Load <code>apps/extension/dist</code>
                  </li>
                </ol>
              </div>
            </article>
            <article className="card settings-section danger-zone">
              <header>
                <span>
                  <Database />
                </span>
                <div>
                  <h2>Data</h2>
                  <p>Backups and workspace storage</p>
                </div>
              </header>
              <a className="btn secondary" href="/api/export/leads.csv">
                <Download /> Export leads
              </a>
              <p>
                Destructive database actions are intentionally not exposed
                without a backup workflow.
              </p>
              <label>
                <span>
                  <b>Automatic backups</b>
                  <small>Run snapshot maintenance at startup and hourly</small>
                </span>
                <input
                  type="checkbox"
                  checked={data.automaticBackups}
                  onChange={(event) =>
                    set("automaticBackups", event.target.checked)
                  }
                />
              </label>
              <label>
                <span>
                  <b>Frequency</b>
                  <small>Automatic snapshot interval</small>
                </span>
                <select
                  value={data.backupFrequency}
                  onChange={(event) =>
                    set("backupFrequency", event.target.value)
                  }
                >
                  <option value="DAILY">Daily</option>
                  <option value="WEEKLY">Weekly</option>
                </select>
              </label>
              <label>
                <span>
                  <b>Preferred time</b>
                  <small>Local server time</small>
                </span>
                <input
                  type="time"
                  value={data.backupTime}
                  onChange={(event) => set("backupTime", event.target.value)}
                />
              </label>
              <NumberSetting
                label="Daily retention"
                detail="Automatic daily copies to keep"
                value={data.backupRetentionDaily}
                onChange={(value) => set("backupRetentionDaily", value)}
              />
              <NumberSetting
                label="Weekly retention"
                detail="Automatic weekly copies to keep"
                value={data.backupRetentionWeekly}
                onChange={(value) => set("backupRetentionWeekly", value)}
              />
            </article>
          </>
        )}
      </div>
    </section>
  );
}

function AccountSettings() {
  const { user, refresh } = useAuth();
  const [username, setUsername] = useState(user.username);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  return (
    <>
      <article className="card settings-section">
        <header>
          <span>
            <Users />
          </span>
          <div>
            <h2>Account</h2>
            <p>Your profile and workspace role</p>
          </div>
        </header>
        <label>
          <span>
            <b>Username</b>
            <small>Used to sign in</small>
          </span>
          <input
            value={username}
            maxLength={32}
            pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            spellCheck={false}
          />
        </label>
        <label>
          <span>
            <b>Role</b>
            <small>Managed by an administrator</small>
          </span>
          <Badge>{user.role}</Badge>
        </label>
        <Button
          variant="secondary"
          onClick={async () => {
            await api.send("/auth/account", "PATCH", { username });
            await refresh();
            toast("Profile updated.");
          }}
        >
          <Save /> Save profile
        </Button>
      </article>
      <article className="card settings-section">
        <header>
          <span>
            <ShieldCheck />
          </span>
          <div>
            <h2>Password</h2>
            <p>Change your sign-in secret</p>
          </div>
        </header>
        <label>
          <span>
            <b>Current password</b>
          </span>
          <input
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </label>
        <label>
          <span>
            <b>New password</b>
          </span>
          <input
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </label>
        <label>
          <span>
            <b>Confirm password</b>
          </span>
          <input
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </label>
        <Button
          variant="secondary"
          onClick={async () => {
            await api.send("/auth/change-password", "POST", {
              currentPassword,
              newPassword,
              confirmPassword,
            });
            setCurrentPassword("");
            setNewPassword("");
            setConfirmPassword("");
            toast("Password changed.");
          }}
        >
          <ShieldCheck /> Change password
        </Button>
      </article>
    </>
  );
}
function NumberSetting({
  label,
  detail,
  value,
  onChange,
}: {
  label: string;
  detail: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label>
      <span>
        <b>{label}</b>
        <small>{detail}</small>
      </span>
      <input
        className="number"
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
