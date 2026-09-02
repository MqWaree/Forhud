# Forskin Mode

Forskin mode is an original fantasy organic-machinery presentation layer for the dashboard. Its materials are charcoal, aged iron, warm gold, muted verdigris, smoke, and abstract tendrils. The artwork avoids gore and explicit anatomy. Lighting is consistently strongest at the top left, with darker lower-right edges.

## Architecture

The pack separates UI structure from decoration. Frames, dividers, progress parts, and core icons are eager UI primitives. Textures establish depth. Ornaments, plaques, stickers, smoke, and sparks are optional atmosphere and should be loaded only where used. Application components own semantics and state; images never encode operational labels, values, or instructions.

The deterministic build entry point is `apps/dashboard/scripts/generate-forskin-assets.mjs`. It resolves Sharp with `createRequire` based at `apps/server/package.json`, so the dashboard does not gain a package dependency. Procedural SVG recipes are rendered directly through Sharp to WebP or PNG. The run regenerates raster files, reads the hand-authored path SVGs, records dimensions and byte sizes, and emits `ASSET-MANIFEST.json`.

Theme preferences are validated and stored locally under `fgp.ui.theme.v1`. The application has no server-side per-user preference store, so the browser preference remains available across sign-out and later sign-in on the same browser without changing workspace settings. `theme-bootstrap.js` applies the stored mode before the application paints; `ForskinThemeProvider` owns live updates and the `data-theme`, `data-forskin-copy`, and `data-forskin-motion` root attributes.

## Storage

Assets live under `apps/dashboard/public/assets/themes/forskin/` and are addressed from the dashboard as `/assets/themes/forskin/<group>/<file>`. Groups are `branding`, `frames`, `textures`, `ornaments`, `plaques`, `icons`, and `reference`. Keep component code free of data URIs so browser caching and lazy loading remain available.

## Assets

The 1024 by 1024 frame sources have transparent centers and are intended for CSS `border-image`. Recommended slices are in each manifest role: heavy 19%, medium 15%, thin 10%, active and error 12%. Do not stretch the entire frame as a background. Dividers may be sized along their long axis. The tube track is fixed behind the fill; crop or scale the fill horizontally to represent progress.

Opaque surfaces are `charcoal-surface.webp` and `organic-mottle.webp`. `fine-grain.webp`, `vignette.webp`, `smoke-overlay.webp`, and `sparks-overlay.webp` are compositing layers. Preserve WebP alpha on frames and decorative overlays. `grid-mask.svg` can repeat at its native 256 by 256 view box.

## Copy

Keep all meaningful copy in HTML so it remains searchable, localizable, responsive, and accessible. Plaques and stickers are blank or symbolic by design. Decorative slogans are centralized in `apps/dashboard/src/themes/forskin/forskinCopy.ts` and can be disabled in Settings. Overlay concise real labels from application data; never bake status, metrics, controls, generated-looking glyphs, or placeholder copy into artwork. The wordmark is constructed from paths to avoid font and rendering dependencies.

## Motion

Use restrained motion that reinforces material weight: short 140-220 ms control transitions, slow smoke drift, occasional spark passes, and subtle active-frame luminance. Do not continuously wobble frames or tendrils. Under `prefers-reduced-motion: reduce`, disable smoke and spark translation, remove decorative pulses, and retain only immediate state changes.

## New Components

Choose the least ornate frame that communicates hierarchy. Reserve heavy frames for major regions, medium for grouped panels, thin for repeated cards, active for selection, and error only for actionable failures. Use ornaments as edge anchors rather than content. New art should use the same top-left highlight, lower-right shadow, iron/gold/verdigris palette, path-only symbols, transparent canvas where appropriate, and deterministic source recipe. Add every new file to the generator metadata and manifest budget calculation.

## Performance

The generator enforces an initial subset below 1.5 MiB and the complete declared pack below 5 MiB. The manifest identifies lazy assets and records exact bytes. Eagerly preload only branding, structural frames needed above the fold, charcoal, fine grain, vignette, and core icons. Lazy-load ornaments, plaques, secondary mottle, smoke, sparks, and the style board. Avoid displaying assets above source resolution. Large ornaments are omitted at compact viewport widths and on constrained connections rather than fetched invisibly. Visual baselines and Playwright output are retained for development but excluded from production release archives.

## Accessibility

Decorative artwork should use empty alternative text in HTML or CSS backgrounds. When an icon is the only control label, give the control an accessible name; SVG titles are fallback descriptions, not a replacement for button text or `aria-label`. Never communicate active, success, warning, or error state through color or frame decoration alone. Maintain text contrast over textured surfaces with an opaque content backing. Motion guidance must honor reduced-motion preferences.

## Reference Status

No attached external reference was available for this work. `reference/forskin-mode-reference.png` is therefore a generated implementation style board assembled from the pack's original design language. It documents a possible composition and must not be described as source reference art, a recreation, or evidence of visual matching.

## Provenance And License

All artwork in this pack and all procedural SVG recipes are original project work. No third-party imagery, traced artwork, proprietary marks, external reference assets, or generative-model image outputs are included. The artwork may be used, modified, and redistributed with this project under the project's license. Regenerate it from the repository root with `node apps/dashboard/scripts/generate-forskin-assets.mjs`.
