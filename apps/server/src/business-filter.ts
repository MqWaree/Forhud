const DEFAULT_EXCLUDED_DOMAINS = [
  // Social networks, communities, chat, and publishing platforms.
  "discord.com",
  "discord.gg",
  "reddit.com",
  "redd.it",
  "facebook.com",
  "fb.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "linkedin.com",
  "tiktok.com",
  "youtube.com",
  "youtu.be",
  "twitch.tv",
  "pinterest.com",
  "snapchat.com",
  "threads.net",
  "tumblr.com",
  "medium.com",
  "quora.com",
  "telegram.me",
  "telegram.dog",
  "telegram.org",
  "t.me",
  "whatsapp.com",
  "vk.com",
  // Gaming stores and communities.
  "steamcommunity.com",
  "steampowered.com",
  "epicgames.com",
  "gog.com",
  "xbox.com",
  "playstation.com",
  "nintendo.com",
  // Forums and broad gaming/code communities. These are research sources,
  // not the first-party business websites the Searcher is intended to find.
  "elitepvpers.com",
  "unknowncheats.me",
  "guidedhacking.com",
  "mpgh.net",
  "ownedcore.com",
  "bo3.gg",
  // Marketplaces, directories, review sites, and company databases.
  "amazon.com",
  "amazon.co.uk",
  "amazon.de",
  "amazon.fr",
  "amazon.es",
  "amazon.it",
  "ebay.com",
  "etsy.com",
  "alibaba.com",
  "aliexpress.com",
  "yelp.com",
  "tripadvisor.com",
  "trustpilot.com",
  "yellowpages.com",
  "glassdoor.com",
  "indeed.com",
  "crunchbase.com",
  // Code, reference, link-hub, and search platforms.
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "stackoverflow.com",
  "stackexchange.com",
  "superuser.com",
  "serverfault.com",
  "leetcode.com",
  "geeksforgeeks.org",
  "w3schools.com",
  "developer.mozilla.org",
  "docs.rs",
  "cheats.rs",
  "wikipedia.org",
  "wikimedia.org",
  "linktr.ee",
  "beacons.ai",
  "google.com",
  "bing.com",
  "search.brave.com",
  "search.yahoo.com",
] as const;

function parseDomainList(value?: string) {
  return (value || "")
    .split(",")
    .map((domain) =>
      domain
        .trim()
        .toLowerCase()
        .replace(/^www\./, ""),
    )
    .filter(Boolean);
}

function hostnameMatches(hostname: string, domain: string) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function excludedBusinessPlatforms() {
  return [
    ...DEFAULT_EXCLUDED_DOMAINS,
    ...parseDomainList(process.env.SEARCH_EXCLUDED_DOMAINS),
  ];
}

export function isExcludedBusinessPlatform(value: string) {
  let hostname: string;
  try {
    hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }

  const allowed = parseDomainList(process.env.SEARCH_ALLOWED_DOMAINS);
  if (allowed.some((domain) => hostnameMatches(hostname, domain))) return false;

  return excludedBusinessPlatforms().some((domain) =>
    hostnameMatches(hostname, domain),
  );
}

export type BusinessSearchResult = {
  url: string;
  title?: string;
};

/**
 * Filters provider results using both the destination and its search title.
 * Title filtering is deliberately narrow: it rejects obvious tutorials,
 * language references and discussions while retaining vendor pages whose
 * titles legitimately contain words such as "best", "hacks", or "cheats".
 */
export function isExcludedBusinessSearchResult(result: BusinessSearchResult) {
  if (isExcludedBusinessPlatform(result.url)) return true;
  const title = String(result.title || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!title) return false;

  return [
    /^(?:how (?:do|to)|what (?:are|is)|why (?:do|is)|can (?:i|you))\b/,
    /\b(?:programming|developer|language|syntax)\b.{0,40}\bcheat sheet\b/,
    /\bcheat sheet\b.{0,40}\b(?:programming|developer|language|syntax|reference)\b/,
    /\b(?:console commands?|coding tutorial|programming tutorial)\b/,
    /\b(?:forum thread|discussion thread|community discussion)\b/,
  ].some((pattern) => pattern.test(title));
}

export const defaultExcludedBusinessPlatformCount =
  DEFAULT_EXCLUDED_DOMAINS.length;
