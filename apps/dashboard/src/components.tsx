import type { ReactNode } from "react";
import { X, Search, Inbox } from "lucide-react";
export function Button({
  children,
  variant = "primary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
}) {
  return (
    <button className={`btn ${variant}`} {...props}>
      {children}
    </button>
  );
}
export function Badge({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <span className={`badge ${tone || String(children).toLowerCase()}`}>
      {children}
    </span>
  );
}
export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      <div className="header-actions">{actions}</div>
    </header>
  );
}
export function Stat({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: ReactNode;
  detail: string;
  icon: ReactNode;
}) {
  return (
    <article className="stat card">
      <div className="stat-top">
        <span>{label}</span>
        <i>{icon}</i>
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}
export function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span>
        <Inbox />
      </span>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}
export function SearchBox({
  value,
  onChange,
  placeholder = "Search…",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="searchbox">
      <Search />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
    </label>
  );
}
export function Drawer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <div>
            <div className="eyebrow">Details</div>
            <h2>{title}</h2>
          </div>
          <button
            className="icon-btn"
            aria-label="Close details"
            onClick={onClose}
          >
            <X />
          </button>
        </header>
        {children}
      </aside>
    </>
  );
}
export function Progress({
  value,
  label = "Progress",
}: {
  value: number;
  label?: string;
}) {
  const normalized = Math.min(100, Math.max(0, value));
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(normalized)}
      aria-label={label}
    >
      <span style={{ width: `${normalized}%` }} />
    </div>
  );
}
