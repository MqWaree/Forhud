export const api = {
  async get<T>(path: string): Promise<T> {
    const r = await fetch(`/api${path}`, { credentials: "include" });
    if (r.status === 401) window.dispatchEvent(new Event("auth-expired"));
    if (!r.ok)
      throw new Error(
        (await r.json().catch(() => ({}))).error || "Request failed",
      );
    return r.json();
  },
  async send<T>(path: string, method = "POST", body?: unknown): Promise<T> {
    const r = await fetch(`/api${path}`, {
      method,
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok)
      throw new Error(
        (await r.json().catch(() => ({}))).error || "Request failed",
      );
    return r.status === 204 ? (undefined as T) : r.json();
  },
};
export type SearchResult = {
  id: string;
  title: string;
  url: string;
  position: number;
  scanStatus: string;
  error?: string;
  discordLinks: { url: string }[];
  domain: { id: string; hostname: string; location?: Location };
};
export type Session = {
  id: string;
  query: string;
  createdAt: string;
  completedAt?: string;
  results: SearchResult[];
};
export type Location = {
  ipAddress: string;
  country?: string;
  countryCode?: string;
  city?: string;
  provider?: string;
  status: string;
  checkedAt: string;
};
export type Lead = {
  id: string;
  status: string;
  priority: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  domain: { id: string; hostname: string; location?: Location };
  searchResult?: SearchResult & { searchSession: { query: string } };
  activities: { id: string; description: string; createdAt: string }[];
};
export type ScannerSource = {
  id: string;
  query: string;
  position: number;
  discoveredAt: string;
  searchSessionId: string;
};
export type ScannerItem = {
  id: string;
  url: string;
  normalizedUrl: string;
  title: string;
  scanStatus: string;
  scanEngine: string;
  fetchMode: string;
  finalUrl: string;
  metaDescription: string;
  canonicalUrl: string;
  faviconUrl: string;
  contentType: string;
  pagesVisited: number;
  emails: string[];
  socialLinks: { type: string; url: string; sourcePage: string }[];
  pages: {
    url: string;
    path: string;
    depth: number;
    status: string;
    httpStatus?: number;
    fetchMode?: string;
    durationMs?: number;
    error?: string;
    errorCode?: string;
    staticFetchResult?: string;
    dynamicFetchResult?: string;
    dynamicError?: string;
    redirectChain?: { url: string; status: number; location: string }[];
    attempts?: {
      attempt: number;
      url: string;
      status?: number;
      fetchMode?: string;
      staticResult?: string;
      dynamicResult?: string;
      errorCode?: string;
      error?: string;
      durationMs: number;
      retryAfterSeconds?: number;
    }[];
  }[];
  error?: string;
  firstSeen: string;
  lastSeen: string;
  scannedAt?: string;
  httpStatus?: number;
  scanDuration?: number;
  originalHttpStatus?: number;
  fallbackUsed: boolean;
  fallbackUrl: string;
  fallbackHttpStatus?: number;
  discoveryFailureReason: string;
  robotsStatus: string;
  domain: { id: string; hostname: string; location?: Location };
  discordLinks: {
    id: string;
    url: string;
    sourcePage: string;
    discoveryMethod: string;
    discoverySection: string;
    interaction: string;
    fetchMode: string;
    validationStatus: string;
    originalUrl: string;
  }[];
  sources: ScannerSource[];
};
export type ScannerSnapshot = {
  engine: {
    healthy: boolean;
    engine: string;
    version?: string;
    error?: string;
  };
  state: {
    status: "IDLE" | "RUNNING" | "STOPPING" | "STOPPED" | "COMPLETED" | "ERROR";
    currentResultId?: string;
    startedAt?: string;
    stoppedAt?: string;
  };
  items: ScannerItem[];
  pagination: { page: number; pageSize: number; total: number; pages: number };
  stats: {
    websites: number;
    scanned: number;
    pending: number;
    scanning: number;
    failed: number;
    timeouts: number;
    blocked: number;
    discord: number;
    leads: number;
  };
  performance: {
    enabled: boolean;
    configuredConcurrency: number;
    currentConcurrency: number;
    minimumConcurrency: number;
    totalCompleted: number;
    successful: number;
    pressureEvents: number;
    rateLimited: number;
    timeoutEvents: number;
    serverErrors: number;
    averageDurationMs: number;
    throughputPerMinute: number;
    lastAdjustmentReason: string;
    lastAdjustmentAt?: string;
    recent: {
      sampleSize: number;
      medianDurationMs: number;
      p95DurationMs: number;
      successRate: number;
    };
  };
};
export type LeadTag = { tag: { id: string; name: string } };
export type ExpandedLead = Lead & {
  companyName: string;
  contactName: string;
  email: string;
  discordUsername: string;
  telegram: string;
  otherContact: string;
  website: string;
  discordInvite: string;
  tags: LeadTag[];
  assignedTo?: { id: string; username: string; role: string };
  scannerResult?: ScannerItem;
};
