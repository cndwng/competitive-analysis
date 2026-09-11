# competitive-analysis

Orchestrates a design-led competitive analysis end-to-end. One skill + two agents + a deterministic block renderer for Figma.

## What it does

Takes a comp-analysis ask and runs it through six phases:

1. **Phase 0 — Setup**: pick scan type (marketing / flow / combined deep-dive), preflight Figma + Mobbin MCPs, gather inputs, pick dimensions
2. **Phase 1 — Competitor list**: tiered list (A/B/C/D), get sign-off, lock search vocabulary per source
3. **Phase 2 — Pilot one**: dispatch one capture agent, render the block, review with user before fan-out
4. **Phase 3 — Parallel scout + render**: fan out remaining competitor-capture agents in parallel, render each block via the deterministic renderer
5. **Phase 5a — Facts review**: surface extracted facts (no takeaways), pause for direction
6. **Phase 5b — Synthesis**: dispatch synthesis-writer agent to land the final Notion deliverable

## What's in the plugin

| File | Purpose |
|---|---|
| `skills/competitive-analysis/SKILL.md` | Orchestrator skill — main entry point |
| `agents/competitor-capture.md` | Per-competitor scout. Returns a manifest YAML. **Does not write to Figma.** |
| `agents/synthesis-writer.md` | Synthesis writer. Produces the final Notion deliverable from per-competitor manifests + user direction |
| `scripts/competitor-manifest-schema.md` | Schema doc for the manifest format |
| `scripts/competitor-block-renderer.js` | Deterministic Figma block renderer — takes a manifest, builds the block by code (no LLM layout improvisation) |
| `scripts/pre-measure.sh` | Bash helper: reads PNG dims via `identify`, fills aspect-correct `width`/`height` in manifest, splits any image >1.5 MB into vertical halves |
| `scripts/build-competitor-block.md` | Orchestrator pipeline doc: 7 steps from manifest → rendered block |

## Architecture

**Capture agents return manifests, not Figma writes.** Layout consistency comes from the deterministic renderer (constants in code, validator rejects bad manifests). Agent's job is exclusively capture quality.

**Why this matters**: earlier comp-analysis runs hit layout drift (brand on top vs left, columns at random x, sections not wrapping content), aspect crop (frames sized arbitrarily, FILL mode cropping image content), cross-page contamination (agents writing to wrong page), generic frame names (`img_0_0`), Mobbin product screens mislabeled as "Marketing — /pricing", `scalingFactor: 0.5` left over → image at half size, >1.5 MB images blank in canvas, section bounds not updated after frame resize. The renderer fixes all of these by code, not LLM choice.

## Install

```
/plugin install competitive-analysis@gusto-gists
```

## Requirements

- **Figma MCP** (`plugin:figma:figma`) for block rendering
- **Mobbin MCP** for flow scans (optional but strongly recommended)
- **Notion MCP** for synthesis writeup
- **Local tools**: `npm` (puppeteer install), `ImageMagick` (`identify` + `magick`), `ffmpeg`, `yt-dlp`, `jq`, `sips`

## What it doesn't do

- Doesn't scout external knowledge (Glean / Notion teardowns / Drive) — does prior-art check at Phase 0 but doesn't deep-research existing internal work
- Doesn't handle FigJam destinations (Figma design files only)
- Doesn't auto-export to other tools (Slides, Confluence) — pairs with destination-specific skills

## Standing rules for the renderer

1. Capture agents NEVER write to Figma directly. Renderer is the only Figma writer.
2. Manifests validated by code: rejects generic labels (`img_N_M`), missing `source_url`, missing dims (run pre-measure), duplicate column titles, empty `sourcing_gaps`.
3. Every image fill has `scalingFactor: 1` explicit (renderer + post-process). `upload_assets` defaults to 0.5 which renders images at half size inside their frames.
4. Images >1.5 MB split into vertical halves at full native width (Figma canvas size limit).
5. Section wrapper at `#444444` fill, sized to content + 100px padding.
6. Page name guard: renderer refuses to write to a page whose name doesn't match the manifest's competitor.

## License

Internal Gusto plugin. Not for public distribution.
