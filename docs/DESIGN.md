# Minv design: Signal

**Minv is Minimal VS Code.** The editor engine is Code-OSS; everything around it is Minv's own. The design aims for one reaction: *this cannot be a VS Code fork.*

This document is authoritative for the renderer (`desktop/renderer/`), tokens (`desktop/design-tokens.json`) and brand (`media/brand/`). The host contract is in [DESIGN_CONTRACT.md](DESIGN_CONTRACT.md).

## Direction

Minv Signal is a monochrome instrument. Surfaces are cool graphite (dark by default) or crisp neutral white. **Colour is spent only on meaning:**

- Git states: modified, added, deleted, untracked and conflict.
- One volt-lime signal (`accent`) for the brand, focus, the primary action and live counts.

Everything else is typography and structure.

The previous Ink/Paper direction (serif, paper, desk metaphor, beige and copper) is retired. Old preference values migrate automatically (`normalizeAppearance`).

| Principle | In practice |
| --- | --- |
| Instrument, not IDE | Readouts in Martian Mono caps: `61/61 VERIFIED`, `STAGED 2`, `HUNK 1 OF 2`. Numbers are real observations or a dash. |
| Islands on a canvas | Three rounded panels (map, inspector, stage) float on the canvas with 8 px gaps under a single command bar. No activity bar, status bar, panel area or stock title bar. |
| One next action | The lime fill is used once per context: the current hunk's *Stage hunk*, *Commit*, *Open folder*. |
| Shape before colour | Freshness glyphs differ by shape; unverified values are italic; high contrast adds outlines and diff edge bars. |
| Calm | No spinner walls, no shifting rows, no toasts for routine success except a brief dark pill. |

## Exceptions, not confirmations

Kaf's review (2026-10-05): the first Signal build showed too much. The rule since then is that **a healthy workspace is quiet**. Minv shows a fact when it needs attention and stays silent when it only confirms that things are fine.

- No "verified", "clean", "in sync", "checked just now" or "discovery complete" text. Fresh and clean are the default and need no label.
- Stale, checking, offline, unreadable, ahead/behind, changes, conflicts, restricted mode and degraded watching always show, as before. Hiding a confirmation never hides an unverified state (PRD §9 still holds).
- One adaptive sync button (Fetch, or Pull ↓n / Push ↑n when that's the useful action). Everything else is in ⋯ or the palette.
- The commit form appears once something is staged or a message is drafted. The editor footer names encoding and line endings only when they aren't UTF-8 and LF. Tabs name their repository only when two tabs share a file name. Default branches (`main`, `master`) are dimmed so feature branches stand out.
- The empty desk lists work in progress and unsaved drafts, plus three keys. It's not a dashboard.

## Composition

```
┌ command bar: mark · workspace · ───[ Go to anything  Ctrl K ]─── · 61/61 VERIFIED · 1 OFFLINE · 35 CHANGED · ─ □ × ┐
│ ┌ Repository map ┐ ┌ Inspector ───────┐ ┌ Stage: chips ─────────────────────────────────┐ │
│ │ Find  /        │ │ tyranny / minv   │ │ [DIFF status.ts minv ×] [status.ts minv ×]    │ │
│ │ 62 REPOSITORIES│ │ minv             │ │ ┌ editor island ─────────────────────────────┐ │ │
│ │ ● name  branch │ │ (feature/x ⌄)    │ │ │ minv / src/core/ · status.ts               │ │ │
│ │   …  virtual   │ │ Changes·Files·…  │ │ │ Code-OSS editor or Minv review             │ │ │
│ │ Discovery ✓    │ │ commit slip      │ │ │ Ln 1, Col 1 · UTF-8 · LF · TypeScript      │ │ │
│ └────────────────┘ └──────────────────┘ │ └────────────────────────────────────────────┘ │ │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Repository map** (`index`): a virtualized tree or flat list. Rows never move during refresh. Each row shows a freshness glyph, the name, the branch as a readout, and the change count (or `CLEAN` once established). Pinned repositories come first and carry a lime `PIN` tag.
- **Inspector** (`folio`): the repository name at 24 px, the branch as a chip (which opens the branch switcher), upstream ahead/behind, freshness sentences, and remote actions. Below sits a segmented control for Changes, Files, History and Search. The commit slip names its exact target: *Commit to **minv** on `feature/desktop-shell`*.
- **Stage** (`desk`): chips for open documents. Each chip carries a kind tag (`DIFF`, `STAGED`, `COMMIT`, `COMPARE`) and its owning repository. The editor island below holds the Code-OSS editor, the review redline, commit detail, a comparison or settings. With nothing open it shows the **Overview**: large honest readouts (branches verified, repositories with changes, unavailable checkouts, discovery state), work in progress, and keys.
- **Welcome** (no workspace): a hero lockup plus “**Min**imal **V**S Code.”, with the lime highlight marking the letters that make the name. Then Open folder, Recent, and drafts.

## Typography

| Role | Face | Use |
| --- | --- | --- |
| UI | Instrument Sans (variable, 400–700) | All interface text; headlines 600–650 with tight tracking (−0.03 to −0.065 em). |
| Readout | Martian Mono at 87.5 % width | Branches, counts, hashes, paths in headers, caps labels (10 px, +0.08 em), keycaps. |
| Code | Commit Mono | Editor, diffs, commit messages, dialogs' path lists. |

All three ship in `desktop/renderer/assets/fonts/` with their OFL licenses. No network fonts.

## Colour

Tokens live in `desktop/design-tokens.json`; `scripts/tokens.mjs` generates `desktop/design-tokens.css` and vendors fonts. Theme ids: `system` (default), `dark`, `light`, `dark-contrast`, `light-contrast`. `system` follows `prefers-color-scheme` and `prefers-contrast`.

| Token | Dark | Light | Job |
| --- | --- | --- | --- |
| canvas | `#0a0b0d` | `#eceef2` | Window background; Electron `backgroundColor`. |
| surface / raised / sunken | `#111216` `#181a1f` `#0d0e11` | `#fff` `#f6f7f9` `#f2f3f6` | Islands; selected rows and chips; inputs and segmented tracks. |
| border / line | `#24272e` `#1d2026` | `#dcdfe6` `#e8eaef` | Defined edges, never combined with wide soft shadows on panels. |
| fg / fg2 / fg3 | `#eceef2` `#a9aebb` `#80869a` | `#0d0f12` `#4a505c` `#636977` | Text tiers; fg3 ≥ 4.5:1 on its surface. |
| accent / onAccent | `#d2f74a` / `#0b0d05` | `#c8f135` / `#0b0d05` | Lime fills with near-black text. |
| accentText / focus | `#d2f74a` | `#4a6800` | Lime as text or focus ring (dark green in light for contrast). |

State colours are paired with letters (M, A, D, U, !, S), and washes have their own text colours. Syntax uses a restrained cool palette (violet keywords, mint strings, sky types, amber numbers), mapped into the Code-OSS theme by `themeFromTokens()` so the editor and the shell never drift.

## State vocabulary (PRD §9)

| State | Glyph | Text treatment |
| --- | --- | --- |
| Observed | small solid dot | upright value, “checked 12 s ago” |
| Cached / unverified | ring | *italic*, fg3 |
| Refreshing | rotating arc (dotted ring with reduced motion) | previous value kept |
| Stale | half-filled amber ring | *italic*, “may be out of date” |
| Unknown | dash | `—`, never `0` or `CLEAN` |
| Error / unavailable | red cross / dashed ring | specific reason and next step |

Counts use `CLEAN` only after a successful observation, `12+` when partial and `!` on error. The bar's `—` CHANGED means nothing has been scanned yet.

## Interaction

Keyboard first. Every action is reachable from the palette (`Ctrl K`; `>` lists commands).

| Keys | Action |
| --- | --- |
| `Ctrl K` / `Ctrl P`, `Ctrl ⇧ P` | Go to anything / commands |
| `/` | Find repository |
| `Ctrl 1 2 3`, `F6` | Focus map, inspector, editor |
| `Alt 1–4` | Changes, Files, History, Search |
| Arrows, `Enter`, `←/→` | Move, open, collapse/expand or go to the inspector |
| `Space` · `E` · `Del` | Stage/unstage, edit, discard (confirmed, backed up) |
| `J/K` · `S/U` | Next/previous hunk · stage/unstage it |
| `Ctrl ⏎` | Commit |
| `Ctrl S` · `Ctrl W` · `Ctrl \` · `Ctrl B` · `Ctrl Tab` | Save, close, split, focus mode, cycle documents |
| `Ctrl ⇧ B` · `Ctrl ⇧ F` · `Ctrl ,` · `Ctrl R` | Branches, workspace search, settings, refresh |

Write safety is visible in the UI:

- Actions are disabled until the status they act on is verified.
- Every write ticket is bound to what is on screen: review ids for diffs, status generation for lists.
- Destructive dialogs default to Cancel and list exact paths.
- A stale ticket re-reads and explains instead of acting.

## Accessibility and motion

- The map is a `tree` with `aria-activedescendant` virtualization. Rows carry full spoken labels (branch, freshness, operation, change count, monitoring).
- Announcements go through one polite live region.
- Focus rings are 2 px, using `focus`.
- Reduced motion (system or setting) removes all animation; the refreshing glyph becomes a static dotted ring.
- High-contrast themes add outlines to selection and edge bars to diff lines. `forced-colors` is respected.

## Anti-slop check

The design deliberately has:

- no grid backgrounds, glass, blur or glow;
- no accent strips on cards and no stripe fills;
- no doodle illustrations;
- elevation only on overlays (palette, dialogs, menus, notices);
- radii of 8 px for controls and rows, 14 px for islands and 16 px for overlays.

## Brand

- `media/brand/mark.svg`: the in-app mark, a rounded tile with an “m” standing on three repositories; the third dot is the signal.
- `media/brand/minv.svg`: the app icon. Use it for packaging.
- The old `media/minv.svg` is legacy.
- The wordmark is lowercase **minv** in Instrument Sans 650, tracking −0.035 em.
- Always expand the name as **Minimal VS Code**.

## Screenshots

Captured from the standalone renderer (preview fixture with real Minv source, source-built Code-OSS editor) in `desktop/renderer/screenshots/`:

1. `01-overview-dark.png`: overview readouts.
2. `02-review-dark.png`: redline review with hunk staging.
3. `03-editor-dark.png`: Code-OSS editor in Signal.
4. `04-cold-start-freshness.png`: cached, checking and verified states during startup.
5. `05-light-palette.png`: command palette, light.
6. `06-light-split-review.png`: side-by-side review, light.
7. `07-welcome.png`: no workspace.
8. `08-dark-high-contrast.png`: dark high contrast.

## Running the renderer standalone

```sh
npm --prefix desktop/renderer install   # three font packages only
npm --prefix desktop/renderer test      # tokens + fixture manifest + tsc + tests
npm --prefix desktop/renderer run serve # http://127.0.0.1:4319/desktop/renderer/preview.html
```

The preview uses the real source-built editor from `desktop/editor/generated` when present. `preview.html` is never shipped.
