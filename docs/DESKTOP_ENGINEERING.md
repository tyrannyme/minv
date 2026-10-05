# Standalone desktop engineering

**Minv** stands for **Min**imal **V**S Code. This name meaning is a fixed branding decision from Kaf.

The product goal is all applicable Linux P0/release requirements in MINV_PRD.md. The extension prototype remains a development harness; it does not meet the product shell/removal gate.

The standalone implementation retains a reproducible, source-built Code-OSS editor closure from the pinned upstream revision and replaces the upstream workbench/main/shared/extension-host runtime with a Minv-specific Electron shell. Source files, assets, and notices included in the product must have recorded provenance and an auditable bundled dependency graph. This is a source-derived focused fork, not a rebranded stock binary or a hosted website.

Claude is the authoritative product designer. `docs/DESIGN.md` and `docs/DESIGN_CONTRACT.md` govern renderer composition and interactions. Engineering must satisfy those decisions and preserve the PRD's correctness, performance and accessibility requirements. If a real conflict occurs, surface it with evidence rather than silently reverting to stock workbench UI.

## Ownership

- Claude: desktop/renderer, design tokens, media/brand, design contract.
- Parent: desktop/main, desktop/preload, main-renderer adaptation, root build/dependency tooling, packaging, CLI and integration.
- Fork build agent: desktop/editor, scripts/editor-*, source closure/provenance audit.
- Git agent: core/operations and P0 Git operation tests/API.
- Runtime agent: passive Git sandbox and execution tests.
- File agent: core/files, core/search, recovery and filesystem tests/API.
- Benchmark agent: fixtures, real-scale measurement, benchmark evidence.
- Review agent: requirement ledger and independent release tests.

## Process boundary

The renderer has no Node integration and runs sandboxed with context isolation. A typed preload exposes a fixed request/event interface; never arbitrary filesystem, process, shell or module APIs. Main owns approved workspace roots, repository identities, document versions, trust state, mutation review tickets, cancellation and resource limits. Renderer-supplied repository/path/state claims must be validated against current main-process state.

All navigation/new-window requests are denied unless a narrow intended destination is explicitly handled. Content Security Policy and a private application protocol keep renderer scripts/assets local. Editor workers are local and included in the source audit. No extension marketplace, arbitrary executable extension loading, model/provider configuration, terminal/debug adapter or runtime chat/agent service ships.

Settings, cache, and unsaved-buffer recovery use distinct Minv-only paths. User-selected workspaces are the only file roots; Git-resolved metadata outside a checkout is handled by the repository service rather than general renderer filesystem authorization. Git writes and external handoff are explicit, scoped actions. No scan or file open triggers network activity.
