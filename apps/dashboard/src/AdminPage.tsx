import { useEffect, useState, type FormEvent } from "react";
import {
  Archive,
  DatabaseBackup,
  MonitorSmartphone,
  Plus,
  RefreshCw,
  ShieldCheck,
  Upload,
  Users,
} from "lucide-react";
import { api } from "./api";
import { Badge, Button, PageHeader, Stat } from "./components";

type Overview = {
  users: number;
  activeUsers: number;
  connectedExtensions: number;
  scannerResults: number;
  leads: number;
  scannersRunning: number;
  backupsAvailable: boolean;
  restoreAvailable: boolean;
  lastBackup?: string;
};
type UserRow = {
  id: string;
  username: string;
  role: string;
  status: string;
  lastLoginAt?: string;
  createdAt: string;
  _count: { assignedLeads: number; extensionInstances: number };
  rankAssignments: Array<{
    rank: { id: string; name: string; color: string; position: number };
  }>;
};
type RankRow = {
  id: string;
  name: string;
  color: string;
  position: number;
  permissions: string[];
  managed: boolean;
  _count: { users: number };
};
type ExtensionRow = {
  id: string;
  instanceId: string;
  name: string;
  scannerState: string;
  currentSearch: string;
  pagesScanned: number;
  resultsFound: number;
  lastSeen: string;
  revokedAt?: string;
  connected: boolean;
  ownerUser?: { username: string };
};
type BackupRow = {
  id: string;
  filename: string;
  type: string;
  status: string;
  size: number;
  createdAt: string;
};
type AuditRow = {
  id: string;
  action: string;
  targetType: string;
  createdAt: string;
  actor?: { username: string };
};

export default function AdminPage() {
  const [overview, setOverview] = useState<Overview>();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [extensions, setExtensions] = useState<ExtensionRow[]>([]);
  const [backups, setBackups] = useState<BackupRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [ranks, setRanks] = useState<RankRow[]>([]);
  const [message, setMessage] = useState("");
  const load = async () => {
    const a = await api.get<Overview>("/admin/overview");
    const [b, c, d, e, f] = await Promise.all([
      api.get<UserRow[]>("/admin/users"),
      api.get<ExtensionRow[]>("/admin/extensions"),
      a.backupsAvailable
        ? api.get<BackupRow[]>("/admin/backups")
        : Promise.resolve<BackupRow[]>([]),
      api.get<AuditRow[]>("/admin/audit"),
      api.get<RankRow[]>("/admin/ranks"),
    ]);
    setOverview(a);
    setUsers(b);
    setExtensions(c);
    setBackups(d);
    setAudit(e);
    setRanks(f);
  };
  useEffect(() => {
    void load();
  }, []);
  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api.send("/admin/users", "POST", Object.fromEntries(form));
      event.currentTarget.reset();
      setMessage("Team member created.");
      await load();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not create user",
      );
    }
  }
  async function userAction(id: string, data: unknown) {
    await api.send(`/admin/users/${id}`, "PATCH", data);
    await load();
  }
  async function assignRanks(id: string, rankIds: string[]) {
    await api.send(`/admin/users/${id}/ranks`, "PUT", { rankIds });
    await load();
  }
  async function createRank(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await api.send("/admin/ranks", "POST", {
      name: form.get("name"),
      color: form.get("color"),
      position: Number(form.get("position")),
      permissions: form.get("lztAccess") ? ["LZT_ACCESS"] : [],
    });
    event.currentTarget.reset();
    await load();
  }
  async function updateRank(id: string, data: unknown) {
    await api.send(`/admin/ranks/${id}`, "PATCH", data);
    await load();
  }
  async function deleteRank(id: string) {
    await api.send(`/admin/ranks/${id}`, "DELETE");
    await load();
  }
  async function extensionAction(id: string, force = false) {
    await api.send(
      `/admin/extensions/${id}${force ? "/force-stop" : ""}`,
      force ? "POST" : "PATCH",
      force ? undefined : { revoke: true },
    );
    await load();
  }
  async function createBackup() {
    setMessage("Creating verified snapshot…");
    await api.send("/admin/backups", "POST");
    setMessage("Backup created and integrity checked.");
    await load();
  }
  async function uploadBackup(file?: File) {
    if (!file) return;
    setMessage("Validating uploaded backup…");
    const response = await fetch("/api/admin/backups/upload", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/octet-stream" },
      body: await file.arrayBuffer(),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setMessage(body.error || "Backup upload rejected");
      return;
    }
    setMessage("Backup uploaded and integrity checked.");
    await load();
  }
  return (
    <section className="page">
      <PageHeader
        eyebrow="Administration"
        title="Workspace control center"
        subtitle="Manage access, paired scanners, recoverable backups, and security activity."
        actions={
          <Button variant="secondary" onClick={() => void load()}>
            <RefreshCw /> Refresh
          </Button>
        }
      />
      <div className="stats">
        <Stat
          label="Active users"
          value={`${overview?.activeUsers || 0}/${overview?.users || 0}`}
          detail="Workspace accounts"
          icon={<Users />}
        />
        <Stat
          label="Extensions online"
          value={overview?.connectedExtensions || 0}
          detail="Seen within two minutes"
          icon={<MonitorSmartphone />}
        />
        <Stat
          label="Scanner records"
          value={overview?.scannerResults || 0}
          detail={`${overview?.scannersRunning || 0} crawler running`}
          icon={<ShieldCheck />}
        />
        <Stat
          label="Leads"
          value={overview?.leads || 0}
          detail={
            overview?.backupsAvailable === false
              ? "Platform-managed backups"
              : overview?.lastBackup
                ? `Backup ${new Date(overview.lastBackup).toLocaleDateString()}`
                : "No backup yet"
          }
          icon={<Archive />}
        />
      </div>
      {message && (
        <div className="notice top-gap">
          <ShieldCheck />
          <div>
            <b>Administration update</b>
            <span>{message}</span>
          </div>
        </div>
      )}
      <div className="section-title">
        <h2>Team members</h2>
      </div>
      <article className="card table-card rank-manager">
        <div className="card-head">
          <div>
            <h2>Workspace ranks</h2>
            <p>
              Visual groups and feature permissions. System administrator roles
              remain separate.
            </p>
          </div>
        </div>
        <form className="admin-form" onSubmit={createRank}>
          <input name="name" required maxLength={40} placeholder="Rank name" />
          <input
            name="color"
            type="color"
            defaultValue="#8792A6"
            aria-label="Rank color"
          />
          <input
            name="position"
            type="number"
            defaultValue="50"
            min="-1000"
            max="1000"
            aria-label="Rank position"
          />
          <label className="rank-permission-check">
            <input name="lztAccess" type="checkbox" /> LZT Access
          </label>
          <Button>
            <Plus /> Add rank
          </Button>
        </form>
        <div className="rank-chip-list">
          {ranks.map((rank) => (
            <span
              key={rank.id}
              style={{ borderColor: rank.color, color: rank.color }}
            >
              <i style={{ background: rank.color }} />
              {rank.name}
              <small>
                {rank._count.users} members
                {rank.permissions.includes("LZT_ACCESS") ? " · LZT" : ""}
              </small>
              {!rank.managed && (
                <>
                  <label title="Toggle LZT Access">
                    <input
                      type="checkbox"
                      checked={rank.permissions.includes("LZT_ACCESS")}
                      onChange={(event) =>
                        void updateRank(rank.id, {
                          permissions: event.target.checked
                            ? ["LZT_ACCESS"]
                            : [],
                        })
                      }
                    />{" "}
                    LZT
                  </label>
                  <input
                    type="color"
                    value={rank.color}
                    aria-label={`Color for ${rank.name}`}
                    onChange={(event) =>
                      void updateRank(rank.id, { color: event.target.value })
                    }
                  />
                  <button
                    className="rank-delete"
                    onClick={() =>
                      confirm(`Delete the ${rank.name} rank?`) &&
                      void deleteRank(rank.id)
                    }
                  >
                    Delete
                  </button>
                </>
              )}
            </span>
          ))}
        </div>
      </article>
      <article className="card table-card">
        <form className="admin-form" onSubmit={createUser}>
          <input
            name="username"
            required
            maxLength={32}
            pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
            placeholder="Username"
            aria-label="New member username"
            autoComplete="off"
            spellCheck={false}
          />
          <input
            name="password"
            required
            type="password"
            placeholder="Temporary password"
            aria-label="New member temporary password"
          />
          <select
            name="role"
            defaultValue="RESEARCHER"
            aria-label="New member role"
          >
            <option>RESEARCHER</option>
            <option>MANAGER</option>
            <option>ADMIN</option>
          </select>
          <Button>
            <Plus /> Add member
          </Button>
        </form>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Ranks</th>
                <th>Status</th>
                <th>Assigned</th>
                <th>Last login</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>
                    <b>@{user.username}</b>
                  </td>
                  <td>
                    <select
                      value={user.role}
                      aria-label={`Role for ${user.username}`}
                      onChange={(e) =>
                        void userAction(user.id, { role: e.target.value })
                      }
                    >
                      <option>ADMIN</option>
                      <option>MANAGER</option>
                      <option>RESEARCHER</option>
                    </select>
                  </td>
                  <td>
                    <div className="rank-assignment-list">
                      {ranks.map((rank) => {
                        const checked = user.rankAssignments.some(
                          (item) => item.rank.id === rank.id,
                        );
                        return (
                          <label key={rank.id} style={{ color: rank.color }}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(event) =>
                                void assignRanks(
                                  user.id,
                                  event.target.checked
                                    ? [
                                        ...user.rankAssignments.map(
                                          (item) => item.rank.id,
                                        ),
                                        rank.id,
                                      ]
                                    : user.rankAssignments
                                        .map((item) => item.rank.id)
                                        .filter((id) => id !== rank.id),
                                )
                              }
                            />
                            {rank.name}
                          </label>
                        );
                      })}
                    </div>
                  </td>
                  <td>
                    <Badge
                      tone={user.status === "ACTIVE" ? "connected" : "failed"}
                    >
                      {user.status}
                    </Badge>
                  </td>
                  <td>{user._count.assignedLeads}</td>
                  <td>
                    {user.lastLoginAt
                      ? new Date(user.lastLoginAt).toLocaleString()
                      : "Never"}
                  </td>
                  <td>
                    <div className="actions-inline">
                      <button
                        onClick={() =>
                          void userAction(user.id, {
                            status:
                              user.status === "ACTIVE" ? "DISABLED" : "ACTIVE",
                          })
                        }
                      >
                        {user.status === "ACTIVE" ? "Disable" : "Enable"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>
      <div className="section-title">
        <h2>Extension scanners</h2>
      </div>
      <article className="card table-card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Instance</th>
                <th>Owner</th>
                <th>Connection</th>
                <th>State</th>
                <th>Progress</th>
                <th>Last seen</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {extensions.map((item) => (
                <tr key={item.id}>
                  <td>
                    <b>{item.name}</b>
                    <br />
                    <code>{item.instanceId}</code>
                  </td>
                  <td>{item.ownerUser?.username || "—"}</td>
                  <td>
                    <Badge tone={item.connected ? "connected" : "failed"}>
                      {item.revokedAt
                        ? "Revoked"
                        : item.connected
                          ? "Online"
                          : "Offline"}
                    </Badge>
                  </td>
                  <td>{item.scannerState}</td>
                  <td>
                    {item.pagesScanned} pages · {item.resultsFound} URLs
                  </td>
                  <td>{new Date(item.lastSeen).toLocaleString()}</td>
                  <td>
                    <div className="actions-inline">
                      <button
                        onClick={() => void extensionAction(item.id, true)}
                      >
                        Force stop
                      </button>
                      <button
                        className="danger"
                        onClick={() =>
                          confirm("Revoke this extension token?") &&
                          void extensionAction(item.id)
                        }
                      >
                        Revoke
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>
      <div className="section-title">
        <h2>Backups</h2>
      </div>
      <article className="card table-card">
        <div className="card-head">
          <div>
            <h2>Verified SQLite snapshots</h2>
            <p>
              {overview?.backupsAvailable === false
                ? "Workspace administrators cannot access platform-wide snapshots when multiple workspaces exist."
                : "Database snapshots do not contain shared-file payloads. Production restores use the offline operator recovery procedure so every database writer is stopped."}
            </p>
          </div>
          {overview?.backupsAvailable && (
            <div className="header-actions">
              <label className="btn secondary">
                <Upload /> Upload
                <input
                  hidden
                  type="file"
                  accept=".db,application/x-sqlite3,application/octet-stream"
                  onChange={(event) =>
                    void uploadBackup(event.target.files?.[0])
                  }
                />
              </label>
              <Button onClick={() => void createBackup()}>
                <DatabaseBackup /> Create backup
              </Button>
            </div>
          )}
        </div>
        {overview?.backupsAvailable === false ? (
          <div className="notice">
            <ShieldCheck />
            <div>
              <b>Platform backup required</b>
              <span>
                Ask the VPS operator to create or restore a protected
                platform-level snapshot.
              </span>
            </div>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Size</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {backups.map((item) => (
                  <tr key={item.id}>
                    <td>{new Date(item.createdAt).toLocaleString()}</td>
                    <td>{item.type}</td>
                    <td>
                      <Badge
                        tone={
                          item.status === "COMPLETED" ? "completed" : "failed"
                        }
                      >
                        {item.status}
                      </Badge>
                    </td>
                    <td>{Math.ceil(item.size / 1024)} KB</td>
                    <td>
                      <div className="actions-inline">
                        <a href={`/api/admin/backups/${item.id}/download`}>
                          Download
                        </a>
                        {overview?.restoreAvailable ? (
                          <button
                            className="danger"
                            onClick={() =>
                              confirm(
                                "Restore this backup? Current data gets a safety backup first.",
                              ) &&
                              void api.send(
                                `/admin/backups/${item.id}/restore`,
                                "POST",
                                { confirm: "RESTORE" },
                              )
                            }
                          >
                            Restore
                          </button>
                        ) : (
                          <span>Operator restore</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </article>
      <div className="section-title">
        <h2>Recent security activity</h2>
      </div>
      <article className="card table-card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Target</th>
              </tr>
            </thead>
            <tbody>
              {audit.slice(0, 50).map((item) => (
                <tr key={item.id}>
                  <td>{new Date(item.createdAt).toLocaleString()}</td>
                  <td>{item.actor?.username || "System"}</td>
                  <td>
                    <code>{item.action}</code>
                  </td>
                  <td>{item.targetType}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>
    </section>
  );
}
