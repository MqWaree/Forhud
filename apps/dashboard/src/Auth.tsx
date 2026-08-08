import {
  createContext,
  useContext,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Eye, EyeOff, LockKeyhole, ShieldCheck } from "lucide-react";

export type AuthUser = {
  id: string;
  workspaceId: string;
  username: string;
  role: "ADMIN" | "MANAGER" | "RESEARCHER";
  status: string;
  requirePasswordChange: boolean;
  workspace: { id: string; name: string; scannerId: string };
};

type AuthValue = {
  user: AuthUser;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};
const AuthContext = createContext<AuthValue | null>(null);
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("Authentication context is unavailable");
  return value;
}

async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "include",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

export default function AuthRoot({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser>();
  const [loading, setLoading] = useState(true);
  const [setup, setSetup] = useState(false);
  const [setupProtected, setSetupProtected] = useState(false);
  const [setupConfigured, setSetupConfigured] = useState(true);
  const refresh = async () => {
    try {
      setUser(await request("/auth/me"));
    } catch {
      setUser(undefined);
    }
  };
  useEffect(() => {
    void (async () => {
      try {
        const status = await request("/auth/setup-status");
        setSetup(Boolean(status.required));
        setSetupProtected(Boolean(status.protected));
        setSetupConfigured(status.configured !== false);
        if (!status.required) await refresh();
      } finally {
        setLoading(false);
      }
    })();
    const expired = () => setUser(undefined);
    window.addEventListener("auth-expired", expired);
    return () => window.removeEventListener("auth-expired", expired);
  }, []);
  const logout = async () => {
    await request("/auth/logout", "POST").catch(() => undefined);
    setUser(undefined);
  };
  if (loading)
    return (
      <div className="auth-shell">
        <div className="auth-loading">Loading secure workspace…</div>
      </div>
    );
  if (!user)
    return (
      <AuthForm
        setup={setup}
        setupProtected={setupProtected}
        setupConfigured={setupConfigured}
        onAuthenticated={(next) => {
          setUser(next);
          setSetup(false);
        }}
      />
    );
  if (user.requirePasswordChange)
    return (
      <RequiredPasswordChange user={user} onChanged={refresh} logout={logout} />
    );
  return (
    <AuthContext.Provider value={{ user, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

function RequiredPasswordChange({
  user,
  onChanged,
  logout,
}: {
  user: AuthUser;
  onChanged: () => Promise<void>;
  logout: () => Promise<void>;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await request("/auth/change-password", "POST", {
        currentPassword,
        newPassword,
        confirmPassword,
      });
      await onChanged();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Password change failed",
      );
    }
  }
  return (
    <div className="auth-shell">
      <section className="auth-panel">
        <div className="auth-brand">
          <img className="auth-brand-logo" src="/fgp-logo.png" alt="FGP" />
          <div>
            <b>FGP</b>
            <small>{user.workspace.name}</small>
          </div>
        </div>
        <div className="auth-icon">
          <LockKeyhole />
        </div>
        <h1>Choose a permanent password</h1>
        <p>
          Your administrator issued a temporary password. Change it before
          entering the workspace.
        </p>
        <form onSubmit={submit}>
          <label>
            <span>Temporary password</span>
            <input
              type="password"
              required
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </label>
          <label>
            <span>New password</span>
            <input
              type="password"
              required
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </label>
          <label>
            <span>Confirm new password</span>
            <input
              type="password"
              required
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </label>
          {error && <div className="auth-error">{error}</div>}
          <button>Change password</button>
          <button
            type="button"
            className="secondary"
            onClick={() => void logout()}
          >
            Sign out
          </button>
        </form>
      </section>
    </div>
  );
}

function AuthForm({
  setup,
  setupProtected,
  setupConfigured,
  onAuthenticated,
}: {
  setup: boolean;
  setupProtected: boolean;
  setupConfigured: boolean;
  onAuthenticated: (user: AuthUser) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const user = await request(
        setup ? "/auth/setup" : "/auth/login",
        "POST",
        { username, password, ...(setup ? { setupToken } : {}) },
      );
      onAuthenticated(user);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-shell">
      <section className="auth-panel">
        <div className="auth-brand">
          <img className="auth-brand-logo" src="/fgp-logo.png" alt="FGP" />
          <div>
            <b>FGP</b>
            <small>FORHUDS PANEL</small>
          </div>
        </div>
        <div className="auth-icon">
          {setup ? <ShieldCheck /> : <LockKeyhole />}
        </div>
        <h1>{setup ? "Create the first administrator" : "Welcome back"}</h1>
        <p>
          {setup
            ? "Your existing local research data will be attached to this secure workspace."
            : "Sign in to your lead research workspace."}
        </p>
        <form onSubmit={submit}>
          <label>
            <span>Username</span>
            <input
              required
              maxLength={32}
              pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
              title="Start with a letter or number; use letters, numbers, dots, dashes, or underscores"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              spellCheck={false}
            />
          </label>
          <label>
            <span>Password</span>
            <span className="password-input">
              <input
                required
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={setup ? "new-password" : "current-password"}
              />
              <button
                type="button"
                aria-label={showPassword ? "Hide password" : "Show password"}
                title={showPassword ? "Hide password" : "Show password"}
                onClick={() => setShowPassword((visible) => !visible)}
              >
                {showPassword ? <EyeOff /> : <Eye />}
              </button>
            </span>
          </label>
          {setup && setupProtected && (
            <label>
              <span>Initial setup code</span>
              <input
                required
                type="password"
                value={setupToken}
                onChange={(event) => setSetupToken(event.target.value)}
                autoComplete="one-time-code"
              />
            </label>
          )}
          {setup && (
            <small className="password-hint">
              Passwords are stored as one-way hashes.
              {setupProtected && !setupConfigured
                ? " The server operator must configure an initial setup code before this workspace can be created."
                : ""}
            </small>
          )}
          {error && <div className="auth-error">{error}</div>}
          <button disabled={busy}>
            {busy
              ? "Please wait…"
              : setup
                ? "Create secure workspace"
                : "Sign in"}
          </button>
        </form>
        <footer>
          Local-first · 30-day HttpOnly sessions · Workspace isolation
        </footer>
      </section>
    </div>
  );
}
