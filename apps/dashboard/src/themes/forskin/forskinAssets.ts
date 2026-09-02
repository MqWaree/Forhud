const root = "/assets/themes/forskin";

export const forskinAssets = {
  logo: `${root}/branding/fgp-forskin-emblem.svg`,
  miniMark: `${root}/branding/fgp-forskin-mini-mark.svg`,
  wordmark: `${root}/branding/fgp-forskin-wordmark.svg`,
  frames: {
    active: `${root}/frames/frame-active-9slice.webp`,
    error: `${root}/frames/frame-error-9slice.webp`,
    heavy: `${root}/frames/frame-heavy-9slice.webp`,
    organic: `${root}/frames/frame-organic-copper-v3.png`,
    medium: `${root}/frames/frame-medium-9slice.webp`,
    thin: `${root}/frames/frame-thin-9slice.webp`,
    horizontalDivider: `${root}/frames/divider-horizontal.webp`,
    verticalDivider: `${root}/frames/divider-vertical.webp`,
    navActive: `${root}/frames/nav-active-drip.webp`,
    progressFill: `${root}/frames/progress-tube-fill.webp`,
    progressTrack: `${root}/frames/progress-tube-track.webp`,
  },
  icons: {
    crown: `${root}/icons/icon-fgp-crown.svg`,
    scan: `${root}/icons/icon-forskin-scan.svg`,
    theme: `${root}/icons/icon-forskin-theme.svg`,
    shield: `${root}/icons/icon-intact-shield.svg`,
    link: `${root}/icons/icon-organic-link.svg`,
  },
  ornaments: {
    chainCorner: `${root}/ornaments/chain-corner.webp`,
    crown: `${root}/ornaments/crown-gold.svg`,
    dogtag: `${root}/ornaments/fgp-dogtag.webp`,
    footerKnot: `${root}/ornaments/footer-organic-knot.webp`,
    medallion: `${root}/ornaments/forhud-forevig-medallion.webp`,
    mug: `${root}/ornaments/forskin-mug.webp`,
    sidebarKnot: `${root}/ornaments/sidebar-organic-knot.webp`,
    tendrilLeft: `${root}/ornaments/tendril-left.webp`,
    tendrilRight: `${root}/ornaments/tendril-right.webp`,
  },
  plaques: {
    rustedSmall: `${root}/plaques/plaque-rusted-small.webp`,
    rustedWide: `${root}/plaques/plaque-rusted-wide.webp`,
    torn: `${root}/plaques/plaque-torn.webp`,
    graffiti: `${root}/plaques/sticker-graffiti.webp`,
    warning: `${root}/plaques/sticker-warning.webp`,
  },
  textures: {
    charcoal: `${root}/textures/charcoal-surface.webp`,
    grain: `${root}/textures/fine-grain.webp`,
    grid: `${root}/textures/grid-mask.svg`,
    mottle: `${root}/textures/organic-mottle.webp`,
    smoke: `${root}/textures/smoke-overlay.webp`,
    sparks: `${root}/textures/sparks-overlay.webp`,
    vignette: `${root}/textures/vignette.webp`,
  },
  reference: `${root}/reference/forskin-mode-reference.png`,
} as const;

export type ForskinAssetRegistry = typeof forskinAssets;
