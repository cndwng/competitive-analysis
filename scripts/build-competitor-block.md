# Orchestrator pipeline — build a competitor block deterministically

This is the canonical, deterministic pipeline for rendering a competitive-analysis block in Figma. Capture agents return manifests; the orchestrator (skill or main thread) runs this pipeline. No layout improvisation in either place.

## Inputs

- `competitor` (name)
- `figma_file_key`
- Capture agent's return: a manifest matching `competitor-manifest-schema.md`

## Stages

### 1. Receive manifest from capture agent

Capture agent must return YAML/JSON manifest only — **no Figma writes from agent**. Agent's job is exclusively to:
- Capture marketing pages (PNG)
- Capture product UI frames (PNG, from Mobbin/YouTube/App Store)
- Write the 8 Summary fields
- Return the manifest

Reject agent outputs that include Figma node IDs — that means the agent improvised. Re-dispatch with explicit instruction.

### 2. Save manifest to disk

```bash
echo "$AGENT_MANIFEST_JSON" > /tmp/<competitor>/manifest.json
```

### 3. Pre-measure (mandatory)

```bash
${PLUGIN_ROOT}/scripts/pre-measure.sh \
  < /tmp/<competitor>/manifest.json \
  > /tmp/<competitor>/manifest.measured.json
```

This script:
- Verifies every image path exists
- Reads native dimensions via `identify`
- Computes `width` = min(720, native width) — **never upscales** (mobile screens stay crisp) — and aspect-correct `height`
- **De-dupes** byte-identical images (same MD5): first wins, later copies dropped with a warning (backstop for accidental duplicate captures)
- **Slices** any image too heavy (> 1.5 MB) or too tall (> 4000px native) into a `pieces` array (each `{path,width,height}`); top-level `width`/`height` become the stitched totals. The renderer reassembles the pieces into ONE seamless frame, so a split screen still reads as one screen.

If any image can't be sliced under the limits (max 12 slices), fails. Re-capture at lower resolution required.

### 4. Inject manifest into renderer template

Read `competitor-block-renderer.js`. Find the line `const MANIFEST = /* INJECTED_MANIFEST */ {};`. Replace `{}` with the JSON-stringified measured manifest.

**Use Python, not bash echo/sed.** Bash `echo` interprets `\n` as a real newline, corrupting JS string escapes in the renderer source. Python `open().read()` preserves bytes exactly.

```bash
python3 -c "
with open('${PLUGIN_ROOT}/scripts/competitor-block-renderer.js') as f:
    renderer = f.read()
with open('/tmp/<competitor>/manifest.measured.json') as f:
    manifest = f.read().strip()
out = renderer.replace('const MANIFEST = /* INJECTED_MANIFEST */ {};', 'const MANIFEST = ' + manifest + ';')
with open('/tmp/<competitor>/payload.js', 'w') as f:
    f.write(out)
print(f'wrote {len(out)} bytes')
"
```

Sanity-check size: `wc -c /tmp/<competitor>/payload.js` must be under 50000 (use_figma `code` limit). If over, split the manifest into multiple columns rendered separately or reduce content.

### 5. Run the renderer via use_figma

```
use_figma:
  fileKey: <figma_file_key>
  description: "Render <competitor> block (deterministic)"
  skillNames: "resource:figma-use"
  code: <contents of /tmp/<competitor>/payload.js>
```

Returns: `{ sectionId, pageName, pageId, frameUploadPlan: [{frameId, path}], width, height, columnCount }`.

Note: a sliced image (one with a `pieces` array) contributes ONE `{frameId, path}` entry per slice — the renderer builds a stitched parent frame and one child frame per slice, and lists each child in `frameUploadPlan`. Upload them all the same way; they reassemble into one continuous screen.

If the renderer throws — read the error. Most likely manifest validation failed; fix manifest, re-run.

### 6. Upload images to frames

For each `{frameId, path}` in `frameUploadPlan`:

```
upload_assets:
  fileKey: <figma_file_key>
  nodeId: <frameId>
  scaleMode: FILL
```

POST the PNG to the returned submitUrl:

```bash
curl -X POST -F "file=@<path>" "<submitUrl>"
```

Capture every returned `imageHash`. Keep a list `{frameId, path, imageHash}`.

### 7. Post-process: ensure `scalingFactor: 1`

```
use_figma:
  code: |
    const page = await figma.getNodeByIdAsync('<pageId>');
    await figma.setCurrentPageAsync(page);
    const updates = <upload_results_json>;
    for (const u of updates) {
      const n = await figma.getNodeByIdAsync(u.frameId);
      if (!n) continue;
      const fill = n.fills[0];
      n.fills = [{
        type: 'IMAGE',
        scaleMode: 'FILL',
        scalingFactor: 1,
        imageHash: u.imageHash,
        visible: true, opacity: 1, blendMode: 'NORMAL',
      }];
    }
    return updates.length;
```

This step is mandatory — `upload_assets` may default `scalingFactor` to 0.5, which renders images at half size inside the frame (visibly blank with tiny thumbnail).

### 8. Verify rendering

```
get_screenshot:
  nodeId: <sectionId>
  maxDimension: 2400
```

`curl -o /tmp/<competitor>/proof.png "<image_url>"`. Read the PNG with the `Read` tool. Confirm content is visible (not all dark/blank). If blank, escalate — file-level rendering bug.

## Failure modes & responses

| Symptom | Cause | Fix |
|---|---|---|
| Renderer throws "Manifest validation failed" | Missing required field, generic label, missing source_url, missing width/height | Add the field to manifest, re-run from step 3 |
| Renderer throws "Page guard" | Page-name mismatch (rare; concurrent agent stomp) | Re-run; ensure no parallel writes to same competitor |
| Image renders blank in canvas (verified via curl proof) | `scalingFactor: 0.5` left over, or hash propagation lag | Step 7 fixes scalingFactor; if still blank, delete frame + recreate + re-upload |
| Stitched image renders as a thin sliver (~10px) | Auto-layout frame frozen — `resize()` **resets** `primaryAxisSizingMode` to FIXED, so a height-hug frame stays pinned at its resize height | In the renderer, set `primaryAxisSizingMode='AUTO'` (and `counterAxisSizingMode='FIXED'`) AFTER the `resize()` call, never before. Applies to every auto-layout frame (`mkVStack`, stitch builder). |
| Tall page blank / clipped | Native height > ~4000px overruns Figma's image-fill ceiling | pre-measure slices > 4000px-tall images into `pieces`; if still blank, lower `MAX_PIECE_PX` in pre-measure |
| `use_figma` code exceeds 50000 chars | Manifest too long (likely sourcing_gaps or recommendations verbose) | Trim verbose Summary fields, or split columns into separate `use_figma` calls |
| Image label wrong / generic | Capture agent emitted bad label, validator caught it | Fix manifest, re-run |
| Same screen appears twice / duplicate frames | Capture agent staged byte-identical files as distinct screens | pre-measure de-dupes by MD5 (first wins); verify capture agent isn't labeling one screen as two |

## Why this is deterministic

- Layout positions are constants in `competitor-block-renderer.js` (SCHEMA object). No LLM choice.
- Brand + Summary blocks are auto-layout (height hugs text) — no manual Y math, so wrapped text can't overlap.
- Frame names equal image labels — no `img_X_Y` strings. Validator rejects generic.
- Image frame dims = aspect-correct from pre-measure; width capped at native (no upscaling). No FILL crop.
- Tall/heavy images are sliced and stitched back into one frame — one screen = one frame.
- Section wrapper + #444 fill + 100px padding standard.
- Hyperlinks set in code, not LLM.
- Page-name guard prevents cross-page writes.
- Byte-identical captures de-duped in pre-measure.

If output differs from spec, the bug is in the renderer or pre-measure — not the agent. Fix once, every competitor inherits.
