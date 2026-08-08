import { useEffect, useMemo, useState } from "react";
import {
  Columns3,
  Download,
  ExternalLink,
  PanelLeft,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { leadStatuses, priorities } from "@lead/shared";
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
    [team, setTeam] = useState<Array<{ id: string; username: string }>>([]);
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
  const filtered = leads.filter(
    (l) =>
      (status === "All" || l.status === status) &&
      (tag === "All" || l.tags?.some((t) => t.tag.name === tag)) &&
      [l.domain.hostname, l.companyName, l.contactName, l.email].some((v) =>
        v?.toLowerCase().includes(query.toLowerCase()),
      ),
  );
  function open(lead: ExpandedLead) {
    setDetail(lead);
    setDraft(structuredClone(lead));
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
  async function assign(ids: string[], assignedToId: string | null) {
    await api.send("/leads/bulk-assign", "POST", { ids, assignedToId });
    notify(`${ids.length} lead${ids.length === 1 ? "" : "s"} assigned.`);
    setSelected(new Set());
    await refresh();
  }
  async function moveLead(id: string, nextStatus: string) {
    try {
      await api.send(`/leads/${id}`, "PATCH", { status: nextStatus });
      notify(`Lead moved to ${nextStatus}.`);
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Lead move failed.");
      await refresh();
    }
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
        subtitle="Build a complete research record for every opportunity."
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
              className="kanban-column"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                const id = event.dataTransfer.getData("text/plain");
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
                .map((lead) => (
                  <article
                    key={lead.id}
                    className="lead-card card"
                    draggable
                    onDragStart={(event) =>
                      event.dataTransfer.setData("text/plain", lead.id)
                    }
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
                    <small>
                      {lead.discordInvite ||
                        lead.scannerResult?.discordLinks?.[0]?.url?.replace(
                          "https://",
                          "",
                        ) ||
                        "No Discord link"}
                    </small>
                    <footer>
                      <span>{lead.domain.location?.country || "Unknown"}</span>
                      <span>{lead.assignedTo?.username || "Unassigned"}</span>
                    </footer>
                  </article>
                ))}
            </section>
          ))}
        </div>
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
