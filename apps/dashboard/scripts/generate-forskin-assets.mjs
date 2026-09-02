import { createRequire } from "node:module";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "../../..");
const outputDir = join(rootDir, "apps/dashboard/public/assets/themes/forskin");
const serverPackage = join(rootDir, "apps/server/package.json");
const requireFromServer = createRequire(pathToFileURL(serverPackage));
const sharp = requireFromServer("sharp");

const WEBP_OPTIONS = {
  quality: 82,
  alphaQuality: 100,
  effort: 6,
  smartSubsample: true,
};
const RASTER_SOURCE =
  "Original procedural SVG recipe rendered by apps/dashboard/scripts/generate-forskin-assets.mjs; no external artwork or model output.";
const STATIC_SOURCE =
  "Original path artwork authored for this project; no external artwork, font dependency, or model output.";
const INITIAL_LIMIT = 1.5 * 1024 * 1024;
const FULL_LIMIT = 5 * 1024 * 1024;

const staticAssets = [
  ["branding/fgp-forskin-emblem.svg", "Primary Forskin mode emblem", false],
  ["branding/fgp-forskin-wordmark.svg", "Path-built Forskin wordmark", false],
  ["branding/fgp-forskin-mini-mark.svg", "Compact navigation mark", false],
  ["textures/grid-mask.svg", "Low-contrast machinery grid mask", false],
  ["ornaments/crown-gold.svg", "Gold crown ornament", true],
  ["icons/icon-forskin-scan.svg", "Forskin scan action icon", false],
  ["icons/icon-organic-link.svg", "Organic link action icon", false],
  ["icons/icon-intact-shield.svg", "Integrity shield status icon", false],
  ["icons/icon-fgp-crown.svg", "FGP crown status icon", false],
  ["icons/icon-forskin-theme.svg", "Forskin theme selector icon", false],
];

const initialSubset = new Set([
  "branding/fgp-forskin-emblem.svg",
  "branding/fgp-forskin-wordmark.svg",
  "branding/fgp-forskin-mini-mark.svg",
  "frames/frame-heavy-9slice.webp",
  "frames/frame-medium-9slice.webp",
  "frames/frame-thin-9slice.webp",
  "frames/frame-active-9slice.webp",
  "frames/frame-error-9slice.webp",
  "frames/divider-horizontal.webp",
  "frames/nav-active-drip.webp",
  "frames/progress-tube-track.webp",
  "frames/progress-tube-fill.webp",
  "textures/charcoal-surface.webp",
  "textures/fine-grain.webp",
  "textures/grid-mask.svg",
  "textures/vignette.webp",
  "icons/icon-fgp-crown.svg",
  "icons/icon-forskin-scan.svg",
  "icons/icon-intact-shield.svg",
  "icons/icon-organic-link.svg",
  "icons/icon-forskin-theme.svg",
]);

function svg(width, height, body, definitions = "") {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${definitions}</defs>${body}</svg>`;
}

const commonDefs = `
  <linearGradient id="iron" x1="0" y1="0" x2="1" y2="1">
    <stop stop-color="#8d7b62"/><stop offset=".18" stop-color="#4a453d"/>
    <stop offset=".52" stop-color="#181b1a"/><stop offset=".82" stop-color="#34261f"/>
    <stop offset="1" stop-color="#080a09"/>
  </linearGradient>
  <linearGradient id="edge" x1="0" y1="0" x2="1" y2="1">
    <stop stop-color="#f0c56b"/><stop offset=".28" stop-color="#88672f"/><stop offset="1" stop-color="#28170d"/>
  </linearGradient>
  <radialGradient id="pit"><stop stop-color="#020302"/><stop offset=".5" stop-color="#1b1110"/><stop offset="1" stop-color="#746044"/></radialGradient>
  <filter id="rough"><feTurbulence type="fractalNoise" baseFrequency=".025 .11" numOctaves="3" seed="417" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="12"/><feDropShadow dx="8" dy="11" stdDeviation="9" flood-color="#000" flood-opacity=".7"/></filter>
  <filter id="glow"><feGaussianBlur stdDeviation="9" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;

function frameSvg(kind) {
  const settings = {
    heavy: { inset: 184, stroke: 30, accent: "#bd8a3d", glow: "", teeth: true },
    medium: {
      inset: 146,
      stroke: 23,
      accent: "#817552",
      glow: "",
      teeth: true,
    },
    thin: { inset: 92, stroke: 15, accent: "#786d55", glow: "", teeth: false },
    active: {
      inset: 112,
      stroke: 19,
      accent: "#d8a740",
      glow: "#78c7a3",
      teeth: false,
    },
    error: {
      inset: 112,
      stroke: 19,
      accent: "#b74b32",
      glow: "#e45c36",
      teeth: false,
    },
  }[kind];
  const { inset, stroke, accent, glow, teeth } = settings;
  const inner = inset + 10;
  const ring = `M28 52 Q46 24 84 34 L484 20 Q512 12 540 24 L944 34 Q991 37 990 82 L1000 476 Q1006 512 994 548 L990 944 Q984 990 938 988 L548 1001 Q512 1008 476 996 L78 990 Q30 984 35 936 L19 548 Q12 512 24 476 L28 52 Z M${inner} ${inner + 10} Q${inner} ${inner} ${inner + 18} ${inner} H${1024 - inner - 18} Q${1024 - inner} ${inner} ${1024 - inner} ${inner + 18} V${1024 - inner - 18} Q${1024 - inner} ${1024 - inner} ${1024 - inner - 18} ${1024 - inner} H${inner + 18} Q${inner} ${1024 - inner} ${inner} ${1024 - inner - 18} Z`;
  const nodes = [96, 256, 512, 768, 928]
    .map(
      (x) =>
        `<circle cx="${x}" cy="65" r="17" fill="url(#pit)"/><circle cx="${x - 4}" cy="59" r="4" fill="#d8bd79" opacity=".65"/>`,
    )
    .join("");
  const sideNodes = [256, 512, 768]
    .map(
      (y) =>
        `<circle cx="62" cy="${y}" r="15" fill="url(#pit)"/><circle cx="962" cy="${y}" r="15" fill="url(#pit)"/>`,
    )
    .join("");
  const toothMarks = teeth
    ? `<path d="M150 96l30 55 31-55 30 55 31-55M783 96l30 55 31-55 30 55M151 928l31-55 30 55 31-55 30 55M786 928l30-55 31 55" fill="none" stroke="#120d09" stroke-width="22" opacity=".8"/>`
    : "";
  const glowLine = glow
    ? `<path d="M${inset} ${inset}H${1024 - inset}V${1024 - inset}H${inset}Z" fill="none" stroke="${glow}" stroke-width="${stroke}" opacity=".72" filter="url(#glow)"/>`
    : "";
  return svg(
    1024,
    1024,
    `
    <path d="${ring}" fill="url(#iron)" fill-rule="evenodd" filter="url(#rough)"/>
    <path d="M45 75Q260 32 491 44M75 45Q32 260 44 492" fill="none" stroke="#d6c49a" stroke-width="17" stroke-linecap="round" opacity=".43"/>
    <path d="M54 963Q286 984 482 970M968 552Q981 756 955 932" fill="none" stroke="#050706" stroke-width="24" opacity=".8"/>
    <path d="M${inset} ${inset}H${1024 - inset}V${1024 - inset}H${inset}Z" fill="none" stroke="${accent}" stroke-width="${stroke}" opacity=".86"/>
    ${glowLine}${toothMarks}${nodes}${sideNodes}
    <path d="M43 191C119 160 119 90 189 43M981 835C908 858 908 937 835 981" fill="none" stroke="url(#edge)" stroke-width="31" stroke-linecap="round"/>
  `,
    commonDefs,
  );
}

function dividerSvg(vertical = false) {
  const width = vertical ? 96 : 1024;
  const height = vertical ? 1024 : 96;
  const transform = vertical ? "translate(96 0) rotate(90)" : "";
  return svg(
    width,
    height,
    `<g transform="${transform}">
    <path d="M18 50C120 15 190 77 290 47S470 26 558 49s192 31 292-3 136 0 156 3" fill="none" stroke="#080a09" stroke-width="32" stroke-linecap="round" opacity=".8"/>
    <path d="M18 45C120 10 190 72 290 42S470 21 558 44s192 31 292-3 136 0 156 3" fill="none" stroke="url(#iron)" stroke-width="22" stroke-linecap="round"/>
    <path d="M24 38C148 16 199 57 296 35S477 25 565 38" fill="none" stroke="#d5bd84" stroke-width="4" stroke-linecap="round" opacity=".55"/>
    <g fill="url(#pit)"><circle cx="118" cy="34" r="8"/><circle cx="513" cy="43" r="8"/><circle cx="907" cy="34" r="8"/></g>
  </g>`,
    commonDefs,
  );
}

function navDripSvg() {
  return svg(
    768,
    180,
    `<path d="M18 20Q90 2 158 17T300 14T443 18T592 13T750 23L744 78Q712 97 677 73L658 125 627 78 582 92 553 158 517 86 460 94 422 130 391 80 330 94 289 151 260 83 203 93 161 122 133 77 78 94 25 72Z" fill="url(#iron)" filter="url(#rough)"/>
    <path d="M31 28Q173 8 303 23T737 29" fill="none" stroke="#dbc27e" stroke-width="7" opacity=".55"/>
    <path d="M33 67Q110 45 179 65T321 62T464 68T604 61T736 69" fill="none" stroke="#ae792e" stroke-width="9"/>
    <circle cx="95" cy="60" r="9" fill="url(#pit)"/><circle cx="677" cy="61" r="9" fill="url(#pit)"/>`,
    commonDefs,
  );
}

function progressSvg(fill) {
  if (!fill)
    return svg(
      1024,
      120,
      `<path d="M62 17H962Q1003 17 1003 60T962 103H62Q21 103 21 60T62 17Z" fill="#080a09" stroke="url(#iron)" stroke-width="20"/><path d="M69 42H955Q973 42 973 60T955 78H69Q51 78 51 60T69 42Z" fill="#111916" stroke="#5b4d36" stroke-width="5"/><path d="M66 31H958" stroke="#d9c28a" stroke-width="4" opacity=".35"/>`,
      commonDefs,
    );
  return svg(
    1024,
    120,
    `<defs><linearGradient id="sap" x1="0" x2="1"><stop stop-color="#6d311e"/><stop offset=".18" stop-color="#d08738"/><stop offset=".52" stop-color="#e2bc58"/><stop offset=".8" stop-color="#62a685"/><stop offset="1" stop-color="#d8a842"/></linearGradient></defs><path d="M55 35H968Q992 35 992 60T968 85H55Q30 85 30 60T55 35Z" fill="url(#sap)"/><path d="M61 43H955" stroke="#fff1b0" stroke-width="8" stroke-linecap="round" opacity=".55"/><path d="M76 76Q170 59 261 75T447 75T632 74T817 73T968 70" fill="none" stroke="#55281b" stroke-width="7" opacity=".65"/><g fill="#fff3b0" opacity=".6"><circle cx="200" cy="53" r="5"/><circle cx="475" cy="54" r="4"/><circle cx="760" cy="52" r="6"/></g>`,
  );
}

function textureSvg(kind) {
  const defs = `<filter id="noise"><feTurbulence type="fractalNoise" baseFrequency="${kind === "fine" ? ".75" : ".035"}" numOctaves="${kind === "fine" ? 2 : 5}" seed="934"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="table" tableValues="0 .34"/></feComponentTransfer></filter><linearGradient id="light" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#4d5147"/><stop offset=".38" stop-color="#202522"/><stop offset="1" stop-color="#090b0a"/></linearGradient>`;
  if (kind === "charcoal")
    return svg(
      512,
      512,
      `<rect width="512" height="512" fill="url(#light)"/><rect width="512" height="512" filter="url(#noise)" opacity=".7"/><path d="M-20 130Q100 80 210 139T540 120M-10 370Q140 310 260 380T530 340" fill="none" stroke="#6b4a2d" stroke-width="18" opacity=".12"/>`,
      defs,
    );
  if (kind === "mottle")
    return svg(
      512,
      512,
      `<rect width="512" height="512" fill="#151917"/><rect width="512" height="512" filter="url(#noise)" opacity=".85"/><g fill="none" stroke="#6c5233" opacity=".18"><path d="M-20 90C80 10 151 171 246 82S420 156 540 45" stroke-width="35"/><path d="M-30 400C96 318 159 471 278 382S443 440 540 350" stroke-width="51"/></g>`,
      defs,
    );
  return svg(
    512,
    512,
    `<rect width="512" height="512" fill="#72746b" filter="url(#noise)" opacity=".38"/>`,
    defs,
  );
}

function vignetteSvg() {
  return svg(
    1024,
    1024,
    `<defs><radialGradient id="v"><stop offset=".38" stop-color="#000" stop-opacity="0"/><stop offset=".72" stop-color="#020302" stop-opacity=".32"/><stop offset="1" stop-color="#000" stop-opacity=".94"/></radialGradient></defs><rect width="1024" height="1024" fill="url(#v)"/>`,
  );
}

function smokeSvg() {
  return svg(
    1024,
    512,
    `<defs><filter id="s"><feTurbulence type="fractalNoise" baseFrequency=".009 .023" numOctaves="4" seed="221"/><feColorMatrix values=".35 0 0 0 .08 .37 0 0 0 .1 .32 0 0 0 .08 0 0 0 .5 0"/><feGaussianBlur stdDeviation="8"/></filter><linearGradient id="fade"><stop stop-color="#fff" stop-opacity="0"/><stop offset=".35" stop-color="#fff"/><stop offset=".75" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient><mask id="m"><rect width="1024" height="512" fill="url(#fade)"/></mask></defs><rect x="-30" y="25" width="1084" height="462" filter="url(#s)" mask="url(#m)" opacity=".48"/>`,
  );
}

function sparksSvg() {
  const sparks = Array.from({ length: 34 }, (_, i) => {
    const x = (i * 173 + 47) % 1000;
    const y = (i * i * 31 + 29) % 470;
    const r = 2 + (i % 4);
    return `<path d="M${x} ${y}l${7 + r * 2} ${-14 - r * 3}" stroke="${i % 3 ? "#db8736" : "#ffe29a"}" stroke-width="${r}" stroke-linecap="round"/><circle cx="${x}" cy="${y}" r="${r / 2}" fill="#fff2ae"/>`;
  }).join("");
  return svg(1024, 512, `<g filter="url(#glow)">${sparks}</g>`, commonDefs);
}

function chainCornerSvg() {
  const links = Array.from(
    { length: 7 },
    (_, i) =>
      `<g transform="translate(${70 + i * 57} ${64 + i * 57}) rotate(-45)"><ellipse rx="38" ry="23" fill="none" stroke="#171713" stroke-width="19"/><ellipse rx="38" ry="23" fill="none" stroke="url(#edge)" stroke-width="10"/><path d="M-23-16Q0-29 23-16" fill="none" stroke="#f0d18a" stroke-width="4" opacity=".55"/></g>`,
  ).join("");
  return svg(
    512,
    512,
    `<path d="M20 18H252Q309 18 327 66L492 489" fill="none" stroke="url(#iron)" stroke-width="34" stroke-linecap="round" filter="url(#rough)"/><path d="M24 29H244Q291 29 304 70" fill="none" stroke="#d9c38d" stroke-width="7" opacity=".5"/>${links}<path d="M20 18l92 21-74 72Z" fill="url(#edge)"/>`,
    commonDefs,
  );
}

function tendrilSvg(right = false) {
  return svg(
    384,
    768,
    `<g transform="${right ? "translate(384 0) scale(-1 1)" : ""}"><path d="M48 742C1 641 153 585 79 491S35 319 149 270 100 101 237 27" fill="none" stroke="#090c0a" stroke-width="72" stroke-linecap="round" filter="url(#rough)"/><path d="M48 742C1 641 153 585 79 491S35 319 149 270 100 101 237 27" fill="none" stroke="url(#iron)" stroke-width="49" stroke-linecap="round"/><path d="M37 718C23 632 133 584 66 496S38 336 132 287" fill="none" stroke="#9d8c61" stroke-width="8" stroke-linecap="round" opacity=".58"/><path d="M81 535l114-65-75 115M119 308l117 30-105 52M143 169l98-75-62 121" fill="url(#edge)" stroke="#1c130d" stroke-width="8" stroke-linejoin="round"/><g fill="url(#pit)"><circle cx="68" cy="657" r="11"/><circle cx="101" cy="400" r="10"/><circle cx="159" cy="247" r="9"/></g></g>`,
    commonDefs,
  );
}

function medallionSvg() {
  return svg(
    640,
    640,
    `<circle cx="320" cy="330" r="245" fill="#090b0a" opacity=".8" filter="url(#rough)"/><circle cx="320" cy="310" r="244" fill="url(#iron)" stroke="url(#edge)" stroke-width="28"/><circle cx="320" cy="310" r="179" fill="#121814" stroke="#877044" stroke-width="17"/><path d="M320 142l47 98 108 14-79 76 22 108-98-52-98 52 22-108-79-76 108-14Z" fill="url(#edge)" stroke="#24170c" stroke-width="13"/><path d="M235 294Q320 202 405 294L380 365Q320 413 260 365Z" fill="#27352d" stroke="#c2984d" stroke-width="13"/><circle cx="320" cy="310" r="34" fill="url(#pit)"/><path d="M182 491Q320 555 458 491" fill="none" stroke="#e1bd6b" stroke-width="11" opacity=".65"/>`,
    commonDefs,
  );
}

function mugSvg() {
  return svg(
    640,
    640,
    `<path d="M144 147Q295 113 447 147L422 514Q300 575 175 514Z" fill="#0c0e0d" stroke="url(#iron)" stroke-width="35" filter="url(#rough)"/><path d="M439 222Q585 191 566 348T425 427" fill="none" stroke="#111513" stroke-width="66"/><path d="M439 224Q548 207 541 334T430 397" fill="none" stroke="url(#iron)" stroke-width="39"/><path d="M151 159Q298 123 443 158" fill="none" stroke="url(#edge)" stroke-width="26"/><path d="M202 208Q299 181 396 208L379 445Q299 480 218 445Z" fill="#26322b" stroke="#7e673e" stroke-width="12"/><path d="M244 272l55-52 56 52-20 113-36 35-36-35Z" fill="url(#edge)"/><circle cx="299" cy="313" r="30" fill="#18251f"/><path d="M180 493Q298 538 417 493" fill="none" stroke="#c5a266" stroke-width="8" opacity=".55"/>`,
    commonDefs,
  );
}

function dogtagSvg() {
  return svg(
    640,
    640,
    `<path d="M105 30Q250 122 366 66T574 91" fill="none" stroke="#1b1912" stroke-width="21" stroke-dasharray="2 29" stroke-linecap="round"/><g transform="rotate(-10 330 352)"><path d="M196 144Q330 99 464 144L511 215V493Q330 574 149 493V215Z" fill="url(#iron)" stroke="#15100b" stroke-width="22" filter="url(#rough)"/><path d="M204 169Q330 130 455 169" fill="none" stroke="#dec58c" stroke-width="8" opacity=".55"/><circle cx="330" cy="187" r="25" fill="url(#pit)"/><path d="M239 276l91-62 91 62-34 151-57 54-57-54Z" fill="#14201b" stroke="url(#edge)" stroke-width="15"/><path d="M278 322h104M294 368h72" stroke="#cda250" stroke-width="17" stroke-linecap="round"/></g>`,
    commonDefs,
  );
}

function knotSvg(wide = false) {
  const width = wide ? 1200 : 520;
  const path = wide
    ? "M29 169C170 32 273 285 409 134S648 275 789 131s241 132 382 2M27 99c146 146 263-87 399 64s248-106 382 31 239-118 370-8"
    : "M32 456C-8 307 184 348 111 208S222 16 321 139s205 21 156-101M45 391c132-29 21-176 166-164S265 67 396 78";
  return svg(
    width,
    wide ? 260 : 520,
    `<path d="${path}" fill="none" stroke="#090b0a" stroke-width="58" stroke-linecap="round" stroke-linejoin="round" filter="url(#rough)"/><path d="${path}" fill="none" stroke="url(#iron)" stroke-width="39" stroke-linecap="round" stroke-linejoin="round"/><path d="${path}" fill="none" stroke="#c6ac72" stroke-width="6" stroke-linecap="round" opacity=".42"/>`,
    commonDefs,
  );
}

function plaqueSvg(kind) {
  const wide = kind === "wide";
  const torn = kind === "torn";
  const width = wide ? 1200 : torn ? 900 : 640;
  const height = torn ? 360 : 320;
  const d = torn
    ? `M30 45L175 28 221 55 350 21 452 52 572 19 657 56 762 26 868 60 841 145 879 226 799 338 675 312 577 345 458 310 342 344 238 306 95 334 54 241 71 160Z`
    : `M35 63Q${width / 2} 9 ${width - 35} 63L${width - 54} ${height - 48}Q${width / 2} ${height - 6} 51 ${height - 49}Z`;
  return svg(
    width,
    height,
    `<path d="${d}" fill="#080a09" stroke="#080806" stroke-width="30" filter="url(#rough)"/><path d="${d}" fill="url(#iron)" stroke="url(#edge)" stroke-width="16"/><path d="M74 83Q${width / 2} 41 ${width - 76} 83" fill="none" stroke="#e4cca0" stroke-width="8" opacity=".48"/><path d="M98 ${height - 76}Q${width / 2} ${height - 39} ${width - 99} ${height - 79}" fill="none" stroke="#140e0a" stroke-width="18" opacity=".8"/><g fill="url(#pit)"><circle cx="91" cy="95" r="12"/><circle cx="${width - 91}" cy="95" r="12"/><circle cx="92" cy="${height - 88}" r="12"/><circle cx="${width - 92}" cy="${height - 88}" r="12"/></g>`,
    commonDefs,
  );
}

function stickerSvg(kind) {
  if (kind === "graffiti")
    return svg(
      640,
      360,
      `<path d="M37 101L96 31l113 25 88-36 89 45 129-22 87 89-48 158-166 22-102 28-91-42-131 17-34-98Z" fill="#d8b84d" stroke="#17150f" stroke-width="24" filter="url(#rough)"/><path d="M94 221l74-114 44 96 70-133 48 120 80-105 31 96 104-60" fill="none" stroke="#39221b" stroke-width="38" stroke-linecap="square" stroke-linejoin="bevel"/><path d="M96 202l70-101 46 89 69-126 50 111 74-96 36 86 99-54" fill="none" stroke="#e8dfbf" stroke-width="12" stroke-linecap="square"/>`,
      commonDefs,
    );
  return svg(
    560,
    480,
    `<path d="M280 27L533 437H27Z" fill="#d69d35" stroke="#17140d" stroke-width="26" filter="url(#rough)"/><path d="M280 79L475 407H85Z" fill="#c8792d" stroke="#f3d06b" stroke-width="13"/><path d="M280 151l83 143-83 78-83-78Z" fill="#161813"/><circle cx="280" cy="279" r="31" fill="#d7aa48"/><path d="M280 118v66" stroke="#151711" stroke-width="21"/>`,
    commonDefs,
  );
}

function referenceSvg() {
  return svg(
    1600,
    1000,
    `<rect width="1600" height="1000" fill="#080b0a"/><rect width="1600" height="1000" fill="url(#bg)"/><path d="M0 0H1600V1000H0Z" fill="none" stroke="#493725" stroke-width="42"/>
    <g transform="translate(72 70)"><path d="M0 0H1456V860H0Z" fill="#111613" stroke="#846938" stroke-width="7"/><path d="M0 0H1456V128H0Z" fill="#1b211c"/><path d="M0 128H282V860H0Z" fill="#0d110f"/><path d="M282 128H1456V860H282Z" fill="#171c18"/>
    <g fill="#273128" stroke="#8a6e3b" stroke-width="5"><path d="M325 180H840V395H325Z"/><path d="M884 180H1412V395H884Z"/><path d="M325 439H1412V802H325Z"/></g>
    <g fill="#222923" stroke="#57472e" stroke-width="4"><path d="M34 176H248V245H34Z"/><path d="M34 273H248V342H34Z"/><path d="M34 370H248V439H34Z"/><path d="M34 467H248V536H34Z"/></g>
    <path d="M34 370H248V439H34Z" fill="#624329" stroke="#d1a44b" stroke-width="6"/><g fill="#c99d47"><circle cx="71" cy="84" r="35"/><path d="M126 60H370V82H126ZM126 94H297V108H126Z"/></g>
    <g stroke-linecap="round"><path d="M365 331C454 270 508 356 596 281s143 58 203-7" fill="none" stroke="#c19747" stroke-width="18"/><path d="M932 325H1364" stroke="#5a6c5d" stroke-width="38"/><path d="M932 325H1251" stroke="#daa84a" stroke-width="28"/><path d="M374 497H795M374 548H690M374 599H748" stroke="#7d755e" stroke-width="18"/><path d="M895 518H1347M895 575H1278M895 632H1380M895 689H1199" stroke="#5d685d" stroke-width="14"/></g>
    <g fill="#ba8c3f"><circle cx="374" cy="742" r="28"/><circle cx="451" cy="742" r="28"/><circle cx="528" cy="742" r="28"/></g></g>
    <path d="M93 923Q310 860 517 923T935 918T1507 916" fill="none" stroke="#7f5d32" stroke-width="28" opacity=".55"/>
  `,
    `<radialGradient id="bg" cx=".18" cy=".08" r="1"><stop stop-color="#4b4434"/><stop offset=".35" stop-color="#181d19"/><stop offset="1" stop-color="#050706"/></radialGradient>`,
  );
}

const rasterAssets = [
  [
    "frames/frame-heavy-9slice.webp",
    1024,
    1024,
    "Heavy panel border-image source; recommended slice 19%",
    false,
    frameSvg("heavy"),
  ],
  [
    "frames/frame-medium-9slice.webp",
    1024,
    1024,
    "Medium panel border-image source; recommended slice 15%",
    false,
    frameSvg("medium"),
  ],
  [
    "frames/frame-thin-9slice.webp",
    1024,
    1024,
    "Thin panel border-image source; recommended slice 10%",
    false,
    frameSvg("thin"),
  ],
  [
    "frames/frame-active-9slice.webp",
    1024,
    1024,
    "Active panel border-image source; recommended slice 12%",
    false,
    frameSvg("active"),
  ],
  [
    "frames/frame-error-9slice.webp",
    1024,
    1024,
    "Error panel border-image source; recommended slice 12%",
    false,
    frameSvg("error"),
  ],
  [
    "frames/divider-horizontal.webp",
    1024,
    96,
    "Horizontal organic-metal divider",
    false,
    dividerSvg(false),
  ],
  [
    "frames/divider-vertical.webp",
    96,
    1024,
    "Vertical organic-metal divider",
    true,
    dividerSvg(true),
  ],
  [
    "frames/nav-active-drip.webp",
    768,
    180,
    "Active navigation underline ornament",
    false,
    navDripSvg(),
  ],
  [
    "frames/progress-tube-track.webp",
    1024,
    120,
    "Progress tube empty track",
    false,
    progressSvg(false),
  ],
  [
    "frames/progress-tube-fill.webp",
    1024,
    120,
    "Progress tube scalable fill",
    false,
    progressSvg(true),
  ],
  [
    "textures/charcoal-surface.webp",
    512,
    512,
    "Seam-tolerant charcoal surface texture",
    false,
    textureSvg("charcoal"),
  ],
  [
    "textures/organic-mottle.webp",
    512,
    512,
    "Secondary organic machinery mottle",
    true,
    textureSvg("mottle"),
  ],
  [
    "textures/fine-grain.webp",
    512,
    512,
    "Subtle compositing grain",
    false,
    textureSvg("fine"),
  ],
  [
    "textures/vignette.webp",
    1024,
    1024,
    "Transparent edge vignette overlay",
    false,
    vignetteSvg(),
  ],
  [
    "textures/smoke-overlay.webp",
    1024,
    512,
    "Transparent ambient smoke overlay",
    true,
    smokeSvg(),
  ],
  [
    "textures/sparks-overlay.webp",
    1024,
    512,
    "Transparent warm sparks overlay",
    true,
    sparksSvg(),
  ],
  [
    "ornaments/chain-corner.webp",
    512,
    512,
    "Decorative upper corner chain",
    true,
    chainCornerSvg(),
  ],
  [
    "ornaments/tendril-left.webp",
    384,
    768,
    "Decorative left organic-machine tendril",
    true,
    tendrilSvg(false),
  ],
  [
    "ornaments/tendril-right.webp",
    384,
    768,
    "Decorative right organic-machine tendril",
    true,
    tendrilSvg(true),
  ],
  [
    "ornaments/forhud-forevig-medallion.webp",
    640,
    640,
    "Commemorative fantasy machinery medallion",
    true,
    medallionSvg(),
  ],
  [
    "ornaments/forskin-mug.webp",
    640,
    640,
    "Decorative armored Forskin mug",
    true,
    mugSvg(),
  ],
  [
    "ornaments/fgp-dogtag.webp",
    640,
    640,
    "Decorative FGP crest dogtag",
    true,
    dogtagSvg(),
  ],
  [
    "ornaments/sidebar-organic-knot.webp",
    520,
    520,
    "Sidebar knot ornament",
    true,
    knotSvg(false),
  ],
  [
    "ornaments/footer-organic-knot.webp",
    1200,
    260,
    "Footer knot ornament",
    true,
    knotSvg(true),
  ],
  [
    "plaques/plaque-rusted-small.webp",
    640,
    320,
    "Compact rusted content plaque",
    true,
    plaqueSvg("small"),
  ],
  [
    "plaques/plaque-rusted-wide.webp",
    1200,
    320,
    "Wide rusted content plaque",
    true,
    plaqueSvg("wide"),
  ],
  [
    "plaques/plaque-torn.webp",
    900,
    360,
    "Irregular torn-edge fantasy plaque",
    true,
    plaqueSvg("torn"),
  ],
  [
    "plaques/sticker-graffiti.webp",
    640,
    360,
    "Abstract path-only graffiti sticker",
    true,
    stickerSvg("graffiti"),
  ],
  [
    "plaques/sticker-warning.webp",
    560,
    480,
    "Path-only warning sigil sticker",
    true,
    stickerSvg("warning"),
  ],
  [
    "reference/forskin-mode-reference.png",
    1600,
    1000,
    "Generated implementation style board, not an external reference",
    true,
    referenceSvg(),
  ],
];

async function renderRaster([path, width, height, role, lazy, source]) {
  const target = join(outputDir, path);
  const pipeline = sharp(Buffer.from(source)).resize(width, height, {
    fit: "fill",
  });
  if (extname(path) === ".png") {
    await pipeline
      .png({ compressionLevel: 9, palette: true, quality: 88, effort: 10 })
      .toFile(target);
  } else {
    await pipeline.webp(WEBP_OPTIONS).toFile(target);
  }
  return { path, role, lazy };
}

async function inspectAsset(path, role, lazy) {
  const absolute = join(outputDir, path);
  const [file, metadata] = await Promise.all([
    stat(absolute),
    sharp(absolute).metadata(),
  ]);
  return {
    path,
    bytes: file.size,
    width: metadata.width,
    height: metadata.height,
    role,
    lazy,
    provenance: RASTER_SOURCE,
  };
}

async function inspectSvg(path, role, lazy) {
  const absolute = join(outputDir, path);
  const [file, source] = await Promise.all([
    stat(absolute),
    readFile(absolute, "utf8"),
  ]);
  const viewBox = source.match(
    /viewBox="[\d.-]+\s+[\d.-]+\s+([\d.-]+)\s+([\d.-]+)"/,
  );
  if (!viewBox) throw new Error(`${path} must declare a numeric viewBox`);
  return {
    path,
    bytes: file.size,
    width: Number(viewBox[1]),
    height: Number(viewBox[2]),
    role,
    lazy,
    provenance: STATIC_SOURCE,
  };
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const rendered = [];
  for (const asset of rasterAssets) rendered.push(await renderRaster(asset));

  const assets = [];
  for (const asset of staticAssets) assets.push(await inspectSvg(...asset));
  for (const asset of rendered)
    assets.push(await inspectAsset(asset.path, asset.role, asset.lazy));
  assets.sort((a, b) => a.path.localeCompare(b.path));

  const initialBytes = assets
    .filter((asset) => initialSubset.has(asset.path))
    .reduce((sum, asset) => sum + asset.bytes, 0);
  const fullBytes = assets.reduce((sum, asset) => sum + asset.bytes, 0);
  if (initialBytes >= INITIAL_LIMIT)
    throw new Error(
      `Initial asset subset is ${initialBytes} bytes; limit is ${INITIAL_LIMIT} bytes`,
    );
  if (fullBytes >= FULL_LIMIT)
    throw new Error(
      `Full asset pack is ${fullBytes} bytes; limit is ${FULL_LIMIT} bytes`,
    );

  const manifest = {
    schemaVersion: 1,
    theme: "forskin",
    generatedBy: relative(rootDir, fileURLToPath(import.meta.url)).replaceAll(
      "\\",
      "/",
    ),
    deterministic: true,
    referenceNote:
      "reference/forskin-mode-reference.png is a generated implementation style board because no external reference was attached.",
    license:
      "Original project artwork. May be used, modified, and redistributed with this project under the project license. No third-party artwork is included.",
    budgets: {
      initial: {
        bytes: initialBytes,
        limitBytes: INITIAL_LIMIT,
        assets: [...initialSubset].sort(),
      },
      full: {
        bytes: fullBytes,
        limitBytes: FULL_LIMIT,
        excludes: ["ASSET-MANIFEST.json"],
      },
    },
    assets,
  };
  await writeFile(
    join(outputDir, "ASSET-MANIFEST.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  console.log(`Forskin assets generated: ${assets.length} files`);
  console.log(`Initial subset: ${initialBytes} bytes / ${INITIAL_LIMIT} bytes`);
  console.log(`Full pack: ${fullBytes} bytes / ${FULL_LIMIT} bytes`);
}

await main();
