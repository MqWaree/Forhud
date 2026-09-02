import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { forskinAssets } from "./forskinAssets";

export const THEME_STORAGE_KEY = "fgp.ui.theme.v1";

export const THEME_MODES = [
  "default",
  "forskin-subtle",
  "forskin-hella",
] as const;

export type ThemeMode = (typeof THEME_MODES)[number];

export type ForskinPreferences = {
  mode: ThemeMode;
  decorativeCopy: boolean;
  ambientMotion: boolean;
};

export const DEFAULT_FORSKIN_PREFERENCES: Readonly<ForskinPreferences> = {
  mode: "default",
  decorativeCopy: true,
  ambientMotion: true,
};

export const THEME_COLORS: Record<ThemeMode, string> = {
  default: "#05070b",
  "forskin-subtle": "#0b0b09",
  "forskin-hella": "#070705",
};

const preferenceKeys = ["mode", "decorativeCopy", "ambientMotion"];
let warnedAboutCriticalAssets = false;

function defaultPreferences(): ForskinPreferences {
  return { ...DEFAULT_FORSKIN_PREFERENCES };
}

export function isForskinPreferences(
  value: unknown,
): value is ForskinPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  return (
    keys.length === preferenceKeys.length &&
    preferenceKeys.every((key) => keys.includes(key)) &&
    THEME_MODES.includes(candidate.mode as ThemeMode) &&
    typeof candidate.decorativeCopy === "boolean" &&
    typeof candidate.ambientMotion === "boolean"
  );
}

export function parseForskinPreferences(
  serialized: string | null | undefined,
): ForskinPreferences {
  if (typeof serialized !== "string") return defaultPreferences();
  try {
    const parsed: unknown = JSON.parse(serialized);
    return isForskinPreferences(parsed) ? { ...parsed } : defaultPreferences();
  } catch {
    return defaultPreferences();
  }
}

export function readForskinPreferences(
  storage?: Pick<Storage, "getItem">,
): ForskinPreferences {
  try {
    const target =
      storage ?? (typeof window !== "undefined" ? window.localStorage : null);
    return target
      ? parseForskinPreferences(target.getItem(THEME_STORAGE_KEY))
      : defaultPreferences();
  } catch {
    return defaultPreferences();
  }
}

export function persistForskinPreferences(
  preferences: ForskinPreferences,
  storage?: Pick<Storage, "setItem">,
): void {
  try {
    const validated = isForskinPreferences(preferences)
      ? preferences
      : defaultPreferences();
    const target =
      storage ?? (typeof window !== "undefined" ? window.localStorage : null);
    target?.setItem(THEME_STORAGE_KEY, JSON.stringify(validated));
  } catch {
    // Storage can be unavailable in private or locked-down browser contexts.
  }
}

function reducedMotionRequested(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function effectiveMotionState(
  preferences: ForskinPreferences,
): "on" | "off" | "paused" {
  if (!preferences.ambientMotion || reducedMotionRequested()) return "off";
  return document.visibilityState === "hidden" ? "paused" : "on";
}

export function applyForskinPreferences(preferences: ForskinPreferences): void {
  if (typeof document === "undefined") return;

  const validated = isForskinPreferences(preferences)
    ? preferences
    : defaultPreferences();
  const root = document.documentElement;
  root.dataset.theme = validated.mode;
  root.dataset.forskinCopy = validated.decorativeCopy ? "on" : "off";
  root.dataset.forskinMotion = effectiveMotionState(validated);

  let themeColor = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  if (!themeColor) {
    themeColor = document.createElement("meta");
    themeColor.name = "theme-color";
    document.head.append(themeColor);
  }
  themeColor.content = THEME_COLORS[validated.mode];
}

export type ForskinThemeValue = {
  preferences: ForskinPreferences;
  mode: ThemeMode;
  decorativeCopy: boolean;
  ambientMotion: boolean;
  setPreferences: (preferences: ForskinPreferences) => void;
  setMode: (mode: ThemeMode) => void;
  setDecorativeCopy: (enabled: boolean) => void;
  setAmbientMotion: (enabled: boolean) => void;
};

const ForskinThemeContext = createContext<ForskinThemeValue | null>(null);

export function ForskinThemeProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferenceState] = useState(() => {
    const initial = readForskinPreferences();
    applyForskinPreferences(initial);
    return initial;
  });
  const preferencesRef = useRef(preferences);

  const commit = (next: ForskinPreferences) => {
    const validated = isForskinPreferences(next) ? next : defaultPreferences();
    preferencesRef.current = validated;
    applyForskinPreferences(validated);
    persistForskinPreferences(validated);
    setPreferenceState(validated);
  };

  const update = (patch: Partial<ForskinPreferences>) => {
    commit({ ...preferencesRef.current, ...patch });
  };

  useLayoutEffect(() => {
    preferencesRef.current = preferences;
    applyForskinPreferences(preferences);
    persistForskinPreferences(preferences);
  }, [preferences]);

  useEffect(() => {
    const media =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    const syncEffectiveMotion = () =>
      applyForskinPreferences(preferencesRef.current);

    document.addEventListener("visibilitychange", syncEffectiveMotion);
    media?.addEventListener("change", syncEffectiveMotion);
    return () => {
      document.removeEventListener("visibilitychange", syncEffectiveMotion);
      media?.removeEventListener("change", syncEffectiveMotion);
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (preferences.mode === "default") {
      delete root.dataset.forskinAssets;
      return;
    }

    let cancelled = false;
    root.dataset.forskinAssets = "loading";
    const load = (src: string) =>
      new Promise<void>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve();
        image.onerror = () => reject(new Error(`Could not load ${src}`));
        image.src = src;
      });

    void Promise.all([
      load(forskinAssets.logo),
      load(forskinAssets.frames.thin),
    ]).then(
      () => {
        if (!cancelled) root.dataset.forskinAssets = "ready";
      },
      (error: unknown) => {
        if (cancelled) return;
        const fallback = {
          ...preferencesRef.current,
          mode: "default" as const,
        };
        preferencesRef.current = fallback;
        applyForskinPreferences(fallback);
        persistForskinPreferences(fallback);
        setPreferenceState(fallback);
        const development = Boolean(
          (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV,
        );
        if (!warnedAboutCriticalAssets && development) {
          warnedAboutCriticalAssets = true;
          console.warn(
            "[ForskinTheme] Critical asset failed; using Default",
            error,
          );
        }
        const notice =
          "Forskin assets could not be loaded. Default theme restored.";
        document.documentElement.dataset.forskinNotice = notice;
        window.dispatchEvent(
          new CustomEvent("toast", {
            detail: notice,
          }),
        );
      },
    );

    return () => {
      cancelled = true;
    };
  }, [preferences.mode]);

  useEffect(() => {
    const syncStoredPreferences = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
      const next = parseForskinPreferences(
        event.key === null ? null : event.newValue,
      );
      preferencesRef.current = next;
      applyForskinPreferences(next);
      setPreferenceState(next);
    };
    window.addEventListener("storage", syncStoredPreferences);
    return () => window.removeEventListener("storage", syncStoredPreferences);
  }, []);

  const value: ForskinThemeValue = {
    preferences,
    mode: preferences.mode,
    decorativeCopy: preferences.decorativeCopy,
    ambientMotion: preferences.ambientMotion,
    setPreferences: commit,
    setMode: (mode) => update({ mode }),
    setDecorativeCopy: (decorativeCopy) => update({ decorativeCopy }),
    setAmbientMotion: (ambientMotion) => update({ ambientMotion }),
  };

  return (
    <ForskinThemeContext.Provider value={value}>
      {children}
    </ForskinThemeContext.Provider>
  );
}

export function useForskinTheme(): ForskinThemeValue {
  const value = useContext(ForskinThemeContext);
  if (!value) {
    throw new Error("useForskinTheme must be used within ForskinThemeProvider");
  }
  return value;
}
