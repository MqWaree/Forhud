type OrganicResult = { title: string; url: string; position: number };

function externalUrl(anchor: HTMLAnchorElement) {
  try {
    const url = new URL(anchor.href, location.href);
    if (!/^https?:$/.test(url.protocol) || /(^|\.)google\./i.test(url.hostname))
      return null;
    return url.href;
  } catch {
    return null;
  }
}

function extract() {
  const results: OrganicResult[] = [];
  const seen = new Set<string>();
  for (const heading of document.querySelectorAll<HTMLHeadingElement>("h3")) {
    const anchor =
      heading.closest<HTMLAnchorElement>("a") ||
      heading.parentElement?.closest<HTMLAnchorElement>("a");
    if (!anchor) continue;
    const url = externalUrl(anchor);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: heading.textContent?.trim() || url,
      url,
      position: results.length + 1,
    });
  }

  const nextSelectors = [
    "a#pnnext",
    'a[rel="next"]',
    'a[aria-label^="Next"]',
    'a[aria-label^="Suivant"]',
    'a[aria-label^="Weiter"]',
    'a[aria-label^="Siguiente"]',
  ];
  let nextPageUrl = "";
  for (const selector of nextSelectors) {
    const anchor = document.querySelector<HTMLAnchorElement>(selector);
    if (anchor?.href) {
      nextPageUrl = anchor.href;
      break;
    }
  }
  return {
    searchQuery: new URL(location.href).searchParams.get("q") || "",
    source: "google" as const,
    pageUrl: location.href,
    capturedAt: new Date().toISOString(),
    results,
    nextPageUrl,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "EXTRACT_RESULTS") {
    sendResponse(extract());
    return true;
  }
});

const marker = window as typeof window & { __aetherCaptureInstalled?: boolean };
if (!marker.__aetherCaptureInstalled) marker.__aetherCaptureInstalled = true;
