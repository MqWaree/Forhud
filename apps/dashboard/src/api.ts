export const api = {
  async get<T>(path: string, init?: RequestInit): Promise<T> {
    const r = await fetch(`/api${path}`, {
      ...init,
      credentials: "include",
    });
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
  contactFailureCount: number;
  quarantinedAt?: string;
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
    discordGuildId: string;
    discordGuildName: string;
    lastValidatedAt?: string;
    originalUrl: string;
  }[];
  sources: ScannerSource[];
  sourceCount?: number;
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
    discordServers: number;
    discordAlternateInvites: number;
    discordUnresolved: number;
    discordLastReconciledAt?: string;
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
export type DiscordReconciliationProgress = {
  operationId: string;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  phase: string;
  total: number;
  checked: number;
  uniqueDestinations: number;
  processedDestinations: number;
  requestsSaved: number;
  valid: number;
  invalid: number;
  failed: number;
  rateLimited: number;
  progressPercent: number;
  invites?: number;
  uniqueServers?: number;
  alternateInvites?: number;
  resolved?: number;
  unresolved?: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
};
export type DiscordReconciliationStart = {
  started: boolean;
  progress: DiscordReconciliationProgress | null;
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

export type RustPriceSource = {
  id: string;
  url: string;
  normalizedUrl: string;
  domain: string;
  title: string;
  scanStatus: string;
  fetchMode: string;
  httpStatus?: number;
  finalUrl: string;
  pagesChecked: number;
  durationMs?: number;
  error?: string;
  scannedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type LztTrackerSnapshot = {
  configured: boolean;
  sourceMode: "PUBLIC_PAGE" | "OFFICIAL_API";
  displayCurrency: "DKK" | "EUR" | "USD" | "RUB";
  conversion: {
    updatedAt: string;
    fetchedAt: string;
    stale: boolean;
    source: string;
  };
  state: {
    state: string;
    initialized: boolean;
    lastSuccessfulPollAt?: string;
    nextPollAt?: string;
    lastNewListingAt?: string;
    startedAt?: string;
    apiLatencyMs?: number;
    rateLimitRemaining?: number;
    lastErrorCode?: string;
    lastError?: string;
    newListings: number;
    failedPolls: number;
  };
  listings: Array<{
    id: string;
    lztItemId: string;
    title: string;
    publicUrl: string;
    itemState: string;
    priceEurMinor: number;
    priceUsdMinor?: number;
    displayCurrency: "DKK" | "EUR" | "USD" | "RUB";
    priceDisplayMinor: number;
    inventoryCs2DisplayMinor?: number;
    inventoryRustDisplayMinor?: number;
    inventoryTotalDisplayMinor?: number;
    gamesCount?: number;
    rustHours?: number;
    soldAt?: string;
    inventoryCs2EurMinor?: number;
    inventoryRustEurMinor?: number;
    inventoryTotalEurMinor?: number;
    publishedAt: string;
    firstSeenAt: string;
    baseline: boolean;
  }>;
  notifications: Array<{
    id: string;
    lztItemId: string;
    title: string;
    publicUrl: string;
    itemState: string;
    priceEurMinor: number;
    priceUsdMinor?: number;
    gamesCount?: number;
    displayCurrency: "DKK" | "EUR" | "USD" | "RUB";
    priceDisplayMinor: number;
    inventoryCs2DisplayMinor?: number;
    inventoryRustDisplayMinor?: number;
    inventoryTotalDisplayMinor?: number;
    rustHours?: number;
    soldAt?: string;
    inventoryCs2EurMinor?: number;
    inventoryRustEurMinor?: number;
    inventoryTotalEurMinor?: number;
    publishedAt: string;
    firstSeenAt: string;
    baseline: boolean;
  }>;
  notificationCount: number;
  pagination: { page: number; pageSize: number; total: number; pages: number };
  latestAverage?: {
    eligibleCount: number;
    averagePriceEurMinor?: number;
    calculatedAt: string;
    averagePriceDisplayMinor?: number;
  };
  queueLength: number;
  pollIntervalMs: number;
  maxPriceUsdMinor: number;
  notifyBelowUsdMinor: number;
  notifyHighHoursBelowUsdMinor: number;
  notifyHighHoursMinimum: number;
  timezone: string;
  notifyBelowDisplayMinor: number;
  notifyHighHoursBelowDisplayMinor: number;
  haze: {
    enabled: boolean;
    configured: boolean;
    pending: number;
    sent: number;
    failed: number;
    delivery: "HAZE_CLIENT";
    latest?: {
      id: string;
      alertCode: string;
      alertLabel: string;
      status: string;
      attempts: number;
      lastError?: string;
      updatedAt: string;
    };
  };
  metrics: {
    averageApiLatencyMs?: number;
    averageDetectionLatencyMs?: number;
    maximumDetectionLatencyMs: number;
  };
};

export type RustAccountListing = {
  id: string;
  name: string;
  priceAmount: number;
  currency: string;
  priceText: string;
  link: string;
  convertedPriceAmount?: number;
};

export type RustPriceSnapshot = {
  product: {
    key: string;
    name: string;
    type: "RUST_NFA" | "GAME_ACCOUNTS" | "OTHER_ITEMS";
  };
  products: Array<{
    key: string;
    name: string;
    type: "RUST_NFA" | "GAME_ACCOUNTS" | "OTHER_ITEMS";
  }>;
  conversion: {
    targetCurrency: "DKK" | "EUR" | "USD" | "RUB";
    updatedAt: string;
    fetchedAt: string;
    stale: boolean;
    source: string;
  };
  state: {
    status: "IDLE" | "RUNNING" | "STOPPING" | "STOPPED" | "COMPLETED" | "ERROR";
    currentSourceId?: string;
    startedAt?: string;
    stoppedAt?: string;
  };
  sources: RustPriceSource[];
  listings: RustAccountListing[];
  providers: Array<{
    domain: string;
    title: string;
    url: string;
    scanStatus: string;
    stock: number;
    sourceCount: number;
    currency: "DKK" | "EUR" | "USD" | "RUB";
    convertedListings: number;
    lowestPriceMinor?: number;
    averagePriceMinor?: number;
    highestPriceMinor?: number;
    lastScannedAt: string;
  }>;
  pagination: { page: number; pageSize: number; total: number; pages: number };
  stats: {
    sources: number;
    completed: number;
    pending: number;
    failed: number;
    listings: number;
  };
  marketStats: {
    totalListings: number;
    publicLinks: number;
    sourcesRepresented: number;
    currencies: Array<{
      currency: string;
      listings: number;
      lowestMinor: number;
      medianMinor: number;
      averageMinor: number;
      highestMinor: number;
    }>;
    converted: {
      currency: "DKK" | "EUR" | "USD" | "RUB";
      listings: number;
      lowestMinor: number;
      medianMinor: number;
      averageMinor: number;
      highestMinor: number;
    };
    categories: Array<{
      category: string;
      currency: "DKK" | "EUR" | "USD" | "RUB";
      listings: number;
      lowestMinor: number;
      medianMinor: number;
      averageMinor: number;
      highestMinor: number;
    }>;
  };
};
