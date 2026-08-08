import { hasReachedTarget, parseExtensionTarget } from "./target.js";

const API = "https://forhud.shop/api";
const GOOGLE = /^https:\/\/www\.google\.[^/]+\/search/i;
const MAX_HISTORY = 1000;
const inFlight = new Set<number>();

type StoredState = {
  scannerId?: string;
  extensionToken?: string;
  instanceId?: string;
  workspaceName?: string;
  scannerRunning?: boolean;
  targetTabId?: number;
  captureSessionId?: string;
  processedPages?: string[];
  pagesCaptured?: number;
  linksCaptured?: number;
  duplicatesSkipped?: number;
  capturedDomains?: string[];
  targetMode?: "LIMIT" | "UNTIL_STOPPED";
  targetResults?: number;
  targetReached?: boolean;
  navigationFinished?: boolean;
  lastCaptureAt?: string;
  lastCaptureQuery?: string;
  lastCaptureError?: string;
};

async function stored(): Promise<StoredState> {
  return (await chrome.storage.local.get()) as StoredState;
}

async function instanceId() {
  const state = await stored();
  if (state.instanceId && /^EXT-[A-Z2-9]{5,12}$/.test(state.instanceId))
    return state.instanceId;
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  const id = `EXT-${[...bytes].map((x) => alphabet[x % alphabet.length]).join("")}`;
  await chrome.storage.local.set({ instanceId: id });
  return id;
}

async function api(path: string, init: RequestInit = {}, auth = true) {
  const state = await stored();
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (auth) {
    if (!state.extensionToken) throw new Error("Connect the extension first");
    headers.set("authorization", `Bearer ${state.extensionToken}`);
  }
  const response = await fetch(`${API}${path}`, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && auth) {
      await chrome.storage.local.set({
        scannerRunning: false,
        extensionToken: "",
        lastCaptureError:
          "Connection revoked. Connect again with the Scanner ID.",
      });
      await updateBadge(false);
    }
    throw new Error(
      body.error || `Local API request failed (${response.status})`,
    );
  }
  return body;
}

function pageKey(url: string) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return url;
  }
}

async function extractTab(tabId: number) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "EXTRACT_RESULTS" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    return chrome.tabs.sendMessage(tabId, { type: "EXTRACT_RESULTS" });
  }
}

async function captureTab(tabId: number) {
  if (inFlight.has(tabId)) return { skipped: true };
  inFlight.add(tabId);
  try {
    let state = await stored();
    if (!state.scannerRunning || !state.extensionToken)
      return { skipped: true };
    if (
      hasReachedTarget(
        state.targetMode,
        state.targetResults,
        (state.capturedDomains || []).length,
      )
    ) {
      await finishCollection("Target Results reached");
      return { skipped: true, targetReached: true };
    }
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab?.url || !GOOGLE.test(tab.url)) return { skipped: true };
    const currentKey = pageKey(tab.url);
    if ((state.processedPages || []).includes(currentKey))
      return { skipped: true };

    const payload = await extractTab(tabId);
    state = await stored();
    if (!state.scannerRunning) return { skipped: true };
    if (!payload?.searchQuery)
      throw new Error("This Google page does not contain a search query");

    let imported = 0;
    let duplicates = 0;
    let newlyAcceptedDomains: string[] = [];
    if (payload.results?.length) {
      const result = await api("/search/import", {
        method: "POST",
        body: JSON.stringify({
          ...payload,
          clientId: state.instanceId || (await instanceId()),
        }),
      });
      imported = Number(result.imported || 0);
      duplicates = Number(result.duplicates || 0);
      newlyAcceptedDomains = (result.acceptedDomains || []) as string[];
    }

    state = await stored();
    if (!state.scannerRunning) return { skipped: true };
    const capturedDomains = [
      ...new Set([...(state.capturedDomains || []), ...newlyAcceptedDomains]),
    ];
    const processedPages = [
      ...(state.processedPages || []).filter((url) => url !== currentKey),
      currentKey,
    ].slice(-MAX_HISTORY);
    const uniqueResults = capturedDomains.length;
    const targetReached = hasReachedTarget(
      state.targetMode,
      state.targetResults,
      uniqueResults,
    );
    await chrome.storage.local.set({
      processedPages,
      pagesCaptured: Number(state.pagesCaptured || 0) + 1,
      linksCaptured: uniqueResults,
      duplicatesSkipped: Number(state.duplicatesSkipped || 0) + duplicates,
      capturedDomains,
      targetReached,
      lastCaptureAt: new Date().toISOString(),
      lastCaptureQuery: payload.searchQuery,
      lastCaptureError: "",
    });

    if (targetReached) {
      await finishCollection("Target Results reached");
      return { captured: true, imported, duplicates, targetReached: true };
    }

    // Only the tab selected at Start is auto-paginated. Other manually viewed
    // Google tabs are captured without being controlled.
    if (state.targetTabId === tabId && payload.nextPageUrl) {
      const nextKey = pageKey(payload.nextPageUrl);
      const latest = await stored();
      if (
        latest.scannerRunning &&
        !(latest.processedPages || processedPages).includes(nextKey)
      )
        await chrome.tabs.update(tabId, { url: payload.nextPageUrl });
    } else if (state.targetTabId === tabId && !payload.nextPageUrl) {
      await finishCollection("Google has no more accessible result pages", true);
    }
    return { captured: true, imported, duplicates };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Page capture failed";
    await chrome.storage.local.set({ lastCaptureError: message });
    return { error: message };
  } finally {
    inFlight.delete(tabId);
    void heartbeat();
  }
}

async function finishCollection(message: string, navigationFinished = false) {
  await chrome.storage.local.set({
    scannerRunning: false,
    targetTabId: null,
    navigationFinished,
    lastCaptureError: "",
    lastCaptureAt: new Date().toISOString(),
    lastCaptureQuery: message,
  });
  await updateBadge(false);
}

async function heartbeat() {
  const state = await stored();
  if (!state.extensionToken) return;
  try {
    const response = await api("/extension/heartbeat", {
      method: "POST",
      body: JSON.stringify({
        scannerState: state.scannerRunning ? "RUNNING" : "STOPPED",
        currentSearch: state.lastCaptureQuery || "",
        currentPage: Number(state.pagesCaptured || 0),
        pagesScanned: Number(state.pagesCaptured || 0),
        resultsFound: (state.capturedDomains || []).length,
        uniqueUrlsSent: (state.capturedDomains || []).length,
        duplicatesSkipped: Number(state.duplicatesSkipped || 0),
      }),
    });
    if (response.forceStop) {
      await chrome.storage.local.set({
        scannerRunning: false,
        lastCaptureError: "Stopped by an administrator.",
      });
      await updateBadge(false);
    }
  } catch {
    // The popup shows the persisted connection error; the next alarm retries.
  }
}

async function updateBadge(running: boolean) {
  await chrome.action.setBadgeBackgroundColor({ color: "#2a98ee" });
  await chrome.action.setBadgeText({ text: running ? "ON" : "" });
  await chrome.action.setTitle({
    title: running
      ? "FGP Searcher — running until Stop"
      : "FGP Searcher — stopped",
  });
}

async function pair(scannerId: string) {
  const normalized = scannerId.trim().toUpperCase();
  if (!/^[A-Z2-9-]{4,32}$/.test(normalized))
    throw new Error("Enter the Scanner ID shown at the top of the dashboard");
  const id = await instanceId();
  const result = await api(
    "/extension/pair",
    {
      method: "POST",
      body: JSON.stringify({ scannerId: normalized, instanceId: id }),
    },
    false,
  );
  await chrome.storage.local.set({
    scannerId: result.scannerId,
    extensionToken: result.token,
    instanceId: result.instanceId,
    workspaceName: result.workspaceName,
    scannerRunning: false,
    lastCaptureError: "",
  });
  await heartbeat();
  return result;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    try {
      if (message?.type === "PAIR")
        return sendResponse({
          ok: true,
          ...(await pair(String(message.scannerId || ""))),
        });
      if (message?.type === "DISCONNECT") {
        await chrome.storage.local.set({
          extensionToken: "",
          scannerId: "",
          workspaceName: "",
          scannerRunning: false,
        });
        await updateBadge(false);
        return sendResponse({ ok: true });
      }
      if (message?.type === "STATE") {
        const state = await stored();
        const connected = Boolean(state.extensionToken);
        let apiOnline = false;
        try {
          apiOnline = (await fetch(`${API}/health`)).ok;
        } catch {
          /* offline */
        }
        return sendResponse({
          ok: true,
          connected,
          apiOnline,
          ...state,
          instanceId: state.instanceId || (await instanceId()),
        });
      }
      if (message?.type === "START_SCANNER") {
        const state = await stored();
        if (!state.extensionToken)
          throw new Error("Connect with your Scanner ID first");
        const tabId = Number(message.tabId);
        const tab = Number.isInteger(tabId)
          ? await chrome.tabs.get(tabId)
          : undefined;
        if (!tab?.url || !GOOGLE.test(tab.url))
          throw new Error(
            "Open a Google results page, then press Start Scanner",
          );
        const target = parseExtensionTarget(
          message.targetMode === "UNTIL_STOPPED"
            ? "UNTIL_STOPPED"
            : "CUSTOM",
          String(message.targetResults || ""),
        );
        await chrome.storage.local.set({
          scannerRunning: true,
          targetTabId: tabId,
          captureSessionId: crypto.randomUUID(),
          processedPages: [],
          pagesCaptured: 0,
          linksCaptured: 0,
          duplicatesSkipped: 0,
          capturedDomains: [],
          targetMode: target.mode,
          targetResults: target.targetResults,
          targetReached: false,
          navigationFinished: false,
          lastCaptureAt: "",
          lastCaptureQuery: "",
          lastCaptureError: "",
        });
        await updateBadge(true);
        await api("/extension/scanner/start", { method: "POST" });
        const capture = await captureTab(tabId);
        return sendResponse({ ok: true, running: true, ...capture });
      }
      if (message?.type === "STOP_SCANNER") {
        // Persist the stop first; in-flight work rechecks this before import/navigation.
        await chrome.storage.local.set({
          scannerRunning: false,
          targetTabId: null,
        });
        await updateBadge(false);
        await api("/extension/scanner/stop", { method: "POST" }).catch(
          () => undefined,
        );
        await heartbeat();
        return sendResponse({ ok: true, running: false });
      }
      if (message?.type === "EXTRACT_TAB" && Number.isInteger(message.tabId))
        return sendResponse({
          ok: true,
          payload: await extractTab(message.tabId),
        });
      return sendResponse({ ok: false, error: "Unknown extension request" });
    } catch (error) {
      return sendResponse({
        ok: false,
        error:
          error instanceof Error ? error.message : "Extension request failed",
      });
    }
  })();
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url && GOOGLE.test(tab.url))
    void stored().then((state) => {
      if (state.scannerRunning) void captureTab(tabId);
    });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "aether-heartbeat") void heartbeat();
});
chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create("aether-heartbeat", { periodInMinutes: 1 });
});
chrome.runtime.onStartup.addListener(() => {
  void chrome.alarms.create("aether-heartbeat", { periodInMinutes: 1 });
  void stored().then(async (state) => {
    await updateBadge(Boolean(state.scannerRunning));
    await heartbeat();
    if (state.scannerRunning && state.targetTabId)
      await captureTab(state.targetTabId);
  });
});

void instanceId();
void chrome.alarms.create("aether-heartbeat", { periodInMinutes: 1 });
void stored().then((state) => updateBadge(Boolean(state.scannerRunning)));
