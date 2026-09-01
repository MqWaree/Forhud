import { describe, expect, it, vi } from "vitest";
import {
  groupDiscordDestinations,
  resolveDiscordDestination,
  summarizeDiscordDestinations,
} from "./discord-invite-reconciliation.js";

describe("Discord invite reconciliation", () => {
  it("resolves an invite to Discord's immutable guild identity", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          guild: { id: "123456789012345678", name: "Example Guild" },
        }),
        { status: 200 },
      ),
    );

    const resolution = await resolveDiscordDestination(
      { url: "https://discord.gg/Example_Code", inviteCode: "Example_Code" },
      fetcher,
    );

    expect(resolution).toEqual({
      status: "VALID",
      guildId: "123456789012345678",
      guildName: "Example Guild",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://discord.com/api/v10/invites/Example_Code?with_counts=true",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("derives the guild identity from channel links without an API request", async () => {
    const fetcher = vi.fn();

    await expect(
      resolveDiscordDestination(
        {
          url: "https://discord.com/channels/123456789012345678/987654321098765432",
          inviteCode: "",
        },
        fetcher,
      ),
    ).resolves.toEqual({
      status: "VALID",
      guildId: "123456789012345678",
      guildName: "",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("marks expired or unknown invite codes as invalid", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 404 }));

    await expect(
      resolveDiscordDestination(
        { url: "https://discord.gg/expired", inviteCode: "expired" },
        fetcher,
      ),
    ).resolves.toEqual({
      status: "INVALID",
      guildId: "",
      guildName: "",
    });
  });

  it("recovers a temporary Discord rate limit using the advertised delay", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ retry_after: 0.001 }), { status: 429 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ guild: { id: "guild-after-limit" } }), {
          status: 200,
        }),
      );

    await expect(
      resolveDiscordDestination(
        { url: "https://discord.gg/rate-limited", inviteCode: "rate-limited" },
        fetcher,
      ),
    ).resolves.toMatchObject({
      status: "VALID",
      guildId: "guild-after-limit",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("groups duplicate invite URLs so they require only one Discord request", () => {
    const link = (id: string, url: string, inviteCode: string) => ({
      id,
      url,
      inviteCode,
      discordGuildId: "",
      discordGuildName: "",
      lastValidatedAt: null,
    });
    const groups = groupDiscordDestinations([
      link("one", "https://discord.gg/shared", "shared"),
      link("two", "https://discord.gg/shared", "shared"),
      link("three", "https://discord.gg/other", "other"),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.map(({ id }) => id))).toContainEqual([
      "one",
      "two",
    ]);
  });

  it("counts alternate invite codes as one unique Discord server", () => {
    const checkedAt = new Date("2026-09-01T12:00:00.000Z");
    expect(
      summarizeDiscordDestinations([
        {
          url: "https://discord.gg/first",
          discordGuildId: "guild-one",
          lastValidatedAt: checkedAt,
        },
        {
          url: "https://discord.gg/second",
          discordGuildId: "guild-one",
          lastValidatedAt: checkedAt,
        },
        {
          url: "https://discord.gg/unchecked",
          discordGuildId: "",
          lastValidatedAt: null,
        },
      ]),
    ).toEqual({
      invites: 3,
      uniqueServers: 1,
      alternateInvites: 1,
      resolved: 2,
      unresolved: 1,
      lastReconciledAt: checkedAt,
    });
  });
});
