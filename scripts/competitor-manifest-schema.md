# Competitor block manifest schema

Inputs to `competitor-block-renderer.js`. Capture agents return one of these as YAML/JSON. Orchestrator validates + runs renderer.

## Top-level

```yaml
competitor: "Chime"                 # display name, used as section name
tier: "C"                            # one of A | B | C | D
scan_type: "combined-deep-dive"     # combined-deep-dive | marketing-scan | flow-scan | broad-sweep
deep_dive: true                     # if true, page name gets " — deep dive" suffix
brand: { … }
summary: { … }
columns: [ {…}, … ]
```

## brand

```yaml
brand:
  name: "Chime"
  tagline: "The bank account that doesn't charge fees."
  meta: ["Tier C — Bank-side competitor", "Banking: The Bancorp / Stride Bank · FDIC"]
  logo_path: "/tmp/chime/chime_logo.png"   # optional. PNG only.
```

## summary

Eight required fields in fixed order. All plain text strings.

```yaml
summary:
  positioning: "…"
  target: "…"
  pricing: "…"
  trust: "…"
  differentiators: "…"
  strategic_context: "…"   # optional but include the field; empty string OK
  recommendations: "…"
  sourcing_gaps: "…"
```

## columns

Ordered list, left → right on canvas. Each column independent.

```yaml
columns:
  - title: "Marketing"                 # required, becomes column header
    subtitle: ""                         # optional, secondary line below header
    fallback_note: ""                    # optional, shown in amber color: "⚠️ chime.com Cloudflare-blocked; Mobbin product screens shown as substitute"
    images:
      - path: "/tmp/chime/img1.png"      # absolute path on disk
        label: "Chime — Home: savings card + Chime+ upsell carousel"   # required, becomes frame name + label text
        source_url: "https://mobbin.com/..."   # required for hyperlinking
        width: 720                       # display width on canvas. Computed from native by pre-measure step; renderer trusts.
        height: 1542                      # display height. MUST match aspect of image at given width: height = width × (img_native_h / img_native_w)
```

## Required pre-measure step

Before passing manifest to renderer, run `pre-measure.sh <manifest.json> > measured-manifest.json`. The renderer will NOT measure; it trusts. Pre-measure:

- Sets `width` = min(720, native width) — **never upscales** (a ~390px mobile capture stays ~390px, crisp).
- Computes aspect-correct `height`.
- **De-dupes** byte-identical images (same MD5) — first wins, later copies dropped with a warning. Each frame must be a distinct screen.
- **Slices** any image too heavy (>1.5 MB) or too tall (>4000px native) into a `pieces` array (below). The renderer stitches the pieces into ONE frame, so one screen still reads as one frame.

### `pieces` (added by pre-measure, not by capture agents)

When an image is sliced, its top-level `path` is replaced by a `pieces` array; `width`/`height` become the stitched totals:

```yaml
- label: "Chime — High-Yield Savings page (full marketing page)"
  source_url: "https://www.chime.com/savings/..."
  width: 720
  height: 4735          # total stitched height
  pieces:
    - { path: "/tmp/chime/savings_p1.png", width: 720, height: 1578 }
    - { path: "/tmp/chime/savings_p2.png", width: 720, height: 1578 }
    - { path: "/tmp/chime/savings_p3.png", width: 720, height: 1579 }
```

Capture agents never emit `pieces` — they return one `path` per screen; pre-measure decides whether to slice.

## Validation rules (enforced by validator)

- All required fields present
- `tier` ∈ {A,B,C,D}
- `scan_type` ∈ {combined-deep-dive, marketing-scan, flow-scan, broad-sweep}
- Every image has `label`, `source_url`, `width`, `height`, and either `path` OR a non-empty `pieces` array (each piece has `path`, `width`, `height`)
- `label` is NOT generic (rejects `img_X_Y` style)
- `path` exists on disk (pre-measure slices heavy/tall images into `pieces` rather than failing)
- No byte-identical duplicates (pre-measure drops them)
- No two columns have same `title`
- `summary.sourcing_gaps` is non-empty (honest gap reporting required)
