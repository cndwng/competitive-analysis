---
name: competitive-analysis
description: Orchestrate a design-led competitive analysis. Gathers inputs, builds the competitor list with the user, dispatches parallel competitor-capture agents (manifest-returning, no Figma writes), renders each block via the deterministic block-renderer, runs a facts-review pause, then dispatches a synthesis-writer. Use when the user says "do comp analysis for X", "find what's out there for Y", "audit how others handle Z", or any variant of "let's see what competitors do".
---

# Competitive analysis

Orchestrates the comp analysis end-to-end. **You are the conductor** — the user is in the loop for input gathering, competitor selection, pilot review, and facts review. Per-competitor capture fans out to dedicated agents that return **manifests only** (no Figma writes). You render each block via the deterministic renderer.

## Architecture

| Component | Role | Context |
|---|---|---|
| This skill (you) | Inputs, list, dispatch logic, manifest pre-measure + render, facts review | Main conversation (with user) |
| `competitor-capture` agent (×N parallel) | Per-competitor scout + capture + Summary write. Returns manifest. **No Figma writes.** | Fresh per competitor |
| `${PLUGIN_ROOT}/scripts/competitor-block-renderer.js` | Deterministic Figma block builder. Takes manifest, returns frame upload plan. | use_figma JS template |
| `${PLUGIN_ROOT}/scripts/pre-measure.sh` | Reads dims via `identify`, caps display width at native (no upscale), slices too-heavy/too-tall images into `pieces` (renderer stitches them into one frame), de-dupes byte-identical images, fills `width`/`height`. | Bash helper |
| `synthesis-writer` agent (×1) | Methodology + synthesis docs after facts review | Fresh context |

Load any user-specific defaults at start (e.g. preferred output destinations, Figma file conventions). User memory may carry pre-fills for output destinations — apply them, otherwise ask.

## Single-competitor capture (fast path)

If the user just wants screens from **one specific competitor** (e.g. "grab Mercury's onboarding into Figma"), don't run the full orchestration. Skip Phase 1 (tier list-building), the pilot, Phase 4 (inspiration), and Phase 5 (facts review + synthesis). Instead:

1. **Trimmed intake** — confirm just: the competitor, which dimensions to capture, scan type, and the Figma destination. (Skip the "who it's for / why / what you're trying to learn" framing — there's nothing to synthesize.)
2. **Dispatch one `competitor-capture` agent** (briefing format in Phase 3).
3. **Run the renderer pipeline** on the returned manifest, then **review with the user**.
4. Offer a writeup only if they ask — default is just the captured Figma block.

This is also the path used by "After synthesis → spawn a deep-dive for a single competitor." If midway it turns out they want the broader picture, offer to expand into the full flow.

## Phase 0 — Setup (with user)

**Phase 0 is a fixed intake script.** Run the steps below **in order, every time**, using the exact modality specified. Don't skip or improvise the questions. You *may* infer answers from the user's original request when they gave detail there — confirm rather than re-ask. Phase 1 can't start until every REQUIRED field (see "Before moving on") is captured; if a required answer is vague, propose a default and get explicit confirmation.

**Talk to the user in plain, conversational language.** The step names, field names, and labels below (preflight, prior-art, ICP, gate, manifest, dimensions-as-columns) are *your* internal vocabulary — don't say them to the user. Ask "who's this for?" not "what's the ICP?"; say "let me check for existing work on this" not "running the prior-art gate."

### Modality rule (how to ask each field)

- **Closed, known option set** → `AskUserQuestion` (select / multiSelect).
- **Open / unbounded** (prose, names, hypotheses, file paths) → **free text**, asked conversationally.
- **Propose-then-edit** (options derived from earlier answers) → `AskUserQuestion` multiSelect, defaults pre-checked, "Other" to add.

### Step 1 — Context (free text, conversational)

Ask these as free text, in order. Lead with the first as one opening message; ask the next two as the conversation moves. **Pre-fill anything the user already gave in their request and confirm it instead of re-asking** — don't make them repeat themselves.

1. **What it is + who it's for + why** — what's the feature or product, what's it meant to do, who's it for, and why are you building/exploring it? (a couple lines)
2. *After they answer:* **What are you trying to learn?** — the question or decision this analysis should help with.
3. *Then:* **Any other context?** — docs, prior research, links, competitors already on your mind. (optional)

Wait for each answer before continuing. Only the feature itself is required here; the rest is helpful but optional (see "Before moving on").

### Step 2 — Check destinations are live (do before searching for existing work)

Verify the MCP tools this run needs are live: Figma (`use_figma`, `upload_assets`, `get_screenshot`, `get_metadata`), Mobbin (`mcp__mobbin__search_screens`), Notion (`notion-create-pages`) / Drive for synthesis. Missing → **say so plainly** ("Looks like Figma isn't connected — mind running `/mcp` to hook it up?"), don't silently fall back. Scan type isn't chosen until Step 4, so check Mobbin by default — it's only skippable for a pure `marketing-scan`.

> **Figma prerequisite (common tester gotcha):** `use_figma` / `upload_assets` / `create_new_file` / `get_screenshot` are tools from the **official, write-capable Figma MCP server** — not a custom plugin anyone built. They run JavaScript via Figma's own Plugin API. The older read-only Figma Dev Mode MCP (exposes `get_figma_data` / `get_node_info`, no `use_figma`) **can't render the blocks** — if a tester only has that one, the fix is to connect the write-capable official Figma MCP, not to hunt for a plugin.

### Step 3 — Check for existing work (do it, don't just ask)

- **Actively search** Glean / Notion / Drive for existing teardowns of this space.
- Ask for competitor shortlists, PM/eng direction, related design files.
- Cite and reuse what you find. (Often surfaces an existing Figma file or doc you can offer as the destination in Step 4.)

### Step 4 — Structured choices (one `AskUserQuestion` call, these 4)

| # | Question | Modality | Options | Default |
|---|---|---|---|---|
| 5 | Scan type | select (1) | combined-deep-dive · marketing-scan · flow-scan | combined-deep-dive |
| 6 | Analysis dimensions (= block columns) | multiSelect | *propose 3–5 derived from the feature* (e.g. Marketing site · Setup flow · In-app management · Brand positioning) · + "Other" to add | all pre-checked |
| 7 | Figma destination | select (1) | new blank file · paste existing URL | new blank file |  *(new file → build a Cover page first, see [New Figma file setup](#new-figma-file-setup))* |
| 8 | Synthesis destination | select (1) | new Google Doc · new Notion doc · new Google Slides · shareable HTML · somewhere else · skip | ask — pick by need (see below) |

**Scan types** (each drives a different source ladder + column structure):
- **combined-deep-dive** — marketing + in-app flow + strategic synthesis. Most expensive.
- **marketing-scan** — full-page marketing screenshots; primary source = live sites via headless Chrome, `fullPage: true`.
- **flow-scan** — screen sequences through a user flow; primary source = Mobbin, then interactive demos / Page Flows, live sites = fallback.

**Synthesis destinations** — always show the why-pick one-liner with each option so the choice is informed (it's the differentiator, mostly inline-screenshots vs. link-out):
- **New Google Doc** — when you want screenshots inline in the writeup, with easy commenting/sharing.
- **New Notion doc** — when it should live in the team's Notion; visuals link out to the Figma file (Notion can't embed local images).
- **New Google Slides** — when you'll *present* the findings; deck format, screenshots inline.
- **Shareable HTML** — when you want one polished, skimmable link; images inline, no Notion/Drive needed.
- **Somewhere else** — paste a destination (Confluence, an existing doc, a Drive folder).
- **Skip** — Figma blocks only, no writeup.

`AskUserQuestion` caps at 4 named options + an auto "Other," so surface the top four (Google Doc · Notion · Google Slides · Shareable HTML) and let "Other" absorb *somewhere else* / *skip*. Each option's description IS its why-pick line.

### Before moving on (all must be true before Phase 1)

1. **Destinations live** (Step 2) — required MCP tools connected.
2. **Existing work checked** (Step 3) — searched + asked.
3. **Required fields captured:** `{feature, dimensions, scan type, Figma dest, synthesis dest}`.

**Optional fields** — who it's for, why, what they're trying to learn, other context/docs — sharpen the analysis but never block the start. Capture what the user gave, infer the rest from their request, and move on; don't interrogate for them.

If a *required* answer is vague, propose a default and get explicit confirmation.

### Scratch directory (set once, use everywhere)

One run root `${TMPDIR:-/tmp}/comp-analysis/<run-slug>/`, with a per-competitor subdir `<root>/<competitor-slug>/` passed to each capture agent as `TMPDIR`. **Never let agents write to `~`, `$HOME`, or the cwd** — a prior run leaked image files into the home folder by improvising `~/tmp/...`.

### How each field is consumed (field → downstream)

| Field | Flows to |
|---|---|
| Feature · who-it's-for · why · learning goal | capture-agent context (light) · synthesis-writer `ADDITIONAL CONTEXT` · facts-digest framing |
| Other context / documents | pre-loaded into capture + synthesis context |
| Dimensions | capture briefing `DIMENSIONS TO CAPTURE` (= columns) · facts-digest organization · synthesis `DIMENSIONS` |
| Scan type | capture `SCAN_TYPE` → source ladder |
| Figma + synthesis dest | render target · synthesis output |

## Phase 1 — Competitor list (with user)

Build the list **with** the user — don't hand them a finished one. Three steps:

**1. Explain the tier framework.** Group by *why* each competitor matters:
- **Tier A** — Direct ICP match
- **Tier B** — Adjacent / future-state ICP
- **Tier C** — Model match (same primitive, different space)
- **Tier D** — Customer's current alternative

**2. Propose candidates per tier; user selects/deselects.** Walk through each tier with your proposed competitors and a one-line "why this tier" for each. The user checks off, removes, or adds. Use `AskUserQuestion` (multiSelect per tier) or a clear editable checklist. Target 12–18 across all tiers.

**3. Confirm the final list, then ask deep-dives.** Once the list is locked, ask which 3–4 to **deep-dive** (combined marketing + flow + rich Summary); the rest are broad-sweep.

### Search-vocabulary review (before any dispatch)

Once competitors are locked, propose the search vocabulary AND get **explicit user sign-off** before dispatching:

1. **Feature / flow vocabulary** — 2–3 word terms drawn from analysis dimensions
2. **Per-source query templates** — Mobbin/Page Flows: `<competitor> <feature>`; YouTube: `<competitor> walkthrough`, `<competitor> demo`, `<competitor> review <YYYY>`; Marketing IA: sitemap + nav scan + heuristic paths; Help center: `<competitor> how to <feature>`, `<competitor> set up <feature>` (esp. for gated/B2B products); Interactive demo: try `demo.<competitor>.com` + "interactive demo" / "take a tour" / "product tour" CTAs (best product-UI source for gated B2B)
3. **Source-specific quirks** — e.g. "for Chime, chime.com is Cloudflare-blocked — Wayback first"

Surface this list and ask the user to review/edit it. **Do not dispatch until the user signs off on the vocabulary.** It feeds the `SOURCE HINTS` field of every capture agent briefing in Phase 3.

## Phase 2 — Pilot one competitor (with user, optional)

**Ask right before fan-out** (`AskUserQuestion`, select (1)). Propose the competitor you'd pilot **and why** (default = the closest model match), so the options are:
- **Pilot <proposed competitor> (recommended)** — <one line on why it's the best pilot pick>
- **Skip to fan-out** — accept the risk, go straight to Phase 3

The user picks the proposed competitor, names a different one via "Other" (free text), or skips. The pilot's value is catching capture/labeling/render issues *before* paying for N parallel agents — skip only when that risk is acceptable (trusted setup, fast/low-stakes run, near-identical run done recently).

If skipping → go straight to Phase 3 fan-out. If piloting → don't fan out yet; dispatch ONE `competitor-capture` agent for the chosen competitor (brief format in Phase 3).

When the agent returns its manifest:

1. **Validate manifest** matches schema at `${PLUGIN_ROOT}/scripts/competitor-manifest-schema.md`
2. **Pre-measure** images: `${PLUGIN_ROOT}/scripts/pre-measure.sh < raw.json > measured.json`
3. **Render block** via the renderer pipeline (see "Renderer pipeline" below)
4. **Upload assets** + run post-process for scalingFactor
5. **Verify** via curl on get_screenshot URL
6. **Review with user** — placement, labeling, layout, Summary content quality

**If you're piloting, treat it as a real gate.** It surfaces capture/render issues before fan-out. If something's wrong, fix the briefing template; don't fan out on a broken first pass.

## Phase 3 — Parallel scout + render

### Briefing template for capture agents

Agents return **manifests only** — no Figma writes. The briefing should be minimal and clear:

```
COMPETITOR: <name>
TIER: <A | B | C | D>
SCAN_TYPE: <combined-deep-dive | marketing-scan | flow-scan | broad-sweep>
DEEP_DIVE: <true | false — controls "— deep dive" page-name suffix>
DIMENSIONS TO CAPTURE: <each becomes a column in the manifest: e.g. Marketing, Onboarding, Web App>
PRE-STAGED ASSETS: <local paths, if any>
SOURCE HINTS: <per-source queries + URLs derived from Phase 1 vocabulary + this competitor's name>
VISIBLE_BROWSER_OK: <true | false — default false; set true only after the user has approved a visible browser>
TMPDIR: <absolute per-competitor scratch dir — agent writes ALL files here, never ~ or cwd>
TIMELINE: <when to give up and document a gap>

REQUIRED OUTPUT: manifest YAML matching ${PLUGIN_ROOT}/scripts/competitor-manifest-schema.md
DO NOT: write to Figma directly. No use_figma. No upload_assets. No node IDs in your return. Default to headless (Puppeteer first) — only use a headed browser or Playwright MCP when VISIBLE_BROWSER_OK is true. On headless failure, flag a `headless_blocked` gap and return; don't open a window.
```

The renderer guarantees layout consistency. Your job is to give it good inputs.

### Headless browser issues — interrupt, don't silently degrade

Capture agents run headless (Puppeteer first) and never open a visible window on their own. When a capture comes back flagged `headless_blocked` (Puppeteer broken, SPA won't paint, site blocks headless), **interrupt the user** and offer two paths:

1. **Resolve the headless issue** — reinstall Puppeteer, reauth, try a different URL or Wayback.
2. **Approve a visible browser** for just those captures — then re-dispatch the affected captures with `VISIBLE_BROWSER_OK: true` (or capture them yourself with a headed Puppeteer / Playwright MCP).

Never open a visible browser without explicit approval. Surface this at the pilot (Phase 2) or capture-review (Phase 3.5) checkpoint — or sooner if a pre-stage step hits it.

### Dispatch

Pre-stage where helpful, then dispatch agents in parallel:

1. (Optional) Pre-stage marketing screencaps via headless Chrome
2. (Optional) Quick-scout each competitor on Mobbin (one search per, time-boxed 30 sec)
3. Dispatch one `competitor-capture` agent per remaining competitor

**Background vs foreground:** background lets the user keep chatting during the ~45min run. Background agents die if Claude Code session exits — keep the session open or use foreground for critical runs.

### After each manifest returns

Run the **Renderer pipeline** (below). Once all competitors have rendered, proceed to Phase 3.5.

## New Figma file setup

Only when the Figma destination is a **new file** (skip entirely for "paste existing URL"). Do this once, before rendering any competitor blocks.

1. **Create the file** (via the `figma-create-new-file` skill → `create_new_file`). Name it for the run, e.g. `<Feature> — Competitive Analysis`.
2. **First page = "Cover."** Rename the default first page to `Cover`. Nothing else goes on Cover — the renderer creates **one page per competitor** (named after the competitor, with a `— deep dive` suffix for deep-dives), so Cover ends up sitting alongside N competitor pages.
3. **Build a cover thumbnail frame** on the Cover page (~1600×960) — this frame doubles as the file thumbnail (Figma uses the first frame of the first page, so keep it at the page's top-left). **The look can vary run to run; the content below must always be present, no more no less:**
   - **Eyebrow** — a small label, `COMPETITIVE ANALYSIS`.
   - **Title** — the *subject only* (the feature / product / space being analyzed), large. Do **not** repeat "Competitive Analysis" here — the eyebrow and file name already carry it.
   - **Author** — pull dynamically from `whoami` (the authenticated Figma handle). Never hardcode a name — this is shared.
   - **Date** — when it was generated, e.g. `Generated <Mon DD, YYYY>`.
   - **AI-generated label** — a clearly-labeled badge/line, e.g. `AI-GENERATED WITH CLAUDE`. Use plain text, **not an emoji** — Figma's default fonts render emoji as tofu.
   - Style is free (background, accent, layout) but keep it tasteful: generous padding, one accent, don't overdesign.

Pull the author with a single `whoami` call at file-creation time; if it fails, fall back to a neutral label (omit the name) rather than guessing.

## Renderer pipeline (the deterministic part)

**Resolve `${PLUGIN_ROOT}` first.** All helper paths below are relative to the plugin install root. Discover it once at the start of the run:

```bash
PLUGIN_ROOT=$(find ~/.claude/plugins/cache/gusto-gists/competitive-analysis -maxdepth 1 -mindepth 1 -type d -name '[0-9]*' 2>/dev/null | sort -V | tail -1)
# If running locally via --plugin-dir, $PLUGIN_ROOT is the dir you passed.
```

For each competitor's returned manifest:

1. **Save manifest**: `echo "$AGENT_MANIFEST_JSON" > /tmp/<competitor>/manifest.json`

2. **Pre-measure** (mandatory):
   ```bash
   ${PLUGIN_ROOT}/scripts/pre-measure.sh < /tmp/<competitor>/manifest.json > /tmp/<competitor>/manifest.measured.json
   ```
   This reads native dims, sets display `width` = min(720, native) so mobile screens aren't upscaled, computes aspect-correct `height`, de-dupes byte-identical images, and slices any image too heavy (>1.5 MB) or too tall (>4000px native) into a `pieces` array — the renderer stitches pieces back into one seamless frame (one screen = one frame).

3. **Inject manifest into renderer template**:
   ```bash
   RENDERER=$(cat ${PLUGIN_ROOT}/scripts/competitor-block-renderer.js)
   MANIFEST=$(cat /tmp/<competitor>/manifest.measured.json)
   echo "$RENDERER" | sed "s|const MANIFEST = /\* INJECTED_MANIFEST \*/ {};|const MANIFEST = ${MANIFEST};|" > /tmp/<competitor>/payload.js
   # sanity-check size: wc -c /tmp/<competitor>/payload.js must be under 50000
   ```

4. **Call `use_figma`** with the payload JS. Returns `{ sectionId, pageName, pageId, frameUploadPlan: [{frameId, path}], width, height }`.

5. **Upload each image** in `frameUploadPlan`:
   - `upload_assets` with `nodeId: <frameId>`, `scaleMode: FILL`
   - `curl -X POST -F "file=@<path>" "<submitUrl>"` → capture `imageHash`

6. **Post-process scalingFactor** (mandatory — `upload_assets` may default to 0.5):
   ```js
   // use_figma payload:
   const page = await figma.getNodeByIdAsync('<pageId>');
   await figma.setCurrentPageAsync(page);
   for (const u of <upload_results>) {
     const n = await figma.getNodeByIdAsync(u.frameId);
     if (!n) continue;
     n.fills = [{
       type: 'IMAGE', scaleMode: 'FILL', scalingFactor: 1,
       imageHash: u.imageHash,
       visible: true, opacity: 1, blendMode: 'NORMAL',
     }];
   }
   ```

7. **Verify rendering**: `get_screenshot` on sectionId → `curl -o /tmp/proof.png "<url>"` → Read PNG. Confirm content paints (not all dark/blank).

Full spec: `${PLUGIN_ROOT}/scripts/build-competitor-block.md`.

## Phase 3.5 — Capture review checkpoint (with user)

Before any synthesis or inspiration scouting, surface what landed:

- Full Figma file, one section per competitor
- Coverage table — what got captured, what's missing per competitor
- Per-competitor Summary content (8 sections)
- Combined `sourcing_gaps` list across all competitors
- Optional: a lightweight plain-text synthesis draft for early redirect

**Default-reject criteria** — flag automatically:
- Any competitor with <3 total usable captures
- Any specified dimension with 0 captures
- Any `sourcing_gaps` entry indicating "couldn't capture anything"

**Pause and get direction:** anything to redo, recapture, drop, or pursue further? Do not proceed until user signs off.

## Phase 4 — Inspiration bucket (optional, with user)

Ask: pull design inspiration from outside the direct competitor space? If yes, dispatch additional capture agents (same manifest-returning pattern). If no, skip.

## Phase 5a — Facts review pause (with user)

**Before dispatching the synthesis-writer, surface extracted facts.** Don't write synthesis yet.

Produce a digest with **no takeaways**:
- Facts organized by the Phase 0 dimensions
- Notable observations as "things I noticed" — not conclusions
- **Cross-cutting themes**: patterns that emerge across multiple dimensions, fact categories, or competitor tiers. Surface these explicitly — they often drive the synthesis structure. Examples: "two architectures" splitting the set, "mode constraint as design tax", "where the primitive lives". Themes are also observational, not prescriptive — name the pattern without committing to a recommendation.
- Open questions: what should the synthesis emphasize?

**Pause and get direction:** which observations matter most, which themes to organize the synthesis around, what angle to take, which facts to drop or surface more.

## Phase 5b — Synthesis writeup

Dispatch the `synthesis-writer` agent:

```
PER-COMPETITOR MANIFESTS: <paths to each /tmp/<competitor>/manifest.measured.json>
FIGMA FILE: <url> — per-competitor sections viewable for visual reference
PHASE 5A DIRECTION: <verbatim direction from facts review>
DIMENSIONS: <from Phase 0>
TIERING: <how competitors group>
OUTPUT DESTINATION: <Phase 0 choice — Google Doc / Notion / Google Slides / shareable HTML / other, + its parent folder / page / URL>
ADDITIONAL CONTEXT: <strategic context, design thesis from Phase 0>
```

Synthesis-writer returns the doc URL. Review with the user; iterate as needed.

## After synthesis

Offer to:
- Create a Notion AI docs index entry (via `cw-export-deliverable`)
- Log to WIP / project tracker
- Spawn a deep-dive run for any single competitor that needs more depth

## Why the renderer pipeline matters

Pre-renderer issues observed in earlier runs:
- Layout drift — brand on top vs left, columns at random x, sections not wrapping content
- Aspect crop — frames sized arbitrarily, FILL mode cropping image content
- Cross-page contamination — agents writing to wrong page
- Generic frame names (`img_0_0`)
- Mobbin product screens mislabeled as "Marketing — /pricing"
- `scalingFactor: 0.5` left over → image rendered at half size
- >1.5 MB images blank in canvas
- Section bounds not updated after frame resize

The renderer fixes all of these by code, not LLM choice. Validator rejects bad manifests. Capture agents focus on capture quality; the renderer handles layout.
