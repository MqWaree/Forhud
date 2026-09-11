// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck -- The fixture supplies only the lead fields the renderer reads.
import { describe, expect, it } from "vitest";
import {
  outreachValues,
  renderOutreachTemplate,
  rustProductsPhrase,
} from "./outreach";

const lead = (overrides = {}) => ({
  id: "lead-1",
  status: "New",
  priority: "Medium",
  notes: "",
  createdAt: "2026-09-05T08:00:00.000Z",
  updatedAt: "2026-09-05T08:00:00.000Z",
  domain: {
    id: "domain-1",
    hostname: "rust-legends.example",
    location: { country: "Germany" },
  },
  activities: [],
  companyName: "Rust Legends",
  contactName: "Alex",
  email: "",
  discordUsername: "",
  telegram: "",
  otherContact: "",
  website: "https://rust-legends.example",
  discordInvite: "https://discord.gg/rustlegends",
  tags: [],
  scannerResult: {
    title: "Rust Legends — accounts & skins",
    metaDescription: "Cheap Rust accounts",
    rustProductCount: 12,
  },
  ...overrides,
});

describe("outreach templates", () => {
  it("fills every placeholder from the lead and the operator context", () => {
    const values = outreachValues(lead(), {
      sender: "mohammad",
      workspace: "Forhud",
      contact: "discord.gg/rustlegends",
    });
    const text = renderOutreachTemplate(
      "Hi {company} ({domain}, {country}) — saw {rust_products} on {website}. {sender} @ {workspace}, via {contact}. Title: {site_title}",
      values,
    );
    expect(text).toBe(
      "Hi Rust Legends (rust-legends.example, Germany) — saw 12 Rust products on https://rust-legends.example. mohammad @ Forhud, via discord.gg/rustlegends. Title: Rust Legends — accounts & skins",
    );
  });

  it("falls back gracefully when the scanner knows nothing yet", () => {
    const values = outreachValues(
      lead({
        companyName: "",
        website: "",
        scannerResult: undefined,
        domain: {
          id: "d",
          hostname: "shop.example",
          location: { country: "Unknown" },
        },
      }),
      { sender: "m", workspace: "", contact: "" },
    );
    expect(values.company).toBe("shop.example");
    expect(values.website).toBe("https://shop.example");
    expect(values.country).toBe("");
    expect(values.rust_products).toBe("Rust products");
    expect(rustProductsPhrase(1)).toBe("1 Rust product");
  });

  it("leaves unknown placeholders visible and trims dangling spaces", () => {
    const text = renderOutreachTemplate(
      "Hello {company} {nope} \nBye {country} ",
      {
        company: "Acme",
        country: "",
      },
    );
    expect(text).toBe("Hello Acme {nope}\nBye ");
  });
});
