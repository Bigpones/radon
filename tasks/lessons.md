# Lessons

## 2026-03-11

- When a marketing-site card uses split metric tiles with large mono values, treat each tile as a constrained layout container: add `min-w-0` and wrapping rules up front so long tokens cannot bleed across the grid boundary at desktop widths.
- When closing a refactor roadmap, do not leave concrete residual chart-contract gaps only in the final prose; capture them immediately as follow-up tasks with explicit verification targets so the next pass starts from an auditable backlog instead of a narrative summary.
- When a new operator-facing regime label is added to `/regime`, document the state definitions and classification rule in the README and the relevant strategy docs in the same change; do not leave the meaning trapped in code or tooltips.
- When an operator is comparing two regime inputs for signal value, do not stop at parallel time-series lines; add a relationship-first view that makes spread, divergence, and quadrant state explicit.
- For dashboard charts that encode time or magnitude, always include visible axis/tick context or equivalent scale labels; a line-only chart is insufficient for operator interpretation.
- For index-style live feeds, do not assume the broker `close` field is the correct prior-session anchor for a day-over-day UI calculation; compare it against the cached official close from the authoritative daily source before using it in the strip.
- When shipping theme support, audit SVG/chart surfaces and their companion meta panels separately from the shell; hardcoded chart gradients can stay dark even after the page chrome switches to light mode.
- For UI tooltip copy, describe what the operator is seeing and why it matters; do not surface implementation details like charting libraries, websocket feeds, or transport mechanics unless the user explicitly asks for them.
- When a shared `section-header` uses `justify-content: space-between`, never leave a help icon as its own sibling between the title and a right-side status badge; wrap the title and icon into a left cluster.
- When a user asks for docs and a commit checkpoint after a fix, update the relevant docs and create the scoped commit before starting the next feature; do not roll the follow-up feature into the same uncommitted batch.
- When a user reports that a cache-backed bug fix still is not visible, verify the actual on-disk artifact and refresh path immediately; a correct code path is not sufficient if the generated cache never updated successfully.
- When a user reports that a cache-backed UI is still stale after a code fix, verify the on-disk artifact shape and the refresh path before declaring the bug closed; a correct code path is not enough if the live cache never refreshed successfully.
- When a user provides an authoritative upstream fallback source, replace the generic last-resort source in both code and docs immediately; do not keep Yahoo ahead of a vendor-native feed just because it already exists in the codebase.
- When a user provides an authoritative market-data fallback source, move that source ahead of generic last-resort providers in both code and docs immediately; do not leave Yahoo as the fallback if the product spec now requires a stronger primary source.
- When a user corrects a claim about live market-data availability, verify the actual subscription and render path before blaming the provider; the UI may simply be ignoring a live IB field that is already subscribed.
- When matching an existing metric-card pattern, copy the card’s information hierarchy, not just the data source: main value, then daily move line, then muted context subline.

## 2026-03-10

- When a user reports a performance-vs-portfolio mismatch, verify both route freshness windows and the exact ledger date format before trusting a reconstructed equity curve; stale caches and `YYYYMMDD` trade dates can invalidate the anchor logic.
- When documenting or automating IBC control in this repo, treat the canonical service as the secure machine-local wrappers under `~/ibc/bin/`, not as a repo-owned service.
- Repo scripts for IBC remote control must be described as convenience wrappers around `/Users/joemccann/ibc/bin/*secure-ibc-service.sh`, never as the primary service implementation.
- For market index integrations, do not assume a daily historical bar matches the authoritative displayed value on the exchange dashboard; verify the exact field semantics against the live source before wiring the signal.
- For repo changes that touch a monorepo with separate deploy targets, check whether deployment filters are needed so unrelated pushes do not rebuild unaffected apps.
- When a generated output directory appears in the worktree and should not be versioned, add an explicit root `.gitignore` entry immediately instead of leaving it as recurring untracked noise.
- When collaborating on parallel changes in this repo, treat any file the user says they already changed as reserved unless a direct integration change is unavoidable; design around the declared contract first to avoid stomping concurrent work.
- When fixing Codex skill manifests, validate the YAML frontmatter types directly; bracketed placeholder text after `description:` becomes a YAML sequence and the loader expects a plain string.
