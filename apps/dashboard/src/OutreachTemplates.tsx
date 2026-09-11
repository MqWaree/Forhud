import { useEffect, useState } from "react";
import { MessageSquareText, Plus, Save, Trash2 } from "lucide-react";
import { api, type OutreachTemplate } from "./api";
import { Button } from "./components";
import { outreachPlaceholders } from "./outreach";

const notify = (message: string) =>
  window.dispatchEvent(new CustomEvent("toast", { detail: message }));

/**
 * Settings card for the outreach message templates. Templates are stored per
 * workspace on the server; the lead drawer fills them in per server.
 */
export default function OutreachTemplatesSettings() {
  const [templates, setTemplates] = useState<OutreachTemplate[]>([]);
  const [drafts, setDrafts] = useState<Record<string, OutreachTemplate>>({});
  const [busyId, setBusyId] = useState<string>();
  const load = () =>
    api
      .get<OutreachTemplate[]>("/outreach/templates")
      .then((list) => {
        setTemplates(list);
        setDrafts(Object.fromEntries(list.map((item) => [item.id, item])));
      })
      .catch(() => notify("Outreach templates could not load."));
  useEffect(() => {
    void load();
  }, []);
  const edit = (id: string, key: "name" | "body", value: string) =>
    setDrafts((current) => ({
      ...current,
      [id]: { ...current[id], [key]: value } as OutreachTemplate,
    }));
  const changed = (id: string) => {
    const saved = templates.find((item) => item.id === id);
    const draft = drafts[id];
    return Boolean(
      saved &&
      draft &&
      (saved.name !== draft.name || saved.body !== draft.body),
    );
  };
  async function save(id: string) {
    const draft = drafts[id];
    if (!draft?.name.trim() || !draft.body.trim()) {
      notify("A template needs both a name and a message.");
      return;
    }
    setBusyId(id);
    try {
      const saved = await api.send<OutreachTemplate>(
        `/outreach/templates/${id}`,
        "PATCH",
        { name: draft.name.trim(), body: draft.body },
      );
      setTemplates((current) =>
        current.map((item) => (item.id === id ? saved : item)),
      );
      setDrafts((current) => ({ ...current, [id]: saved }));
      notify("Template saved.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Template not saved.");
    } finally {
      setBusyId(undefined);
    }
  }
  async function remove(id: string) {
    const template = templates.find((item) => item.id === id);
    if (!template || !confirm(`Delete the "${template.name}" template?`))
      return;
    setBusyId(id);
    try {
      await api.send(`/outreach/templates/${id}`, "DELETE");
      setTemplates((current) => current.filter((item) => item.id !== id));
      notify("Template deleted.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Template not deleted.");
    } finally {
      setBusyId(undefined);
    }
  }
  async function add() {
    setBusyId("new");
    try {
      const created = await api.send<OutreachTemplate>(
        "/outreach/templates",
        "POST",
        {
          name: `Template ${templates.length + 1}`,
          body: "Hi {company} team,\n\nI found {website} and noticed {rust_products}.\n\n{sender} from {workspace}",
        },
      );
      setTemplates((current) => [...current, created]);
      setDrafts((current) => ({ ...current, [created.id]: created }));
    } catch (error) {
      notify(error instanceof Error ? error.message : "Template not added.");
    } finally {
      setBusyId(undefined);
    }
  }
  return (
    <article className="card settings-section outreach-templates">
      <header>
        <span>
          <MessageSquareText />
        </span>
        <div>
          <h2>Outreach templates</h2>
          <p>
            Message drafts filled in per server from the lead drawer. You send
            them yourself; nothing is sent automatically.
          </p>
        </div>
      </header>
      <div className="outreach-placeholders">
        {outreachPlaceholders.map(([token, meaning]) => (
          <span key={token} title={meaning}>
            <code>{token}</code>
            <small>{meaning}</small>
          </span>
        ))}
      </div>
      {templates.map((template) => {
        const draft = drafts[template.id] ?? template;
        return (
          <div className="outreach-template" key={template.id}>
            <input
              aria-label="Template name"
              value={draft.name}
              onChange={(event) =>
                edit(template.id, "name", event.target.value)
              }
            />
            <textarea
              aria-label={`Message for ${draft.name}`}
              rows={6}
              value={draft.body}
              onChange={(event) =>
                edit(template.id, "body", event.target.value)
              }
            />
            <div className="outreach-template-actions">
              <Button
                variant="secondary"
                disabled={!changed(template.id) || busyId === template.id}
                onClick={() => void save(template.id)}
              >
                <Save /> Save
              </Button>
              <Button
                variant="danger"
                disabled={busyId === template.id}
                onClick={() => void remove(template.id)}
              >
                <Trash2 /> Delete
              </Button>
            </div>
          </div>
        );
      })}
      <div className="outreach-template-actions">
        <Button
          variant="secondary"
          disabled={busyId === "new"}
          onClick={() => void add()}
        >
          <Plus /> Add template
        </Button>
      </div>
    </article>
  );
}
