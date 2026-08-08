import { parseExtensionTarget } from "./target.js";

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

async function message(payload: unknown) {
  const response = await chrome.runtime.sendMessage(payload);
  if (!response?.ok)
    throw new Error(response?.error || "Extension request failed");
  return response;
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let detected = 0;
  let query = "Open a Google search results page";
  if (tab?.id && /^https:\/\/www\.google\.[^/]+\/search/i.test(tab.url || "")) {
    try {
      const result = await message({ type: "EXTRACT_TAB", tabId: tab.id });
      detected = result.payload?.results?.length || 0;
      query = result.payload?.searchQuery || "Google Search";
    } catch {
      /* page may still be loading */
    }
  }
  const state = await message({ type: "STATE" });
  $<HTMLInputElement>("scannerId").value = state.scannerId || "";
  $<HTMLInputElement>("scannerId").disabled = state.connected;
  $("instanceId").textContent = state.instanceId || "—";
  $("workspace").textContent = state.workspaceName || "Not connected";
  $("connection").textContent = state.connected ? "● Paired" : "● Not paired";
  $("connection").className = state.connected ? "green" : "muted";
  $("api").textContent = state.apiOnline ? "● Online" : "● Offline";
  $("api").className = state.apiOnline ? "green" : "error";
  $("runStatus").textContent = state.scannerRunning
    ? state.targetMode === "UNTIL_STOPPED"
      ? "● RUNNING UNTIL STOPPED"
      : "● RUNNING"
    : state.targetReached
      ? "● TARGET REACHED"
      : "● STOPPED";
  $("runStatus").className = state.scannerRunning ? "green" : "muted";
  $("query").textContent = query;
  $("count").textContent = String(detected);
  $("pages").textContent = String(state.pagesCaptured || 0);
  $("links").textContent =
    state.targetMode === "LIMIT" && state.targetResults
      ? `${state.linksCaptured || 0} / ${state.targetResults}`
      : String(state.linksCaptured || 0);
  $("duplicates").textContent = String(state.duplicatesSkipped || 0);
  const target = $<HTMLSelectElement>("targetMode");
  const custom = $<HTMLInputElement>("customTarget");
  if (state.targetMode === "UNTIL_STOPPED") target.value = "UNTIL_STOPPED";
  else if (state.targetResults) {
    const presets = [10, 25, 50, 100, 250, 500, 1000];
    target.value = presets.includes(Number(state.targetResults))
      ? String(state.targetResults)
      : "CUSTOM";
    if (target.value === "CUSTOM") custom.value = String(state.targetResults);
  }
  custom.hidden = target.value !== "CUSTOM";
  target.disabled = Boolean(state.scannerRunning);
  custom.disabled = Boolean(state.scannerRunning);
  $<HTMLButtonElement>("connect").hidden = state.connected;
  $<HTMLButtonElement>("disconnect").hidden = !state.connected;
  $<HTMLButtonElement>("start").disabled =
    !state.connected || state.scannerRunning;
  $<HTMLButtonElement>("stop").disabled = !state.scannerRunning;
  const last = $("lastCapture");
  if (state.lastCaptureError) {
    last.textContent = state.lastCaptureError;
    last.className = "error";
  } else if (state.lastCaptureAt) {
    last.textContent = `${state.lastCaptureQuery || "Google page"} · ${new Date(state.lastCaptureAt).toLocaleTimeString()}`;
    last.className = "green";
  } else {
    last.textContent = state.scannerRunning
      ? "Waiting for results…"
      : "Start the scanner to begin";
    last.className = "muted";
  }
}

$("connect").onclick = async () => {
  try {
    $("msg").textContent = "Pairing securely…";
    await message({
      type: "PAIR",
      scannerId: $<HTMLInputElement>("scannerId").value,
    });
    $("msg").textContent = "Connected. Open Google results and press Start.";
  } catch (error) {
    $("msg").textContent =
      error instanceof Error ? error.message : "Pairing failed";
  }
  await refresh();
};
$("disconnect").onclick = async () => {
  await message({ type: "DISCONNECT" });
  $("msg").textContent = "Extension disconnected.";
  await refresh();
};
$("start").onclick = async () => {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const selected = $<HTMLSelectElement>("targetMode").value;
    const target = parseExtensionTarget(
      selected,
      $<HTMLInputElement>("customTarget").value,
    );
    $("msg").textContent = "Starting persistent page scanner…";
    await message({
      type: "START_SCANNER",
      tabId: tab?.id,
      targetMode: target.mode,
      targetResults: target.targetResults,
    });
    $("msg").textContent =
      target.mode === "UNTIL_STOPPED"
        ? "Running until you press Stop or Google has no next page."
        : `Running until ${target.targetResults} unique results are collected.`;
  } catch (error) {
    $("msg").textContent =
      error instanceof Error ? error.message : "Start failed";
  }
  await refresh();
};
$("stop").onclick = async () => {
  $("msg").textContent = "Stopping immediately…";
  try {
    await message({ type: "STOP_SCANNER" });
    $("msg").textContent = "Stopped. Saved results were preserved.";
  } catch (error) {
    $("msg").textContent =
      error instanceof Error ? error.message : "Stop failed";
  }
  await refresh();
};

$<HTMLSelectElement>("targetMode").onchange = () => {
  $<HTMLInputElement>("customTarget").hidden =
    $<HTMLSelectElement>("targetMode").value !== "CUSTOM";
};

void refresh();
