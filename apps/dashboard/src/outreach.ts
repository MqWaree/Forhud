import type { ExpandedLead } from "./api";

/**
 * Placeholders an outreach template may use. Each one is filled from what the
 * scanner and the operator already know about the lead, so every draft is
 * specific to that server without anyone retyping details.
 */
export const outreachPlaceholders: ReadonlyArray<readonly [string, string]> = [
  ["{company}", "Company or project name"],
  ["{domain}", "Website hostname"],
  ["{website}", "Website address"],
  ["{site_title}", "Page title the scanner found"],
  ["{description}", "Site description the scanner found"],
  ["{country}", "Hosting country"],
  ["{contact_name}", "Contact person, if known"],
  ["{contact}", "Best contact: Discord, Telegram, or email"],
  ["{rust_products}", "For example “12 Rust products”"],
  ["{sender}", "Your username"],
  ["{workspace}", "Workspace name"],
];

export type OutreachContext = {
  sender: string;
  workspace: string;
  contact: string;
};

export function rustProductsPhrase(count: number) {
  if (count <= 0) return "Rust products";
  return `${count} Rust product${count === 1 ? "" : "s"}`;
}

export function outreachValues(
  lead: ExpandedLead,
  context: OutreachContext,
): Record<string, string> {
  const country = lead.domain.location?.country;
  const website =
    (lead.website || "").trim() || `https://${lead.domain.hostname}`;
  return {
    company: lead.companyName || lead.domain.hostname,
    domain: lead.domain.hostname,
    website,
    site_title: lead.scannerResult?.title || "",
    description: lead.scannerResult?.metaDescription || "",
    country: country && country !== "Unknown" ? country : "",
    contact_name: lead.contactName || "",
    contact: context.contact,
    rust_products: rustProductsPhrase(
      lead.scannerResult?.rustProductCount ?? 0,
    ),
    sender: context.sender,
    workspace: context.workspace,
  };
}

/**
 * Fill a template. Unknown placeholders are left as typed so a typo is visible
 * instead of silently disappearing; trailing spaces before line breaks are
 * trimmed so an empty value does not leave a dangling space.
 */
export function renderOutreachTemplate(
  body: string,
  values: Record<string, string>,
) {
  return body
    .replace(/\{([a-z_]+)\}/g, (match, key: string) =>
      Object.prototype.hasOwnProperty.call(values, key)
        ? (values[key] ?? match)
        : match,
    )
    .replace(/[ \t]+(\r?\n)/g, "$1")
    .replace(/ {2,}/g, " ");
}
