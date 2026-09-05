// @vitest-environment jsdom
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck -- The focused fixture intentionally supplies only UI-used lead fields.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import LeadsPage from "./LeadsPage";
import { api } from "./api";

vi.mock("./Auth", () => ({
  useAuth: () => ({ user: { role: "ADMIN" } }),
}));

vi.mock("./api", () => ({
  api: {
    get: vi.fn(),
    send: vi.fn(),
  },
}));

const lead = (id: string, hostname: string, overrides = {}) => ({
  id,
  status: "New",
  priority: "Medium",
  notes: "",
  createdAt: "2026-09-05T08:00:00.000Z",
  updatedAt: "2026-09-05T08:00:00.000Z",
  domain: { id: `domain-${id}`, hostname },
  activities: [],
  companyName: hostname,
  contactName: "",
  email: "",
  discordUsername: "",
  telegram: "",
  otherContact: "",
  website: `https://${hostname}`,
  discordInvite: "",
  tags: [],
  ...overrides,
});

describe("Leads Kanban direct move", () => {
  beforeEach(() => {
    vi.mocked(api.get).mockResolvedValue([]);
    vi.mocked(api.send).mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("finds a specific server by Discord invite and moves it to a category", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    render(
      <LeadsPage
        leads={[
          lead("lead-one", "rust-one.example", {
            companyName: "Rust One",
            discordInvite: "https://discord.gg/alpha-rust",
          }),
          lead("lead-two", "other.example"),
        ]}
        refresh={refresh}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Kanban" }));
    fireEvent.change(
      screen.getByRole("textbox", {
        name: "Search server, domain, or contact…",
      }),
      { target: { value: "alpha-rust" } },
    );

    const server = screen.getByRole("combobox", {
      name: "Choose matching server",
    });
    expect((server as HTMLSelectElement).disabled).toBe(false);
    fireEvent.change(server, { target: { value: "lead-one" } });
    fireEvent.change(
      screen.getByRole("combobox", { name: "Choose destination category" }),
      { target: { value: "Interested" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Move lead" }));

    await waitFor(() =>
      expect(api.send).toHaveBeenCalledWith("/leads/lead-one", "PATCH", {
        status: "Interested",
      }),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
