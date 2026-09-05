import type { ThemeMode } from "./forskinTheme";

export const forskinCopy = {
  brand: "FGP",
  brandingSubtitle: "Foreskin Panel",
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
  primaryPlaque: "Intact is pure art",
  secondaryPlaque: "Real foreskin, no filter",
  medallion: "Foreskin forever",
  mug: "Better a cup of foreskin than a cup of shit",
  warningPlaque: "Slavery for the circumciser is over",
  decorative: {
    plaque: "Intact is pure art",
    preview: "Real foreskin, no filter",
  },
} as const;
