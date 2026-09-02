import type { ThemeMode } from "./forskinTheme";

export const forskinCopy = {
  brand: "FGP",
  brandingSubtitle: "Forhuds Panel",
  settingsTitle: "Theme mode",
  modeGroupLabel: "Application theme",
  modeLabels: {
    default: "Default",
    "forskin-subtle": "Forskin - Subtle",
    "forskin-hella": "Forskin - Hella",
  } satisfies Record<ThemeMode, string>,
  decorativeCopyLabel: "Decorative slogans",
  ambientMotionLabel: "Ambient motion",
  previewTitle: "Theme preview",
  progressLabel: "Progress",
  primaryPlaque: "Intakt er kun kunst",
  secondaryPlaque: "Ægte forhud, ingen filter",
  medallion: "Forhud for evigt",
  mug: "Hellere en kop forhud end en kop lort",
  warningPlaque: "Slaveri for cirkumcideren er forbi",
  decorative: {
    plaque: "Intakt er kun kunst",
    preview: "Ægte forhud, ingen filter",
  },
} as const;
