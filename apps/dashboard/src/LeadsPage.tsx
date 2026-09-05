import { type MouseEvent, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Columns3,
  Download,
  ExternalLink,
  PanelLeft,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { leadStatuses, normalizeDiscordUrl, priorities } from "@lead/shared";
import { api, type ExpandedLead } from "./api";
import { useAuth } from "./Auth";
import {
  Badge,
  Button,
  Drawer,
  Empty,
  PageHeader,
  SearchBox,
} from "./components";

const notify = (message: string) =>
  window.dispatchEvent(new CustomEvent("toast", { detail: message }));
const leadDiscordUrl = (lead: ExpandedLead) =>
  normalizeDiscordUrl(
    lead.discordInvite || lead.scannerResult?.discordLinks?.[0]?.url || "",
  );
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
  useEffect(() => {
    if (canAssign) void api.get<typeof team>("/team/users").then(setTeam);
  }, [canAssign]);
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
  const visibleLeads = leads.map((lead) => {
    const optimisticStatus = optimisticStatuses[lead.id];
    return optimisticStatus ? { ...lead, status: optimisticStatus } : lead;
  });
  const matchesLeadSearch = (lead: ExpandedLead, value: string) => {
    const needle = value.trim().toLowerCase();
    if (!needle) return true;
    return [
      lead.domain.hostname,
      lead.companyName,
      lead.contactName,
      lead.email,
      lead.website,
      lead.discordInvite,
      leadDiscordUrl(lead),
      lead.telegram,
    ].some((candidate) => candidate?.toLowerCase().includes(needle));
  };
  const filtered = visibleLeads.filter(
    (lead) =>
      (status === "All" || lead.status === status) &&
      (tag === "All" || lead.tags?.some((item) => item.tag.name === tag)) &&
      matchesLeadSearch(lead, query),
  );
  const moveMatches =
    moveSearch.trim().length < 2
      ? []
      : visibleLeads
          .filter((lead) => matchesLeadSearch(lead, moveSearch))
          .sort((left, right) =>
            (left.companyName || left.domain.hostname).localeCompare(
              right.companyName || right.domain.hostname,
            ),
          )
          .slice(0, 50);
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
    <section className="page">
      <PageHeader
        eyebrow="Relationship workspace"
        title="Leads funnel"
        subtitle="Review Discord-, Telegram-, and email-qualified scanner leads and manually created opportunities."
        actions={
          <>
            <a className="btn secondary" href="/api/export/leads.csv">
              <Download /> Export
            </a>
            <a
              className="btn secondary"
              href="/api/export/lead-discord-links.txt"
            >
              <Download /> Discord links
            </a>
            {canAssign && (
              <Button variant="danger" onClick={() => void clearAll()}>
                <Trash2 /> Clear all
              </Button>
            )}
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
          placeholder="Search leads, companies, or contacts…"
        />
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
        {canAssign && selected.size > 0 && (
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
              Assign selected…
            </option>
            <option value="UNASSIGNED">Unassigned</option>
            {team.map((member) => (
              <option key={member.id} value={member.id}>
                {member.username}
              </option>
            ))}
          </select>
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
        <span className="count">{filtered.length} leads</span>
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
          <SearchBox
            value={moveSearch}
            onChange={(value) => {
              setMoveSearch(value);
              setMoveLeadId("");
            }}
            placeholder="Search server, domain, or contact…"
          />
          <select
            value={moveLeadId}
            aria-label="Choose matching server"
            disabled={moveMatches.length === 0}
            onChange={(event) => setMoveLeadId(event.target.value)}
          >
            <option value="">
              {moveSearch.trim().length < 2
                ? "Type at least 2 characters…"
                : moveMatches.length
                  ? `Choose from ${moveMatches.length} match${moveMatches.length === 1 ? "" : "es"}…`
                  : "No matching server"}
            </option>
            {moveMatches.map((lead) => (
              <option key={lead.id} value={lead.id}>
                {lead.companyName && lead.companyName !== lead.domain.hostname
                  ? `${lead.companyName} — ${lead.domain.hostname}`
                  : lead.domain.hostname}
              </option>
            ))}
          </select>
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
        <article className="card table-card">
          {filtered.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {canAssign && (
                      <th>
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
                    <th>Lead</th>
                    <th>Contact</th>
                    <th>Discord</th>
                    <th>Hosting</th>
                    <th>Tags</th>
                    <th>Status</th>
                    <th>Priority</th>
                    <th>Assigned</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((l) => (
                    <tr key={l.id} onClick={() => open(l)}>
                      {canAssign && (
                        <td onClick={(event) => event.stopPropagation()}>
                          <input
                            type="checkbox"
                            aria-label={`Select ${l.companyName || l.domain.hostname}`}
                            checked={selected.has(l.id)}
                            onChange={(event) => {
                              const next = new Set(selected);
                              event.target.checked
                                ? next.add(l.id)
                                : next.delete(l.id);
                              setSelected(next);
                            }}
                          />
                        </td>
                      )}
                      <td>
                        <div className="domain-cell">
                          <span>{l.domain.hostname[0]?.toUpperCase()}</span>
                          <div>
                            <b>{l.companyName || l.domain.hostname}</b>
                            <small>{l.domain.hostname}</small>
                          </div>
                        </div>
                      </td>
                      <td>
                        {l.contactName || l.email || (
                          <span className="muted">Not added</span>
                        )}
                      </td>
                      <td>
                        {l.discordInvite ||
                          l.scannerResult?.discordLinks?.[0]?.url?.replace(
                            "https://",
                            "",
                          ) || <span className="muted">—</span>}
                      </td>
                      <td>{l.domain.location?.country || "Unknown"}</td>
                      <td>
                        <div className="tag-row">
                          {l.tags?.slice(0, 2).map((t) => (
                            <Badge key={t.tag.id} tone="tag">
                              {t.tag.name}
                            </Badge>
                          ))}
                          {l.tags?.length > 2 && (
                            <small>+{l.tags.length - 2}</small>
                          )}
                        </div>
                      </td>
                      <td>
                        <Badge>{l.status}</Badge>
                      </td>
                      <td>
                        <Badge tone={l.priority.toLowerCase()}>
                          {l.priority}
                        </Badge>
                      </td>
                      <td>
                        {l.assignedTo?.username || (
                          <span className="muted">Unassigned</span>
                        )}
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
        <div className="kanban" aria-label="Lead status board">
          {leadStatuses.map((leadStatus) => (
            <section
              key={leadStatus}
              className={`kanban-column${dropStatus === leadStatus ? " is-drop-target" : ""}`}
              onDragEnter={() => {
                if (draggingId) setDropStatus(leadStatus);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node))
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
              <header>
                <span>{leadStatus}</span>
                <b>
                  {filtered.filter((lead) => lead.status === leadStatus).length}
                </b>
              </header>
              {filtered
                .filter((lead) => lead.status === leadStatus)
                .map((lead) => {
                  const discordUrl = leadDiscordUrl(lead);
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
                      <div>
                        <span className="site-icon">
                          {lead.domain.hostname[0]?.toUpperCase()}
                        </span>
                        <Badge tone={lead.priority.toLowerCase()}>
                          {lead.priority}
                        </Badge>
                      </div>
                      <b>{lead.companyName || lead.domain.hostname}</b>
                      {discordUrl ? (
                        <a
                          className="lead-card-link"
                          href={discordUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          draggable={false}
                          title={`Open ${discordUrl}`}
                          onClick={(event) => event.stopPropagation()}
                          onPointerDown={(event) => event.stopPropagation()}
                          onDragStart={(event) => event.preventDefault()}
                        >
                          <span>{discordUrl.replace(/^https?:\/\//, "")}</span>
                          <ExternalLink aria-hidden="true" />
                        </a>
                      ) : (
                        <small>No Discord link</small>
                      )}
                      <footer>
                        <span>
                          {lead.domain.location?.country || "Unknown"}
                        </span>
                        <span>{lead.assignedTo?.username || "Unassigned"}</span>
                      </footer>
                    </article>
                  );
                })}
            </section>
          ))}
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
          </div>
          <div className="lead-preview-discord">
            <small>Discord</small>
            <b>
              {preview.lead.discordInvite ||
                preview.lead.scannerResult?.discordLinks?.[0]?.url ||
                "Not found"}
            </b>
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
            </div>
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
