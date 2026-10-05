# Banner source

Automedia source for `../banner.png`: one static HTML/CSS block, 1600×560, exported as PNG at 0 s.

- `minv-banner.automedia` is a complete Automedia project snapshot, including the fonts. Import it to edit the banner.
- `index.html`, `style.css`, `script.js` and `composition.json` are plain-text copies of the same block, kept so changes are easy to diff.

The colors are the dark theme of Minv Signal from `desktop/design-tokens.json`. The layout follows `docs/DESIGN.md`: no grid, glow, or panel shadow, and lime only on meaning. The mark is inlined from `media/brand/mark.svg`. Fonts are the renderer's vendored OFL files from `desktop/renderer/assets/fonts/` (Instrument Sans, Martian Mono, Commit Mono). The block loads them from the composition's `assets/` folder. If the tokens change, update the `:root` block in `style.css` and export again.

The repository rows come from the desktop smoke fixture in `scripts/desktop-smoke.mjs`. They're laid out for the banner, so they aren't a screenshot. The real screenshot is `../minv-desktop.png`.
