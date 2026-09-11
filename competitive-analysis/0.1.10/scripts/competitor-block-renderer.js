// competitor-block-renderer.js
//
// Deterministic Figma block renderer for the competitive-analysis flow.
// Pass to use_figma with a MANIFEST object embedded at the top.
//
// Contract:
//   Input: MANIFEST (see competitor-manifest-schema.md)
//   Output: { sectionId, frameUploadPlan: [{frameId, path}], pageName }
//
// After this script runs:
//   1. caller calls upload_assets with nodeId=frameId for each entry in frameUploadPlan
//   2. caller POSTs the PNG at `path` to the returned submitUrl
//   3. caller runs a post-process use_figma that sets scalingFactor=1 explicitly on every IMAGE fill
//
// No layout improvisation. All positions absolute. All names descriptive.
// Refuses to write to a page whose name doesn't match the expected target.

const MANIFEST = /* INJECTED_MANIFEST */ {};

// --- Constants (the schema) ---
const SCHEMA = {
  X_BRAND: 200,
  X_SUMMARY: 720,
  X_COL_START: 1450,
  COL_WIDTH: 720,
  COL_GAP: 100,
  Y_START: 200,
  Y_COL_CONTENT_START: 320,
  GAP_IMAGES: 60,
  PAD: 100,
  SECTION_FILL: { r: 0.267, g: 0.267, b: 0.267 },
  TEXT_WHITE: { r: 1, g: 1, b: 1 },
  TEXT_DIM: { r: 0.9, g: 0.9, b: 0.9 },
  TEXT_AMBER: { r: 1, g: 0.8, b: 0.4 },
  FONT_REG: { family: 'Inter', style: 'Regular' },
  FONT_BOLD: { family: 'Inter', style: 'Bold' },
  FONT_SEMI: { family: 'Inter', style: 'Semi Bold' },
  BRAND_NAME_SIZE: 56,
  BRAND_TAGLINE_SIZE: 22,
  BRAND_META_SIZE: 14,
  SUMMARY_TITLE_SIZE: 24,
  SUMMARY_HEADER_SIZE: 12,
  SUMMARY_BODY_SIZE: 13,
  SUMMARY_BODY_GAP: 4,
  SUMMARY_SECTION_GAP: 18,
  SUMMARY_W: 600,
  COL_HEADER_SIZE: 18,
  COL_SUBTITLE_SIZE: 13,
  COL_FALLBACK_NOTE_SIZE: 13,
  IMAGE_LABEL_SIZE: 12,
  IMAGE_LABEL_OFFSET: 20,
};

// --- Validation ---
function validate(m) {
  const errs = [];
  if (!m.competitor) errs.push('missing competitor');
  if (!['A','B','C','D'].includes(m.tier)) errs.push(`bad tier: ${m.tier}`);
  if (!['combined-deep-dive','marketing-scan','flow-scan','broad-sweep'].includes(m.scan_type)) {
    errs.push(`bad scan_type: ${m.scan_type}`);
  }
  if (!m.brand?.name || !m.brand?.tagline) errs.push('brand.name + brand.tagline required');
  const s = m.summary;
  for (const k of ['positioning','target','pricing','trust','differentiators','recommendations','sourcing_gaps']) {
    if (!s?.[k] || !s[k].trim()) errs.push(`summary.${k} empty`);
  }
  if (!Array.isArray(m.columns) || m.columns.length === 0) errs.push('columns must be non-empty array');
  const titles = new Set();
  for (let i = 0; i < (m.columns || []).length; i++) {
    const col = m.columns[i];
    if (!col.title) errs.push(`columns[${i}].title required`);
    if (titles.has(col.title)) errs.push(`duplicate column title: ${col.title}`);
    titles.add(col.title);
    if (!Array.isArray(col.images)) errs.push(`columns[${i}].images must be array`);
    for (let j = 0; j < (col.images || []).length; j++) {
      const img = col.images[j];
      const hasPieces = Array.isArray(img.pieces) && img.pieces.length > 0;
      if (!img.path && !hasPieces) errs.push(`columns[${i}].images[${j}].path or pieces required`);
      if (!img.label || /^img_\d/i.test(img.label)) errs.push(`columns[${i}].images[${j}].label generic or missing`);
      if (!img.source_url) errs.push(`columns[${i}].images[${j}].source_url required`);
      if (!img.width || !img.height) errs.push(`columns[${i}].images[${j}] missing width/height (run pre-measure)`);
      if (hasPieces) {
        for (let k = 0; k < img.pieces.length; k++) {
          const pc = img.pieces[k];
          if (!pc.path) errs.push(`columns[${i}].images[${j}].pieces[${k}].path required`);
          if (!pc.width || !pc.height) errs.push(`columns[${i}].images[${j}].pieces[${k}] missing width/height`);
        }
      }
    }
  }
  return errs;
}

// --- Helpers ---
function mkText(parent, characters, fontName, size, color, x, y, width) {
  const t = figma.createText();
  t.fontName = fontName;
  t.characters = characters;
  t.fontSize = size;
  t.fills = [{ type: 'SOLID', color }];
  parent.appendChild(t);
  if (width != null) {
    t.textAutoResize = 'HEIGHT';
    t.resize(width, t.height);
  }
  t.x = x;
  t.y = y;
  return t;
}

// Auto-layout text: width follows the parent (STRETCH), height hugs content.
// Use inside a VERTICAL auto-layout frame so stacking + wrap height are automatic (no manual Y math).
function mkTextAuto(parent, characters, fontName, size, color) {
  const t = figma.createText();
  t.fontName = fontName;
  t.characters = characters;
  t.fontSize = size;
  t.fills = [{ type: 'SOLID', color }];
  t.textAutoResize = 'HEIGHT';
  parent.appendChild(t);
  t.layoutAlign = 'STRETCH';
  return t;
}

// VERTICAL auto-layout frame helper (transparent, hugs height, fixed width).
function mkVStack(name, width, itemSpacing) {
  const f = figma.createFrame();
  f.name = name;
  f.fills = [];
  f.clipsContent = false;
  f.layoutMode = 'VERTICAL';
  f.itemSpacing = itemSpacing;
  // resize() FIRST — it resets sizing modes to FIXED, so set them AFTER.
  f.resize(width, 10);
  f.counterAxisSizingMode = 'FIXED';   // fixed width
  f.primaryAxisSizingMode = 'AUTO';    // hug height
  return f;
}

// --- Main ---
async function render() {
  const errs = validate(MANIFEST);
  if (errs.length) {
    throw new Error('Manifest validation failed:\n' + errs.map(e => '  - ' + e).join('\n'));
  }

  const pageName = MANIFEST.deep_dive ? `${MANIFEST.competitor} — deep dive` : MANIFEST.competitor;

  // find or create page (Design files only)
  let page = figma.root.children.find(p => p.name === pageName);
  if (!page) {
    page = figma.createPage();
    page.name = pageName;
  }

  // Deep-dive pages sort to the top of the page list (just under a "Cover" page if present),
  // so the most important competitors lead. Broad-sweep pages stay appended in creation order.
  if (MANIFEST.deep_dive) {
    const children = figma.root.children;
    const coverFirst = children[0] && children[0].name === 'Cover';
    const targetIndex = coverFirst ? 1 : 0;
    if (children.indexOf(page) !== targetIndex) {
      figma.root.insertChild(targetIndex, page);
    }
  }

  await figma.setCurrentPageAsync(page);

  // hard verification — never write to wrong page
  if (figma.currentPage.name !== pageName) {
    throw new Error(`Page guard: expected '${pageName}', got '${figma.currentPage.name}'`);
  }

  // clear any pre-existing top-level content on this page (start from clean)
  for (const c of [...page.children]) {
    c.remove();
  }

  // load fonts
  await figma.loadFontAsync(SCHEMA.FONT_REG);
  await figma.loadFontAsync(SCHEMA.FONT_BOLD);
  await figma.loadFontAsync(SCHEMA.FONT_SEMI);

  // create section first
  const section = figma.createSection();
  section.name = MANIFEST.competitor;
  section.fills = [{ type: 'SOLID', color: SCHEMA.SECTION_FILL }];

  // ── Brand block (auto-layout — text height is automatic, no overlap) ──
  const brand = mkVStack(`${MANIFEST.competitor} — Brand`, 480, 14);
  section.appendChild(brand);
  brand.x = SCHEMA.X_BRAND;
  brand.y = SCHEMA.Y_START;

  // logo (optional) — must be the first child so the upload plan can find it at brand.children[0]
  if (MANIFEST.brand.logo_path) {
    const logoFrame = figma.createFrame();
    logoFrame.name = `${MANIFEST.competitor} — Logo`;
    logoFrame.fills = [{ type: 'SOLID', color: { r: 0.3, g: 0.3, b: 0.3 } }];
    logoFrame.resizeWithoutConstraints(480, 120);
    brand.appendChild(logoFrame);
    logoFrame.layoutAlign = 'STRETCH';
    // logo uploaded by caller via frameUploadPlan
  }
  mkTextAuto(brand, MANIFEST.brand.name, SCHEMA.FONT_BOLD, SCHEMA.BRAND_NAME_SIZE, SCHEMA.TEXT_WHITE);
  mkTextAuto(brand, MANIFEST.brand.tagline, SCHEMA.FONT_REG, SCHEMA.BRAND_TAGLINE_SIZE, SCHEMA.TEXT_DIM);
  if ((MANIFEST.brand.meta || []).length) {
    const metaWrap = mkVStack('meta', 480, 4);
    brand.appendChild(metaWrap);
    metaWrap.layoutAlign = 'STRETCH';
    for (const meta of MANIFEST.brand.meta) {
      mkTextAuto(metaWrap, meta, SCHEMA.FONT_REG, SCHEMA.BRAND_META_SIZE, SCHEMA.TEXT_DIM);
    }
  }

  // ── Summary block (auto-layout — each section hugs its text; capped at SUMMARY_W for readability) ──
  const summaryFrame = mkVStack(`${MANIFEST.competitor} — Summary`, SCHEMA.SUMMARY_W, SCHEMA.SUMMARY_SECTION_GAP);
  section.appendChild(summaryFrame);
  summaryFrame.x = SCHEMA.X_SUMMARY;
  summaryFrame.y = SCHEMA.Y_START;

  mkTextAuto(summaryFrame, 'SUMMARY', SCHEMA.FONT_BOLD, SCHEMA.SUMMARY_TITLE_SIZE, SCHEMA.TEXT_WHITE);

  const sections = [
    ['POSITIONING', MANIFEST.summary.positioning],
    ['TARGET (ICP)', MANIFEST.summary.target],
    ['PRICING', MANIFEST.summary.pricing],
    ['TRUST', MANIFEST.summary.trust],
    ['DIFFERENTIATORS', MANIFEST.summary.differentiators],
    ...(MANIFEST.summary.strategic_context?.trim() ? [['⚡ STRATEGIC CONTEXT', MANIFEST.summary.strategic_context]] : []),
    ['RECOMMENDATIONS', MANIFEST.summary.recommendations],
    ['📡 SOURCING & GAPS', MANIFEST.summary.sourcing_gaps],
  ];

  for (const [header, body] of sections) {
    const sec = mkVStack(`summary — ${header}`, SCHEMA.SUMMARY_W, SCHEMA.SUMMARY_BODY_GAP);
    summaryFrame.appendChild(sec);
    sec.layoutAlign = 'STRETCH';
    mkTextAuto(sec, header, SCHEMA.FONT_BOLD, SCHEMA.SUMMARY_HEADER_SIZE, SCHEMA.TEXT_DIM);
    mkTextAuto(sec, body, SCHEMA.FONT_REG, SCHEMA.SUMMARY_BODY_SIZE, SCHEMA.TEXT_WHITE);
  }

  // ── Columns ──
  const frameUploadPlan = [];
  if (MANIFEST.brand.logo_path) {
    // logo frame was the first child of brand frame
    const logoFrameNode = brand.children[0];
    frameUploadPlan.push({ frameId: logoFrameNode.id, path: MANIFEST.brand.logo_path });
  }

  let cx = SCHEMA.X_COL_START;
  let maxColumnBottom = SCHEMA.Y_START + summaryFrame.height;
  for (const col of MANIFEST.columns) {
    // column header
    let cy = SCHEMA.Y_START;
    const colHeader = mkText(section, col.title.toUpperCase(), SCHEMA.FONT_BOLD, SCHEMA.COL_HEADER_SIZE, SCHEMA.TEXT_WHITE, cx, cy, SCHEMA.COL_WIDTH);
    cy += colHeader.height + 6;

    if (col.subtitle) {
      const colSub = mkText(section, col.subtitle, SCHEMA.FONT_REG, SCHEMA.COL_SUBTITLE_SIZE, SCHEMA.TEXT_DIM, cx, cy, SCHEMA.COL_WIDTH);
      cy += colSub.height + 4;
    }

    if (col.fallback_note) {
      const fb = mkText(section, '⚠️ ' + col.fallback_note, SCHEMA.FONT_REG, SCHEMA.COL_FALLBACK_NOTE_SIZE, SCHEMA.TEXT_AMBER, cx, cy, SCHEMA.COL_WIDTH);
      cy += fb.height + 12;
    }

    if (cy < SCHEMA.Y_COL_CONTENT_START) cy = SCHEMA.Y_COL_CONTENT_START;

    for (const img of col.images) {
      // label above frame
      const lbl = mkText(section, img.label, SCHEMA.FONT_REG, SCHEMA.IMAGE_LABEL_SIZE, SCHEMA.TEXT_WHITE, cx, cy, SCHEMA.COL_WIDTH);
      if (img.source_url) {
        lbl.setRangeHyperlink(0, lbl.characters.length, { type: 'URL', value: img.source_url });
      }
      cy += lbl.height + 6;

      if (Array.isArray(img.pieces) && img.pieces.length > 0) {
        // Tall/heavy screen split for upload+render limits, stitched back into ONE frame
        // (vertical auto-layout, zero gap) so it reads as a single continuous screen.
        const stitch = figma.createFrame();
        stitch.name = img.label;
        stitch.fills = [{ type: 'SOLID', color: { r: 0.18, g: 0.18, b: 0.18 } }];
        stitch.clipsContent = true;
        stitch.layoutMode = 'VERTICAL';
        stitch.itemSpacing = 0;
        // resize() FIRST — it resets sizing modes to FIXED, so set them AFTER.
        stitch.resize(img.width, 10);
        stitch.counterAxisSizingMode = 'FIXED';   // fixed width
        stitch.primaryAxisSizingMode = 'AUTO';    // hug stitched height
        section.appendChild(stitch);
        stitch.x = cx;
        stitch.y = cy;
        let stitchedH = 0;
        for (let p = 0; p < img.pieces.length; p++) {
          const pc = img.pieces[p];
          const pf = figma.createFrame();
          pf.name = `${img.label} — slice ${p + 1}/${img.pieces.length}`;
          pf.fills = [{ type: 'SOLID', color: { r: 0.18, g: 0.18, b: 0.18 } }];
          pf.resizeWithoutConstraints(pc.width, pc.height);
          stitch.appendChild(pf);
          pf.layoutAlign = 'STRETCH';
          frameUploadPlan.push({ frameId: pf.id, path: pc.path });
          stitchedH += pc.height;
        }
        cy += stitchedH + SCHEMA.GAP_IMAGES;
      } else {
        // single frame at given width × height
        const f = figma.createFrame();
        f.name = img.label;
        f.fills = [{ type: 'SOLID', color: { r: 0.18, g: 0.18, b: 0.18 } }];
        f.resizeWithoutConstraints(img.width, img.height);
        section.appendChild(f);
        f.x = cx;
        f.y = cy;
        frameUploadPlan.push({ frameId: f.id, path: img.path });
        cy += img.height + SCHEMA.GAP_IMAGES;
      }
    }
    maxColumnBottom = Math.max(maxColumnBottom, cy);
    cx += SCHEMA.COL_WIDTH + SCHEMA.COL_GAP;
  }

  // resize section to fit everything
  const totalW = cx + SCHEMA.PAD; // cx already moved past last column
  const totalH = maxColumnBottom + SCHEMA.PAD;
  section.resizeWithoutConstraints(totalW, totalH);

  return {
    sectionId: section.id,
    pageName,
    pageId: page.id,
    frameUploadPlan,
    width: totalW,
    height: totalH,
    columnCount: MANIFEST.columns.length,
  };
}

return await render();
