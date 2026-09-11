import {
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowRight,
  ArrowUpDown,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Columns3,
  Copy,
  Download,
  ExternalLink,
  Globe,
  Mail,
  MessageCircle,
  PanelLeft,
  Plus,
  Save,
  Search,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { leadStatuses, normalizeDiscordUrl, priorities } from "@lead/shared";
import { api, type ExpandedLead, type OutreachTemplate } from "./api";
import { outreachValues, renderOutreachTemplate } from "./outreach";
import { useAuth } from "./Auth";
import { Badge, Button, Drawer, Empty, SearchBox } from "./components";

const notify = (message: string) =>
  window.dispatchEvent(new CustomEvent("toast", { detail: message }));
const leadDiscordUrl = (lead: ExpandedLead) =>
  normalizeDiscordUrl(
    lead.discordInvite || lead.scannerResult?.discordLinks?.[0]?.url || "",
  );
type ContactKind = "discord" | "telegram" | "email" | "website" | "none";
type LeadContact = { kind: ContactKind; label: string; href?: string };
const contactKindLabels: Record<ContactKind, string> = {
  discord: "Discord",
  telegram: "Telegram",
  email: "Email",
  website: "Website",
  none: "Contact",
};
/**
 * The single best way to reach a lead, in the product's contact hierarchy:
 * Discord, then Telegram, then email, then the website as a last resort.
 */
const leadContact = (lead: ExpandedLead): LeadContact => {
  const discord = leadDiscordUrl(lead);
  if (discord)
    return {
      kind: "discord",
      label: discord.replace(/^https?:\/\//i, ""),
      href: discord,
    };
  const telegram = (lead.telegram || "").trim();
  if (telegram) {
    const handle = telegram
      .replace(/^https?:\/\/(www\.)?t\.me\//i, "")
      .replace(/^@/, "");
    return {
      kind: "telegram",
      label: `@${handle}`,
      href: `https://t.me/${handle}`,
    };
  }
  const email = (lead.email || "").trim();
  if (email) return { kind: "email", label: email, href: `mailto:${email}` };
  const website = (lead.website || "").trim();
  if (website)
    return {
      kind: "website",
      label: website.replace(/^https?:\/\//i, "").replace(/\/$/, ""),
      href: website,
    };
  return { kind: "none", label: "No contact yet" };
};
function ContactIcon({ kind }: { kind: ContactKind }) {
  if (kind === "discord") return <MessageCircle aria-hidden="true" />;
  if (kind === "telegram") return <Send aria-hidden="true" />;
  if (kind === "email") return <Mail aria-hidden="true" />;
  return <Globe aria-hidden="true" />;
}
const leadRustProducts = (lead: ExpandedLead) =>
  lead.scannerResult?.rustProductCount ?? 0;
const stageSlug = (status: string) => status.toLowerCase().replace(/\s+/g, "-");
const priorityRank: Record<string, number> = { High: 0, Medium: 1, Low: 2 };
const shortDate = (value: string) =>
  new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
type SortKey = "lead" | "status" | "priority" | "updated";
/** Short relative age for table rows: "now", "12m", "3h", "5d", then a date. */
const relativeTime = (value: string) => {
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d`;
  return shortDate(value);
};
/** The next stage in the funnel, or undefined for terminal stages. */
const nextStage = (status: string) => {
  const terminal = new Set(["Won", "Lost", "Ignore"]);
  if (terminal.has(status)) return undefined;
  const index = leadStatuses.indexOf(status as (typeof leadStatuses)[number]);
  return index >= 0 ? leadStatuses[index + 1] : undefined;
};
const initials = (name: string) =>
  name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || name.slice(0, 2).toUpperCase();
function PriorityMark({
  priority,
  showLabel = false,
}: {
  priority: string;
  showLabel?: boolean;
}) {
  return (
    <span
      className={`priority-mark ${priority.toLowerCase()}`}
      title={showLabel ? undefined : `${priority} priority`}
      aria-label={showLabel ? undefined : `${priority} priority`}
    >
      <span className="bars" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {showLabel && priority}
    </span>
  );
}
export default function LeadsPage({
  leads,
  refresh,
}: {
  leads: ExpandedLead[];
  refresh: () => Promise<void>;
}) {
  const { user } = useAuth();
  const canAssign = user.role === "ADMIN" || user.role === "MANAGER";
  const [query, setQuery] = useState(""),
    [view, setView] = useState<"table" | "kanban">("table"),
    [status, setStatus] = useState("All"),
    [tag, setTag] = useState("All"),
    [detail, setDetail] = useState<ExpandedLead>(),
    [draft, setDraft] = useState<ExpandedLead>(),
    [tagText, setTagText] = useState(""),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [team, setTeam] = useState<Array<{ id: string; username: string }>>([]),
    [draggingId, setDraggingId] = useState<string>(),
    [dropStatus, setDropStatus] = useState<string>(),
    [recentlyDroppedId, setRecentlyDroppedId] = useState<string>(),
    [moveSearch, setMoveSearch] = useState(""),
    [moveSearchOpen, setMoveSearchOpen] = useState(false),
    [moveActiveIndex, setMoveActiveIndex] = useState(0),
    [moveLeadId, setMoveLeadId] = useState(""),
    [moveDestination, setMoveDestination] = useState(""),
    [movingLeadId, setMovingLeadId] = useState<string>(),
    [optimisticStatuses, setOptimisticStatuses] = useState<
      Record<string, string>
    >({}),
    [preview, setPreview] = useState<{
      lead: ExpandedLead;
      top: number;
      left: number;
    }>();
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "updated",
    dir: "desc",
  });
  const [highlightedColumn, setHighlightedColumn] = useState<string>();
  const [expandedEmpty, setExpandedEmpty] = useState<Set<string>>(new Set());
  const toggleEmptyColumn = (leadStatus: string) =>
    setExpandedEmpty((current) => {
      const next = new Set(current);
      if (next.has(leadStatus)) next.delete(leadStatus);
      else next.add(leadStatus);
      return next;
    });
  const [templates, setTemplates] = useState<OutreachTemplate[]>([]);
  const [workspaceName, setWorkspaceName] = useState("");
  const [outreachTemplateId, setOutreachTemplateId] = useState("");
  const [outreachText, setOutreachText] = useState("");
  const [outreachDirty, setOutreachDirty] = useState(false);
  const [outreachSending, setOutreachSending] = useState(false);
  const outreachSeed = useRef("");
  const columnRefs = useRef(new Map<string, HTMLElement>());
  const filtersActive =
    query.trim() !== "" || status !== "All" || tag !== "All";
  const clearFilters = () => {
    setQuery("");
    setStatus("All");
    setTag("All");
  };
  const toggleSort = (key: SortKey) =>
    setSort((current) =>
      current.key === key
        ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "updated" ? "desc" : "asc" },
    );
  const jumpToColumn = (leadStatus: string) => {
    columnRefs.current.get(leadStatus)?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "start",
    });
    setHighlightedColumn(leadStatus);
    window.setTimeout(
      () =>
        setHighlightedColumn((current) =>
          current === leadStatus ? undefined : current,
        ),
      900,
    );
  };
  useEffect(() => {
    if (canAssign) void api.get<typeof team>("/team/users").then(setTeam);
  }, [canAssign]);
  useEffect(() => {
    void api
      .get<OutreachTemplate[]>("/outreach/templates")
      .then(setTemplates)
      .catch(() => undefined);
    void api
      .get<{ name?: string }>("/workspace")
      .then((workspace) => setWorkspaceName(workspace?.name || ""))
      .catch(() => undefined);
  }, []);
  const activeTemplate =
    templates.find((template) => template.id === outreachTemplateId) ??
    templates[0];
  const drawerContact = detail ? leadContact(detail) : undefined;
  // Rebuild the draft when the lead or template changes, but never throw away
  // text the operator has already edited for this lead.
  useEffect(() => {
    if (!detail || !activeTemplate) return;
    const seed = `${detail.id}|${activeTemplate.id}`;
    if (seed === outreachSeed.current && outreachDirty) return;
    outreachSeed.current = seed;
    setOutreachDirty(false);
    setOutreachText(
      renderOutreachTemplate(
        activeTemplate.body,
        outreachValues(detail, {
          sender: user.username,
          workspace: workspaceName,
          contact: drawerContact?.href ? drawerContact.label : "",
        }),
      ),
    );
  }, [detail, activeTemplate, workspaceName, user.username]);
  async function copyOutreach() {
    try {
      await navigator.clipboard.writeText(outreachText);
      notify("Message copied.");
    } catch {
      notify("Copy failed. Select the text and copy it manually.");
    }
  }
  async function markOutreachSent() {
    if (!draft || !outreachText.trim() || outreachSending) return;
    const contact = leadContact(draft);
    setOutreachSending(true);
    try {
      const saved = await api.send<ExpandedLead>(
        `/leads/${draft.id}/outreach`,
        "POST",
        {
          channel: contact.kind === "none" ? "other" : contact.kind,
          message: outreachText.trim(),
          templateName: activeTemplate?.name,
        },
      );
      setDetail(saved);
      setDraft(saved);
      notify("Outreach logged. Lead marked as Contacted.");
      await refresh();
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : "Outreach could not be logged.",
      );
    } finally {
      setOutreachSending(false);
    }
  }
  const tags = useMemo(
    () =>
      [
        ...new Set(leads.flatMap((l) => l.tags?.map((t) => t.tag.name) || [])),
      ].sort(),
    [leads],
  );
  useEffect(() => {
    setOptimisticStatuses((current) => {
      const next = { ...current };
      let changed = false;
      for (const [id, nextStatus] of Object.entries(current)) {
        if (leads.find((lead) => lead.id === id)?.status === nextStatus) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [leads]);
  const visibleLeads = useMemo(
    () =>
      leads.map((lead) => {
        const optimisticStatus = optimisticStatuses[lead.id];
        return optimisticStatus ? { ...lead, status: optimisticStatus } : lead;
      }),
    [leads, optimisticStatuses],
  );
  // One lowercased search string per lead, rebuilt only when the lead list
  // changes, so typing in a search box does not re-join eight fields per lead
  // on every keystroke.
  const leadHaystacks = useMemo(() => {
    const map = new Map<string, string>();
    for (const lead of leads)
      map.set(
        lead.id,
        [
          lead.domain.hostname,
          lead.companyName,
          lead.contactName,
          lead.email,
          lead.website,
          lead.discordInvite,
          leadDiscordUrl(lead),
          lead.telegram,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase(),
      );
    return map;
  }, [leads]);
  const matchesLeadSearch = useCallback(
    (lead: ExpandedLead, value: string) => {
      const needles = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (!needles.length) return true;
      const haystack = leadHaystacks.get(lead.id) ?? "";
      return needles.every((needle) => haystack.includes(needle));
    },
    [leadHaystacks],
  );
  // Leads matching the search and tag filters, before the stage filter, so the
  // stage strip can show how many leads sit in each stage for this search.
  const baseFiltered = useMemo(
    () =>
      visibleLeads.filter(
        (lead) =>
          (tag === "All" || lead.tags?.some((item) => item.tag.name === tag)) &&
          matchesLeadSearch(lead, query),
      ),
    [visibleLeads, tag, query, matchesLeadSearch],
  );
  const stageCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const lead of baseFiltered)
      counts.set(lead.status, (counts.get(lead.status) ?? 0) + 1);
    return counts;
  }, [baseFiltered]);
  const contactableCount = useMemo(
    () => leads.filter((lead) => leadContact(lead).kind !== "none").length,
    [leads],
  );
  const filtered = useMemo(
    () =>
      status === "All"
        ? baseFiltered
        : baseFiltered.filter((lead) => lead.status === status),
    [baseFiltered, status],
  );
  const sortedLeads = useMemo(() => {
    const direction = sort.dir === "asc" ? 1 : -1;
    const name = (lead: ExpandedLead) =>
      (lead.companyName || lead.domain.hostname).toLowerCase();
    return [...filtered].sort((left, right) => {
      let order = 0;
      if (sort.key === "lead") order = name(left).localeCompare(name(right));
      else if (sort.key === "status")
        order =
          leadStatuses.indexOf(left.status as (typeof leadStatuses)[number]) -
          leadStatuses.indexOf(right.status as (typeof leadStatuses)[number]);
      else if (sort.key === "priority")
        order =
          (priorityRank[left.priority] ?? 9) -
          (priorityRank[right.priority] ?? 9);
      else order = left.updatedAt.localeCompare(right.updatedAt);
      return order * direction || name(left).localeCompare(name(right));
    });
  }, [filtered, sort]);
  const leadsByStatus = useMemo(() => {
    const map = new Map<string, ExpandedLead[]>();
    for (const lead of filtered) {
      const column = map.get(lead.status);
      if (column) column.push(lead);
      else map.set(lead.status, [lead]);
    }
    return map;
  }, [filtered]);
  const moveNeedle = moveSearch.trim().toLowerCase();
  const moveMatches = useMemo(() => {
    if (moveNeedle.length < 1) return [];
    const score = (lead: ExpandedLead) => {
      const names = [lead.companyName, lead.domain.hostname]
        .filter(Boolean)
        .map((value) => value.toLowerCase());
      if (names.some((value) => value === moveNeedle)) return 0;
      if (names.some((value) => value.startsWith(moveNeedle))) return 1;
      return 2;
    };
    return visibleLeads
      .filter((lead) => matchesLeadSearch(lead, moveSearch))
      .map((lead) => ({ lead, rank: score(lead) }))
      .sort(
        (left, right) =>
          left.rank - right.rank ||
          (left.lead.companyName || left.lead.domain.hostname).localeCompare(
            right.lead.companyName || right.lead.domain.hostname,
          ),
      )
      .slice(0, 50)
      .map(({ lead }) => lead);
  }, [visibleLeads, moveSearch, moveNeedle, matchesLeadSearch]);
  const selectedMoveLead = visibleLeads.find((lead) => lead.id === moveLeadId);
  const moveLeadLabel = (lead: ExpandedLead) =>
    lead.companyName && lead.companyName !== lead.domain.hostname
      ? `${lead.companyName} — ${lead.domain.hostname}`
      : lead.domain.hostname;
  const selectMoveLead = (lead: ExpandedLead) => {
    setMoveLeadId(lead.id);
    setMoveSearch(moveLeadLabel(lead));
    setMoveSearchOpen(false);
    setMoveActiveIndex(0);
  };
  function open(lead: ExpandedLead) {
    setDetail(lead);
    setDraft(structuredClone(lead));
    void api
      .get<ExpandedLead>(`/leads/${lead.id}`)
      .then((expanded) => {
        setDetail(expanded);
        setDraft(structuredClone(expanded));
      })
      .catch((error) =>
        notify(
          error instanceof Error
            ? error.message
            : "Complete lead details could not load.",
        ),
      );
  }
  async function save() {
    if (!draft) return;
    const body = {
      status: draft.status,
      priority: draft.priority,
      notes: draft.notes,
      companyName: draft.companyName,
      contactName: draft.contactName,
      email: draft.email,
      discordUsername: draft.discordUsername,
      telegram: draft.telegram,
      otherContact: draft.otherContact,
      website: draft.website,
      discordInvite: draft.discordInvite,
      tags: draft.tags.map((t) => t.tag.name),
    };
    const saved = await api.send<ExpandedLead>(
      `/leads/${draft.id}`,
      "PATCH",
      body,
    );
    setDetail(saved);
    setDraft(saved);
    notify("Lead details saved.");
    await refresh();
  }
  async function add() {
    const url = prompt("Enter a public website URL");
    if (url) {
      await api.send("/leads", "POST", { url });
      notify("Lead added.");
      await refresh();
    }
  }
  async function clearAll() {
    if (!leads.length) {
      notify("There are no leads to clear.");
      return;
    }
    if (
      !confirm(
        `Delete all ${leads.length} leads in this workspace? This cannot be undone.`,
      )
    )
      return;
    const result = await api.send<{ deleted: number }>("/leads", "DELETE");
    setSelected(new Set());
    setDetail(undefined);
    setDraft(undefined);
    setPreview(undefined);
    notify(`${result.deleted} lead${result.deleted === 1 ? "" : "s"} cleared.`);
    await refresh();
  }
  async function assign(ids: string[], assignedToId: string | null) {
    await api.send("/leads/bulk-assign", "POST", { ids, assignedToId });
    notify(`${ids.length} lead${ids.length === 1 ? "" : "s"} assigned.`);
    setSelected(new Set());
    await refresh();
  }
  async function moveLead(id: string, nextStatus: string): Promise<boolean> {
    const originalStatus = leads.find((lead) => lead.id === id)?.status;
    if (!originalStatus) return false;
    if (originalStatus === nextStatus) {
      notify(`Lead is already in ${nextStatus}.`);
      return false;
    }
    setOptimisticStatuses((current) => ({
      ...current,
      [id]: nextStatus,
    }));
    setRecentlyDroppedId(id);
    window.setTimeout(
      () =>
        setRecentlyDroppedId((current) =>
          current === id ? undefined : current,
        ),
      420,
    );
    try {
      await api.send(`/leads/${id}`, "PATCH", { status: nextStatus });
      notify(`Lead moved to ${nextStatus}.`);
      await refresh();
      return true;
    } catch (error) {
      setOptimisticStatuses((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      notify(error instanceof Error ? error.message : "Lead move failed.");
      await refresh();
      return false;
    }
  }
  async function moveSpecificLead() {
    if (!moveLeadId || !moveDestination || movingLeadId) return;
    setMovingLeadId(moveLeadId);
    try {
      if (await moveLead(moveLeadId, moveDestination)) {
        setMoveSearch("");
        setMoveLeadId("");
        setMoveDestination("");
      }
    } finally {
      setMovingLeadId(undefined);
    }
  }
  function showPreview(event: MouseEvent<HTMLElement>, lead: ExpandedLead) {
    if (draggingId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 290;
    const gap = 12;
    const left =
      rect.right + width + gap <= window.innerWidth
        ? rect.right + gap
        : Math.max(12, rect.left - width - gap);
    const top = Math.min(
      Math.max(12, rect.top),
      Math.max(12, window.innerHeight - 330),
    );
    setPreview({ lead, top, left });
  }
  function setField(key: keyof ExpandedLead, value: any) {
    draft && setDraft({ ...draft, [key]: value });
  }
  function addTag() {
    if (
      !draft ||
      !tagText.trim() ||
      draft.tags.some((t) => t.tag.name === tagText.trim())
    )
      return;
    setDraft({
      ...draft,
      tags: [
        ...draft.tags,
        { tag: { id: `new-${tagText}`, name: tagText.trim() } },
      ],
    });
    setTagText("");
  }
  return (
    <section className="page leads-page">
      <header className="leads-hero">
        <div className="leads-hero-title">
          <div className="eyebrow">Relationship workspace</div>
          <h1>Leads funnel</h1>
          <p>
            {leads.length === 0
              ? "Scanner leads with a Discord, Telegram, or email contact land here."
              : `${leads.length} lead${leads.length === 1 ? "" : "s"} · ${contactableCount} reachable · ${stageCounts.get("Won") ?? 0} won`}
          </p>
        </div>
        {leads.length > 0 && (
          <nav
            className="leads-funnel"
            aria-label={
              view === "kanban" ? "Jump to a Kanban stage" : "Filter by stage"
            }
          >
            <div className="leads-funnel-bar" aria-hidden="true">
              {leadStatuses.map((leadStatus) => {
                const count = stageCounts.get(leadStatus) ?? 0;
                return count ? (
                  <span
                    key={leadStatus}
                    data-stage={stageSlug(leadStatus)}
                    style={{ flexGrow: count }}
                    title={`${leadStatus}: ${count}`}
                  />
                ) : null;
              })}
            </div>
            <div className="leads-funnel-legend">
              {view === "table" && (
                <button
                  type="button"
                  className={status === "All" ? "active" : ""}
                  onClick={() => setStatus("All")}
                >
                  <span>All</span>
                  <b>{baseFiltered.length}</b>
                </button>
              )}
              {leadStatuses.map((leadStatus) => {
                const count = stageCounts.get(leadStatus) ?? 0;
                return (
                  <button
                    key={leadStatus}
                    type="button"
                    data-stage={stageSlug(leadStatus)}
                    className={`${status === leadStatus ? "active" : ""}${count ? "" : " is-empty"}`}
                    title={
                      view === "kanban"
                        ? `Scroll to ${leadStatus}`
                        : `Show only ${leadStatus} leads`
                    }
                    onClick={() =>
                      view === "kanban"
                        ? jumpToColumn(leadStatus)
                        : setStatus((current) =>
                            current === leadStatus ? "All" : leadStatus,
                          )
                    }
                  >
                    <i aria-hidden="true" />
                    <span>{leadStatus}</span>
                    <b>{count}</b>
                  </button>
                );
              })}
            </div>
          </nav>
        )}
        <div className="leads-hero-actions">
          <a
            className="btn secondary"
            href="/api/export/leads.csv"
            title="Download every lead as CSV"
          >
            <Download /> CSV
          </a>
          <a
            className="btn secondary"
            href="/api/export/lead-discord-links.txt"
            title="Download only the Discord links"
          >
            <MessageCircle /> Discord links
          </a>
          {canAssign && (
            <Button variant="danger" onClick={() => void clearAll()}>
              <Trash2 /> Clear all
            </Button>
          )}
          <Button onClick={add}>
            <Plus /> Add lead
          </Button>
        </div>
      </header>
      <div className="leads-commandbar card">
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder="Search leads, companies, or contacts…"
        />
        <label className="filter-select">
          <small>Stage</small>
          <select
            value={status}
            aria-label="Filter leads by status"
            onChange={(e) => setStatus(e.target.value)}
          >
            <option>All</option>
            {leadStatuses.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label className="filter-select">
          <small>Tag</small>
          <select
            value={tag}
            aria-label="Filter leads by tag"
            onChange={(e) => setTag(e.target.value)}
          >
            <option>All</option>
            {tags.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        {filtersActive && (
          <button
            type="button"
            className="btn ghost filter-clear"
            onClick={clearFilters}
          >
            <X /> Clear
          </button>
        )}
        <div className="leads-commandbar-right">
          {canAssign && selected.size > 0 && (
            <div className="leads-selection" role="status">
              <b>{selected.size} selected</b>
              <select
                defaultValue=""
                aria-label="Assign selected leads"
                onChange={(event) => {
                  if (event.target.value)
                    void assign(
                      [...selected],
                      event.target.value === "UNASSIGNED"
                        ? null
                        : event.target.value,
                    );
                }}
              >
                <option value="" disabled>
                  Assign to…
                </option>
                <option value="UNASSIGNED">Unassigned</option>
                {team.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.username}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn ghost"
                aria-label="Clear selection"
                onClick={() => setSelected(new Set())}
              >
                <X />
              </button>
            </div>
          )}
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
          <span className="count">
            {filtered.length === leads.length
              ? `${leads.length} lead${leads.length === 1 ? "" : "s"}`
              : `${filtered.length} of ${leads.length}`}
          </span>
        </div>
      </div>
      {view === "kanban" && (
        <section
          className="kanban-quick-move card"
          aria-label="Move a specific server to a Kanban category"
        >
          <div className="kanban-quick-move-copy">
            <b>Move a server</b>
            <small>Find one lead and place it directly in a category.</small>
          </div>
          <div className="kanban-server-picker">
            <label className="searchbox">
              <Search />
              <input
                value={moveSearch}
                role="combobox"
                aria-label="Search server, domain, or contact…"
                aria-autocomplete="list"
                aria-controls="kanban-server-matches"
                aria-expanded={moveSearchOpen && moveNeedle.length > 0}
                aria-activedescendant={
                  moveSearchOpen && moveMatches[moveActiveIndex]
                    ? `kanban-server-${moveMatches[moveActiveIndex].id}`
                    : undefined
                }
                placeholder="Search server, domain, or contact…"
                onFocus={() => setMoveSearchOpen(moveNeedle.length > 0)}
                onBlur={() =>
                  window.setTimeout(() => setMoveSearchOpen(false), 100)
                }
                onChange={(event) => {
                  const value = event.target.value;
                  setMoveSearch(value);
                  setMoveLeadId("");
                  setMoveActiveIndex(0);
                  setMoveSearchOpen(value.trim().length > 0);
                }}
                onKeyDown={(event) => {
                  if (!moveSearchOpen || !moveMatches.length) {
                    if (event.key === "ArrowDown" && moveNeedle.length > 0)
                      setMoveSearchOpen(true);
                    return;
                  }
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setMoveActiveIndex((index) =>
                      Math.min(index + 1, moveMatches.length - 1),
                    );
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setMoveActiveIndex((index) => Math.max(index - 1, 0));
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    const highlightedLead =
                      moveMatches[moveActiveIndex] || moveMatches[0];
                    if (highlightedLead) selectMoveLead(highlightedLead);
                  } else if (event.key === "Escape") {
                    setMoveSearchOpen(false);
                  }
                }}
              />
            </label>
            {moveSearchOpen && moveNeedle.length > 0 && (
              <div
                id="kanban-server-matches"
                className="kanban-server-results"
                role="listbox"
                aria-label="Matching servers"
              >
                {moveMatches.length ? (
                  moveMatches.map((lead, index) => (
                    <button
                      key={lead.id}
                      id={`kanban-server-${lead.id}`}
                      type="button"
                      role="option"
                      aria-selected={index === moveActiveIndex}
                      className={index === moveActiveIndex ? "active" : ""}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setMoveActiveIndex(index)}
                      onClick={() => selectMoveLead(lead)}
                    >
                      <span>{moveLeadLabel(lead)}</span>
                      <small>
                        {leadDiscordUrl(lead) ||
                          lead.telegram ||
                          lead.email ||
                          lead.website}
                      </small>
                    </button>
                  ))
                ) : (
                  <p>No possible matching server</p>
                )}
              </div>
            )}
            {selectedMoveLead && (
              <small className="kanban-server-selected">
                Selected: {moveLeadLabel(selectedMoveLead)}
              </small>
            )}
          </div>
          <select
            value={moveDestination}
            aria-label="Choose destination category"
            onChange={(event) => setMoveDestination(event.target.value)}
          >
            <option value="">Choose category…</option>
            {leadStatuses.map((leadStatus) => (
              <option key={leadStatus} value={leadStatus}>
                {leadStatus}
              </option>
            ))}
          </select>
          <Button
            disabled={!moveLeadId || !moveDestination || Boolean(movingLeadId)}
            onClick={() => void moveSpecificLead()}
          >
            <ArrowRight /> {movingLeadId ? "Moving…" : "Move lead"}
          </Button>
        </section>
      )}
      {view === "table" ? (
        <article className="card leads-table-card">
          {filtered.length ? (
            <div className="table-wrap leads-table-wrap">
              <table className="leads-table">
                <thead>
                  <tr>
                    {canAssign && (
                      <th className="select-col">
                        <input
                          type="checkbox"
                          aria-label="Select all visible leads"
                          checked={
                            filtered.length > 0 &&
                            filtered.every((lead) => selected.has(lead.id))
                          }
                          onChange={(event) =>
                            setSelected(
                              event.target.checked
                                ? new Set(filtered.map((lead) => lead.id))
                                : new Set(),
                            )
                          }
                        />
                      </th>
                    )}
                    {(
                      [
                        ["lead", "Lead"],
                        [null, "Contact"],
                        [null, "Signals"],
                        ["status", "Stage"],
                        ["priority", "Priority"],
                        [null, "Owner"],
                        ["updated", "Updated"],
                      ] as Array<[SortKey | null, string]>
                    ).map(([key, label]) => (
                      <th
                        key={label}
                        aria-sort={
                          key && sort.key === key
                            ? sort.dir === "asc"
                              ? "ascending"
                              : "descending"
                            : undefined
                        }
                      >
                        {key ? (
                          <button
                            type="button"
                            className={`sort-button${sort.key === key ? " active" : ""}`}
                            onClick={() => toggleSort(key)}
                          >
                            {label}
                            {sort.key === key ? (
                              sort.dir === "asc" ? (
                                <ChevronUp aria-hidden="true" />
                              ) : (
                                <ChevronDown aria-hidden="true" />
                              )
                            ) : (
                              <ArrowUpDown aria-hidden="true" />
                            )}
                          </button>
                        ) : (
                          label
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedLeads.map((l) => {
                    const contact = leadContact(l);
                    const rust = leadRustProducts(l);
                    const next = nextStage(l.status);
                    const name = l.companyName || l.domain.hostname;
                    return (
                      <tr
                        key={l.id}
                        className={selected.has(l.id) ? "is-selected" : ""}
                        onClick={() => open(l)}
                      >
                        {canAssign && (
                          <td
                            className="select-col"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <input
                              type="checkbox"
                              aria-label={`Select ${name}`}
                              checked={selected.has(l.id)}
                              onChange={(event) => {
                                const nextSelection = new Set(selected);
                                event.target.checked
                                  ? nextSelection.add(l.id)
                                  : nextSelection.delete(l.id);
                                setSelected(nextSelection);
                              }}
                            />
                          </td>
                        )}
                        <td>
                          <div className="lead-identity">
                            <span
                              className="lead-avatar"
                              data-stage={stageSlug(l.status)}
                            >
                              {l.domain.hostname[0]?.toUpperCase()}
                            </span>
                            <div>
                              <b>{name}</b>
                              <small>
                                {l.domain.hostname}
                                {l.domain.location?.country &&
                                l.domain.location.country !== "Unknown"
                                  ? ` · ${l.domain.location.country}`
                                  : ""}
                              </small>
                            </div>
                          </div>
                        </td>
                        <td>
                          <div className="lead-contact-cell">
                            {contact.kind === "none" ? (
                              <span className="muted">{contact.label}</span>
                            ) : (
                              <a
                                className={`lead-contact ${contact.kind}`}
                                href={contact.href}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={`${contactKindLabels[contact.kind]}: ${contact.label}`}
                                onClick={(event) => event.stopPropagation()}
                              >
                                <ContactIcon kind={contact.kind} />
                                <span>{contact.label}</span>
                              </a>
                            )}
                            {l.contactName && <small>{l.contactName}</small>}
                          </div>
                        </td>
                        <td>
                          <div className="lead-signals">
                            {rust > 0 && (
                              <em
                                className="signal rust"
                                title="Rust products found by the scanner"
                              >
                                {rust} Rust
                              </em>
                            )}
                            {l.tags?.slice(0, rust > 0 ? 1 : 2).map((t) => (
                              <em key={t.tag.id} className="signal tag">
                                {t.tag.name}
                              </em>
                            ))}
                            {l.tags?.length > (rust > 0 ? 1 : 2) && (
                              <small>
                                +{l.tags.length - (rust > 0 ? 1 : 2)}
                              </small>
                            )}
                            {rust === 0 && !l.tags?.length && (
                              <span className="muted">—</span>
                            )}
                          </div>
                        </td>
                        <td>
                          <span
                            className="stage-pill"
                            data-stage={stageSlug(l.status)}
                          >
                            <i aria-hidden="true" />
                            {l.status}
                          </span>
                        </td>
                        <td>
                          <PriorityMark priority={l.priority} showLabel />
                        </td>
                        <td>
                          {l.assignedTo ? (
                            <span className="owner">
                              <span className="owner-chip" aria-hidden="true">
                                {initials(l.assignedTo.username)}
                              </span>
                              {l.assignedTo.username}
                            </span>
                          ) : (
                            <span className="muted">Unassigned</span>
                          )}
                        </td>
                        <td
                          className="updated-col"
                          title={new Date(l.updatedAt).toLocaleString()}
                        >
                          <span>{relativeTime(l.updatedAt)}</span>
                          <div
                            className="row-actions"
                            onClick={(event) => event.stopPropagation()}
                          >
                            {contact.href && (
                              <a
                                href={contact.href}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={`Open ${contactKindLabels[contact.kind]}`}
                                aria-label={`Open ${contactKindLabels[contact.kind]} for ${name}`}
                              >
                                <ExternalLink aria-hidden="true" />
                              </a>
                            )}
                            {next && (
                              <button
                                type="button"
                                title={`Move to ${next}`}
                                aria-label={`Move ${name} to ${next}`}
                                onClick={() => void moveLead(l.id, next)}
                              >
                                <ArrowRight aria-hidden="true" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : leads.length ? (
            <Empty
              title="No leads match these filters"
              body="Try a different search, or clear the stage and tag filters."
              action={
                <button
                  type="button"
                  className="btn secondary"
                  onClick={clearFilters}
                >
                  <X /> Clear filters
                </button>
              }
            />
          ) : (
            <Empty
              title="No leads yet"
              body="Add scanner results to Leads, or create one manually."
              action={
                <Button onClick={add}>
                  <Plus /> Add first lead
                </Button>
              }
            />
          )}
        </article>
      ) : (
        <div className="kanban leads-board" aria-label="Lead status board">
          {leadStatuses.map((leadStatus) => {
            const column = leadsByStatus.get(leadStatus) ?? [];
            const collapsed =
              column.length === 0 &&
              !draggingId &&
              dropStatus !== leadStatus &&
              !expandedEmpty.has(leadStatus);
            return (
              <section
                key={leadStatus}
                ref={(element) => {
                  if (element) columnRefs.current.set(leadStatus, element);
                  else columnRefs.current.delete(leadStatus);
                }}
                data-stage={stageSlug(leadStatus)}
                className={`kanban-column${dropStatus === leadStatus ? " is-drop-target" : ""}${highlightedColumn === leadStatus ? " is-highlighted" : ""}${collapsed ? " is-collapsed" : ""}`}
                onDragEnter={() => {
                  if (draggingId) setDropStatus(leadStatus);
                }}
                onDragLeave={(event) => {
                  if (
                    !event.currentTarget.contains(event.relatedTarget as Node)
                  )
                    setDropStatus((current) =>
                      current === leadStatus ? undefined : current,
                    );
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  if (draggingId && dropStatus !== leadStatus)
                    setDropStatus(leadStatus);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const id =
                    draggingId || event.dataTransfer.getData("text/plain");
                  setDraggingId(undefined);
                  setDropStatus(undefined);
                  if (id) void moveLead(id, leadStatus);
                }}
              >
                {column.length === 0 ? (
                  <button
                    type="button"
                    className="kanban-column-toggle"
                    aria-expanded={!collapsed}
                    title={
                      collapsed
                        ? `Expand ${leadStatus}`
                        : `Collapse ${leadStatus}`
                    }
                    onClick={() => toggleEmptyColumn(leadStatus)}
                  >
                    <i className="stage-dot" aria-hidden="true" />
                    <span>{leadStatus}</span>
                    <b>0</b>
                  </button>
                ) : (
                  <header>
                    <i className="stage-dot" aria-hidden="true" />
                    <span>{leadStatus}</span>
                    <b>{column.length}</b>
                  </header>
                )}
                {!collapsed && (
                  <div className="kanban-column-body">
                    {column.length === 0 && (
                      <p className="kanban-column-empty">Drop leads here</p>
                    )}
                    {column.map((lead) => {
                      const contact = leadContact(lead);
                      const rust = leadRustProducts(lead);
                      return (
                        <article
                          key={lead.id}
                          className={`lead-card card${draggingId === lead.id ? " is-dragging" : ""}${recentlyDroppedId === lead.id ? " just-dropped" : ""}`}
                          draggable
                          aria-describedby={
                            preview?.lead.id === lead.id
                              ? "kanban-lead-preview"
                              : undefined
                          }
                          onMouseEnter={(event) => showPreview(event, lead)}
                          onMouseLeave={() => setPreview(undefined)}
                          onDragStart={(event) => {
                            if (
                              event.target instanceof Element &&
                              event.target.closest(
                                "a, button, input, select, textarea",
                              )
                            ) {
                              event.preventDefault();
                              return;
                            }
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData("text/plain", lead.id);
                            setPreview(undefined);
                            setDraggingId(lead.id);
                          }}
                          onDragEnd={() => {
                            setDraggingId(undefined);
                            setDropStatus(undefined);
                          }}
                          onClick={() => open(lead)}
                        >
                          <div className="lead-card-head">
                            <span
                              className="lead-avatar sm"
                              data-stage={stageSlug(lead.status)}
                            >
                              {lead.domain.hostname[0]?.toUpperCase()}
                            </span>
                            <b title={lead.domain.hostname}>
                              {lead.companyName || lead.domain.hostname}
                            </b>
                            <PriorityMark priority={lead.priority} />
                          </div>
                          {contact.kind === "none" ? (
                            <small className="lead-card-nocontact">
                              {contact.label}
                            </small>
                          ) : (
                            <a
                              className={`lead-card-link ${contact.kind}`}
                              href={contact.href}
                              target="_blank"
                              rel="noopener noreferrer"
                              draggable={false}
                              title={`${contactKindLabels[contact.kind]}: ${contact.label}`}
                              onClick={(event) => event.stopPropagation()}
                              onPointerDown={(event) => event.stopPropagation()}
                              onDragStart={(event) => event.preventDefault()}
                            >
                              <ContactIcon kind={contact.kind} />
                              <span>{contact.label}</span>
                              <ExternalLink aria-hidden="true" />
                            </a>
                          )}
                          <footer>
                            <span>
                              {lead.domain.location?.country &&
                              lead.domain.location.country !== "Unknown"
                                ? lead.domain.location.country
                                : lead.domain.hostname}
                            </span>
                            {rust > 0 && (
                              <em
                                className="signal rust"
                                title="Rust products found by the scanner"
                              >
                                {rust} Rust
                              </em>
                            )}
                            <span
                              className={`owner-chip${lead.assignedTo ? "" : " is-empty"}`}
                              title={lead.assignedTo?.username || "Unassigned"}
                            >
                              {lead.assignedTo
                                ? initials(lead.assignedTo.username)
                                : "—"}
                            </span>
                          </footer>
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
      {view === "kanban" && preview && (
        <aside
          id="kanban-lead-preview"
          className="lead-hover-preview"
          role="tooltip"
          style={{ top: preview.top, left: preview.left }}
        >
          <header>
            <span className="site-icon">
              {preview.lead.domain.hostname[0]?.toUpperCase()}
            </span>
            <div>
              <b>{preview.lead.companyName || preview.lead.domain.hostname}</b>
              <small>{preview.lead.domain.hostname}</small>
            </div>
            <Badge tone={preview.lead.priority.toLowerCase()}>
              {preview.lead.priority}
            </Badge>
          </header>
          <div className="lead-preview-grid">
            <span>
              <small>Status</small>
              <b>{preview.lead.status}</b>
            </span>
            <span>
              <small>Assigned to</small>
              <b>{preview.lead.assignedTo?.username || "Unassigned"}</b>
            </span>
            <span>
              <small>Contact</small>
              <b>{preview.lead.contactName || preview.lead.email || "—"}</b>
            </span>
            <span>
              <small>Hosting</small>
              <b>{preview.lead.domain.location?.country || "Unknown"}</b>
            </span>
            <span>
              <small>Rust products</small>
              <b>{leadRustProducts(preview.lead)}</b>
            </span>
          </div>
          <div className="lead-preview-discord">
            <small>{contactKindLabels[leadContact(preview.lead).kind]}</small>
            <b>{leadContact(preview.lead).label}</b>
          </div>
          {preview.lead.tags.length > 0 && (
            <footer>
              {preview.lead.tags.slice(0, 4).map((item) => (
                <span key={item.tag.id}>{item.tag.name}</span>
              ))}
            </footer>
          )}
        </aside>
      )}
      {detail && draft && (
        <Drawer
          title={draft.companyName || draft.domain.hostname}
          onClose={() => {
            setDetail(undefined);
            setDraft(undefined);
          }}
        >
          <div className="drawer-body lead-editor">
            <div className="lead-summary">
              <div>
                <small>Domain</small>
                <b>{draft.domain.hostname}</b>
              </div>
              <div>
                <small>Discovered</small>
                <b>{new Date(draft.createdAt).toLocaleDateString()}</b>
              </div>
              <div>
                <small>Rust products</small>
                <b>{leadRustProducts(draft)}</b>
              </div>
            </div>
            <section className="outreach-panel" aria-label="Outreach message">
              <header>
                <div>
                  <b>Outreach</b>
                  <small>
                    A message written for this server. Copy it, send it from
                    your own account, then mark it as sent.
                  </small>
                </div>
                {templates.length > 0 && (
                  <select
                    aria-label="Message template"
                    value={activeTemplate?.id ?? ""}
                    onChange={(event) => {
                      setOutreachTemplateId(event.target.value);
                      setOutreachDirty(false);
                    }}
                  >
                    {templates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                  </select>
                )}
              </header>
              {templates.length ? (
                <>
                  <textarea
                    aria-label="Outreach message"
                    rows={7}
                    value={outreachText}
                    onChange={(event) => {
                      setOutreachText(event.target.value);
                      setOutreachDirty(true);
                    }}
                  />
                  <div className="outreach-actions">
                    <Button
                      variant="secondary"
                      onClick={() => void copyOutreach()}
                    >
                      <Copy /> Copy
                    </Button>
                    {drawerContact?.href && (
                      <a
                        className="btn secondary"
                        href={drawerContact.href}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <ContactIcon kind={drawerContact.kind} /> Open{" "}
                        {contactKindLabels[drawerContact.kind]}
                      </a>
                    )}
                    <Button
                      disabled={!outreachText.trim() || outreachSending}
                      onClick={() => void markOutreachSent()}
                    >
                      <CheckCheck />{" "}
                      {outreachSending ? "Saving…" : "Mark as sent"}
                    </Button>
                  </div>
                </>
              ) : (
                <p className="outreach-empty">
                  No message templates yet.{" "}
                  {canAssign
                    ? "Add one under Settings → Outreach templates."
                    : "Ask an administrator to add templates in Settings."}
                </p>
              )}
            </section>
            <div className="form-grid">
              <Field label="Status">
                <select
                  value={draft.status}
                  onChange={(e) => setField("status", e.target.value)}
                >
                  {leadStatuses.map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </Field>
              <Field label="Priority">
                <select
                  value={draft.priority}
                  onChange={(e) => setField("priority", e.target.value)}
                >
                  {priorities.map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </Field>
              {canAssign && (
                <Field label="Assigned researcher">
                  <select
                    value={draft.assignedTo?.id || ""}
                    onChange={(event) =>
                      void assign([draft.id], event.target.value || null)
                    }
                  >
                    <option value="">Unassigned</option>
                    {team.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.username}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="Company / project name">
                <input
                  value={draft.companyName}
                  onChange={(e) => setField("companyName", e.target.value)}
                />
              </Field>
              <Field label="Contact name">
                <input
                  value={draft.contactName}
                  onChange={(e) => setField("contactName", e.target.value)}
                />
              </Field>
              <Field label="Email">
                <input
                  type="email"
                  value={draft.email}
                  onChange={(e) => setField("email", e.target.value)}
                />
              </Field>
              <Field label="Discord username">
                <input
                  value={draft.discordUsername}
                  onChange={(e) => setField("discordUsername", e.target.value)}
                />
              </Field>
              <Field label="Telegram">
                <input
                  value={draft.telegram}
                  onChange={(e) => setField("telegram", e.target.value)}
                />
              </Field>
              <Field label="Other contact">
                <input
                  value={draft.otherContact}
                  onChange={(e) => setField("otherContact", e.target.value)}
                />
              </Field>
            </div>
            <Field label="Website">
              <input
                value={draft.website}
                onChange={(e) => setField("website", e.target.value)}
              />
            </Field>
            <Field label="Discord invite">
              <input
                value={draft.discordInvite}
                onChange={(e) => setField("discordInvite", e.target.value)}
              />
            </Field>
            <Field label="Notes">
              <textarea
                className="notes expanded"
                value={draft.notes}
                onChange={(e) => setField("notes", e.target.value)}
              />
            </Field>
            <div className="tag-editor">
              <small>Tags</small>
              <div className="tag-row">
                {draft.tags.map((t) => (
                  <Badge key={t.tag.id} tone="tag">
                    {t.tag.name}
                    <button
                      aria-label={`Remove ${t.tag.name} tag`}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          tags: draft.tags.filter(
                            (x) => x.tag.name !== t.tag.name,
                          ),
                        })
                      }
                    >
                      <X />
                    </button>
                  </Badge>
                ))}
              </div>
              <div>
                <input
                  value={tagText}
                  onChange={(e) => setTagText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addTag();
                    }
                  }}
                  placeholder="Add a tag…"
                />
                <Button variant="secondary" onClick={addTag}>
                  <Plus /> Add
                </Button>
              </div>
            </div>
            <div className="activity-list">
              <h3>Activity</h3>
              {draft.activities.length ? (
                draft.activities.map((a) => (
                  <div key={a.id}>
                    <i />
                    <span>
                      <b>{a.description}</b>
                      <small>{new Date(a.createdAt).toLocaleString()}</small>
                    </span>
                  </div>
                ))
              ) : (
                <p>No activity recorded yet.</p>
              )}
            </div>
            <div className="drawer-actions sticky">
              <Button onClick={save}>
                <Save /> Save changes
              </Button>
              <a
                className="btn secondary"
                href={draft.website || `https://${draft.domain.hostname}`}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink /> Open website
              </a>
              <Button
                variant="danger"
                onClick={async () => {
                  if (confirm("Delete this saved lead?")) {
                    await api.send(`/leads/${draft.id}`, "DELETE");
                    setDetail(undefined);
                    setDraft(undefined);
                    await refresh();
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
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="editor-field">
      <small>{label}</small>
      {children}
    </label>
  );
}
