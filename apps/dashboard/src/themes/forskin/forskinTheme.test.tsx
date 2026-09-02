// @vitest-environment jsdom
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck -- Testing Library and jsdom are supplied by the dashboard test setup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { useState } from "react";
import {
  DEFAULT_FORSKIN_PREFERENCES,
  ForskinAsset,
  ForskinThemeProvider,
  ForskinQuickToggle,
  ForskinThemeSettings,
  ForskinThemeToggle,
  THEME_STORAGE_KEY,
  forskinAssets,
  parseForskinPreferences,
} from ".";

const mediaListeners = new Set<() => void>();
let prefersReducedMotion = false;

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.forskinNotice;
  prefersReducedMotion = false;
  mediaListeners.clear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: prefersReducedMotion,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: (_event, listener) => mediaListeners.add(listener),
      removeEventListener: (_event, listener) =>
        mediaListeners.delete(listener),
      dispatchEvent: () => true,
    })),
  });
  document.head.innerHTML = '<meta name="theme-color" content="#05070b">';
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Forskin preference parsing", () => {
  it.each([
    null,
    "",
    "not json",
    "null",
    "[]",
    JSON.stringify({ mode: "forskin-subtle" }),
    JSON.stringify({
      mode: "unknown",
      decorativeCopy: true,
      ambientMotion: true,
    }),
    JSON.stringify({
      mode: "forskin-hella",
      decorativeCopy: "yes",
      ambientMotion: true,
    }),
    JSON.stringify({
      mode: "forskin-hella",
      decorativeCopy: true,
      ambientMotion: true,
      extra: true,
    }),
  ])("falls back for invalid input %#", (serialized) => {
    expect(parseForskinPreferences(serialized)).toEqual(
      DEFAULT_FORSKIN_PREFERENCES,
    );
  });

  it("accepts only a complete valid preference value", () => {
    const preferences = {
      mode: "forskin-subtle",
      decorativeCopy: false,
      ambientMotion: false,
    };
    expect(parseForskinPreferences(JSON.stringify(preferences))).toEqual(
      preferences,
    );
  });
});

describe("Forskin asset registry", () => {
  it("uses exact same-origin theme asset paths", () => {
    expect(forskinAssets.logo).toBe(
      "/assets/themes/forskin/branding/fgp-forskin-emblem.svg",
    );
    expect(forskinAssets.frames.heavy).toBe(
      "/assets/themes/forskin/frames/frame-heavy-9slice.webp",
    );
    expect(forskinAssets.ornaments.tendrilLeft).toBe(
      "/assets/themes/forskin/ornaments/tendril-left.webp",
    );
  });
});

describe("ForskinThemeProvider", () => {
  it("loads persistence and applies all three modes live", () => {
    localStorage.setItem(
      THEME_STORAGE_KEY,
      JSON.stringify({
        mode: "forskin-subtle",
        decorativeCopy: true,
        ambientMotion: true,
      }),
    );
    render(
      <ForskinThemeProvider>
        <ForskinThemeToggle />
      </ForskinThemeProvider>,
    );

    expect(document.documentElement.dataset.theme).toBe("forskin-subtle");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveProperty(
      "content",
      "#0b0b09",
    );

    fireEvent.click(screen.getByRole("button", { name: "Default" }));
    expect(document.documentElement.dataset.theme).toBe("default");

    fireEvent.click(screen.getByRole("button", { name: "Forskin - Hella" }));
    expect(document.documentElement.dataset.theme).toBe("forskin-hella");
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY))).toMatchObject({
      mode: "forskin-hella",
    });
  });

  it("applies decorative and motion toggles immediately", () => {
    render(
      <ForskinThemeProvider>
        <ForskinThemeSettings />
      </ForskinThemeProvider>,
    );

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Decorative slogans" }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Ambient motion" }));

    expect(document.documentElement.dataset.forskinCopy).toBe("off");
    expect(document.documentElement.dataset.forskinMotion).toBe("off");
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY))).toEqual({
      mode: "default",
      decorativeCopy: false,
      ambientMotion: false,
    });
  });

  it("pauses ambient motion while hidden and for reduced-motion users", () => {
    render(
      <ForskinThemeProvider>
        <span>content</span>
      </ForskinThemeProvider>,
    );
    expect(document.documentElement.dataset.forskinMotion).toBe("on");

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    fireEvent(document, new Event("visibilitychange"));
    expect(document.documentElement.dataset.forskinMotion).toBe("paused");

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    prefersReducedMotion = true;
    mediaListeners.forEach((listener) => listener());
    expect(document.documentElement.dataset.forskinMotion).toBe("off");
  });

  it("preserves the current route and child state when switching theme", () => {
    function RouteState() {
      const location = useLocation();
      const [value, setValue] = useState("kept");
      return (
        <>
          <output>{location.pathname + location.search}</output>
          <input
            aria-label="Route state"
            value={value}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
          <ForskinThemeToggle />
        </>
      );
    }

    render(
      <ForskinThemeProvider>
        <MemoryRouter initialEntries={["/leads?view=board"]}>
          <RouteState />
        </MemoryRouter>
      </ForskinThemeProvider>,
    );
    const input = screen.getByRole("textbox", { name: "Route state" });
    fireEvent.change(input, { target: { value: "still kept" } });
    fireEvent.click(screen.getByRole("button", { name: "Forskin - Subtle" }));

    expect(screen.getByText("/leads?view=board")).toBeTruthy();
    expect(input).toHaveProperty("value", "still kept");
  });

  it("cycles modes from the compact top-bar control", () => {
    render(
      <ForskinThemeProvider>
        <ForskinQuickToggle />
      </ForskinThemeProvider>,
    );
    const toggle = screen.getByRole("button", {
      name: /Theme: Default\. Switch to Forskin - Subtle/,
    });
    fireEvent.click(toggle);
    expect(document.documentElement.dataset.theme).toBe("forskin-subtle");
    fireEvent.click(
      screen.getByRole("button", {
        name: /Theme: Forskin - Subtle\. Switch to Forskin - Hella/,
      }),
    );
    expect(document.documentElement.dataset.theme).toBe("forskin-hella");
  });

  it("restores Default when a critical theme asset fails", async () => {
    class FailingImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal("Image", FailingImage);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    localStorage.setItem(
      THEME_STORAGE_KEY,
      JSON.stringify({
        mode: "forskin-subtle",
        decorativeCopy: true,
        ambientMotion: true,
      }),
    );
    render(
      <ForskinThemeProvider>
        <span>content</span>
      </ForskinThemeProvider>,
    );
    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe("default"),
    );
    expect(document.documentElement.dataset.forskinNotice).toBe(
      "Forskin assets could not be loaded. Default theme restored.",
    );
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY))).toMatchObject({
      mode: "default",
    });
  });

  it("restores Default across tabs when storage is cleared", () => {
    localStorage.setItem(
      THEME_STORAGE_KEY,
      JSON.stringify({
        mode: "forskin-hella",
        decorativeCopy: false,
        ambientMotion: false,
      }),
    );
    render(
      <ForskinThemeProvider>
        <span>content</span>
      </ForskinThemeProvider>,
    );
    expect(document.documentElement.dataset.theme).toBe("forskin-hella");

    fireEvent(window, new StorageEvent("storage", { key: null }));

    expect(document.documentElement.dataset.theme).toBe("default");
    expect(document.documentElement.dataset.forskinCopy).toBe("on");
    expect(document.documentElement.dataset.forskinMotion).toBe("on");
  });
});

describe("ForskinAsset", () => {
  it("hides failed assets and warns once per URL in development", () => {
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    render(
      <>
        <ForskinAsset src="/missing-theme-image.png" alt="Preview one" />
        <ForskinAsset src="/missing-theme-image.png" alt="Preview two" />
      </>,
    );
    const images = screen.getAllByRole("img");
    fireEvent.error(images[0]);
    fireEvent.error(images[1]);

    expect(images[0]).toHaveProperty("hidden", true);
    expect(images[0].getAttribute("aria-hidden")).toBe("true");
    expect(warning).toHaveBeenCalledTimes(1);
  });
});
