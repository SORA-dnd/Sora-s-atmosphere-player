// --- START OF FILE main.js ---

const MODULE_ID = "sequencer-webm-orb";

// Media Formats
const IMAGE_RE = /\.(png|apng|jpe?g|gif|webp|avif|svg)$/i;
const VIDEO_RE = /\.(webm|mp4|m4v|ogv|mov|mkv)$/i;
const MEDIA_RE = /\.(png|apng|jpe?g|gif|webp|avif|svg|webm|mp4|m4v|ogv|mov|mkv)$/i;

const EFFECT_TAG = `${MODULE_ID}-effect`;
const MAX_CATEGORIES = 50; // OPTIMIZATION: Increased category limit to 50

// Logs
let PLAY_LOG = [];          // { path, ts }
let LAST_CLEAR_AT = 0;
let CURRENT_PRESET_TAG = null;

// Cache
const FOLDER_LIST_CACHE = new Map();
const MEDIA_SIZE_CACHE = new Map();   // path -> {w,h}

// Preview video concurrency limit (only mount src for visible items)
const PREVIEW_ACTIVE_SET = new Set();
const PREVIEW_DEFAULT_MAX_ACTIVE = 24;
function getPreviewMaxActive() {
  const v = Number(game.settings?.get?.(MODULE_ID, "previewMaxActive"));
  return Number.isFinite(v) && v > 0 ? v : PREVIEW_DEFAULT_MAX_ACTIVE;
}

// Z-Index Layers
let ORDER_COUNTER = 0;
const Z_BASE = 10000;
const Z_RANGE = 1000000;

// Now Playing (Active effects started by this module)
let ACTIVE_EFFECTS = []; // { id, name, path, tag, z }
let NP_SELECTED = null;

// FilePicker Access (v9-v13+ compatible)
function FP() {
  return (
    foundry?.applications?.api?.FilePicker ??           // V2
    foundry?.applications?.apps?.FilePicker?.implementation ?? // v13 compatible
    window.FilePicker                                   // V1
  );
}

/* ============== Utilities ============== */
function defaultCategories() {
  const cat = {};
  for (let i = 1; i <= 8; i++) {
    cat[`cat${i}`] = { name: `Category ${i}`, folder: "", source: "data", extraFiles: [], hiddenFiles: [] };
  }
  return cat;
}
function getCategoriesObject() {
  return game.settings.get(MODULE_ID, "categories") ?? defaultCategories();
}
function getCategoriesArray() {
  const cats = getCategoriesObject();
  const keys = Object.keys(cats).filter(k => /^cat\d+$/.test(k)).sort((a, b) => parseInt(a.slice(3)) - parseInt(b.slice(3)));
  return keys.slice(0, MAX_CATEGORIES).map((key, idx) => ({
    key, idx,
    name: cats[key]?.name || key,
    folder: cats[key]?.folder || "",
    source: cats[key]?.source || "data",
    extraFiles: Array.isArray(cats[key]?.extraFiles) ? cats[key].extraFiles : [],
    hiddenFiles: Array.isArray(cats[key]?.hiddenFiles) ? cats[key].hiddenFiles : []
  }));
}
function getFavorites() { return foundry.utils.duplicate(game.settings.get(MODULE_ID, "favorites") || {}); }
async function setFavorites(obj) { await game.settings.set(MODULE_ID, "favorites", obj); }
async function createFavorite(name) { const fav = getFavorites(); if (!fav[name]) fav[name] = []; return await setFavorites(fav); }
async function renameFavorite(oldName, newName) { const fav = getFavorites(); if (!fav[oldName]) return; if (fav[newName]) return ui.notifications?.warn("A favorite with the same name already exists."); fav[newName] = fav[oldName]; delete fav[oldName]; return await setFavorites(fav); }
async function deleteFavorite(name) { const fav = getFavorites(); delete fav[name]; return await setFavorites(fav); }
async function addToFavorite(name, path) { const fav = getFavorites(); if (!fav[name]) fav[name] = []; if (!fav[name].includes(path)) fav[name].push(path); return await setFavorites(fav); }
async function removeFromFavorite(name, path) { const fav = getFavorites(); if (!fav[name]) return; fav[name] = fav[name].filter(p => p !== path); return await setFavorites(fav); }

// Ignore ?query/#hash then check extension (for S3 pre-signed URL fallback)
function stripQuery(p = "") {
  const s = String(p);
  const i = s.indexOf("?"); const j = s.indexOf("#");
  const cut = (x) => (x >= 0 ? x : s.length);
  return s.slice(0, Math.min(cut(i), cut(j)));
}
function hasMediaExt(p = "") {
  const base = stripQuery(p);
  return MEDIA_RE.test(base);
}
function isVideo(p = "") { return VIDEO_RE.test(stripQuery(p)); }
function isImage(p = "") { return IMAGE_RE.test(stripQuery(p)); }

// File Aliases (Notes)
function getAliases() { return foundry.utils.duplicate(game.settings.get(MODULE_ID, "aliases") || {}); }
async function setAliases(obj) { await game.settings.set(MODULE_ID, "aliases", obj); }
function getFileAlias(path) { const a = getAliases(); return a[stripQuery(path)] || null; }
async function setFileAlias(path, alias) {
  const a = getAliases(); const key = stripQuery(path);
  if (alias && alias.trim()) a[key] = alias.trim();
  else delete a[key];
  await setAliases(a);
}

// (OPTIMIZATION) Sanitize default filenames
function sanitizeDefaultFilename(filename) {
  // Regex to keep: English letters, Chinese characters, space, underscore, hyphen, dot
  const allowedChars = /[^a-zA-Z\u4e00-\u9fa5\s_\-\.]/g;
  return filename.replace(allowedChars, "");
}

function displayNameFor(path) {
  const alias = getFileAlias(path);
  if (alias) return alias; // Return manual alias as-is

  const rawFilename = stripQuery(path).split("/").pop();
  return sanitizeDefaultFilename(rawFilename);
}

// Preview Background Color Setting
function getPreviewBgColor() {
  const key = game.settings?.get?.(MODULE_ID, "previewBg") || "black"; // Default changed for new theme
  const map = {
    white: "#ffffff",
    black: "#000000",
    "pale-yellow": "#2e2a1f",
    "light-brown": "#3a2e23",
    "deep-brown": "#241a14",
    "mustard": "#3a3219",
    "gray": "#222222"
  };
  return map[key] || "#000000";
}

function escapeHtml(s = "") { return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m])); }
function escapeAttr(s = "") { return escapeHtml(s); }
function rid(n=16) { return foundry?.utils?.randomID?.(n) ?? `${Date.now().toString(36)}-${Math.floor(Math.random()*1e9).toString(36)}`; }

/* Sequencer Version Compatibility */
function chainCall(obj, method, ...args) {
  try { if (obj && typeof obj[method] === "function") return obj[method](...args); }
  catch (e) { console.warn(`[${MODULE_ID}] chainCall(${method}) failed:`, e); }
  return obj;
}

async function promptString(title, label, initial = "") {
  return new Promise((resolve) => {
    new Dialog({
      title,
      content: `<div class="fvtt-dialog"><label>${label}</label><input type="text" name="str" value="${escapeAttr(initial)}" style="width:100%"></div>`,
      buttons: {
        ok: { label: "Confirm", callback: (html) => { const v = html[0].querySelector("input[name='str']")?.value?.trim(); resolve(v || null); } },
        cancel: { label: "Cancel", callback: () => resolve(null) }
      },
      default: "ok"
    }).render(true);
  });
}

/* ============== Unified Path Selection via FilePicker ============== */
async function pickMediaPathViaFilePicker({ source = "data", current = "", allowUpload = false } = {}) {
    const FPClass = FP();
    if (!FPClass) {
        ui.notifications?.warn("FilePicker is not available.");
        return null;
    }
    return new Promise((resolve) => {
        const picker = new FPClass({
            type: "imagevideo",
            activeSource: source,
            current: current,
            callback: (path) => {
                if (path && hasMediaExt(path)) {
                    resolve(path);
                } else {
                    resolve(null);
                }
            },
            // This is the most compatible way to pass the upload option
            upload: allowUpload
        });
        picker.render(true);
    });
}


/* ============== Browsing and Indexing (static FilePicker.browse, S3 compatible) ============== */
async function listAllMedia(root, source = "data") {
  if (!root) return [];
  try {
    const visited = new Set();
    const out = [];
    async function walk(path) {
      const key = `${source}:${path}`;
      if (visited.has(key)) return;
      visited.add(key);

      let resp = { files: [], dirs: [] };
      const FPClass = FP();
      if (FPClass?.browse) {
        resp = await FPClass.browse(source, path);
      } else if (FPClass) {
        const picker = new FPClass({ activeSource: source });
        resp = await picker.browse(path);
      }

      for (const f of (resp.files || [])) if (hasMediaExt(f)) out.push(f);
      for (const d of (resp.dirs || [])) await walk(d);
    }
    await walk(root);
    return out;
  } catch (err) {
    console.error(err);
    ui.notifications?.warn(`Could not browse folder: ${root}`);
    return [];
  }
}
async function getFolderFilesCached(root, source = "data", force = false) {
  if (!root) return [];
  const key = `${source}:${root}`;
  if (!force && FOLDER_LIST_CACHE.has(key)) return FOLDER_LIST_CACHE.get(key);
  const list = await listAllMedia(root, source);
  FOLDER_LIST_CACHE.set(key, list);
  return list;
}

/* ============== Original Media Dimensions (for cover calculation) ============== */
async function getMediaSize(path) {
  if (MEDIA_SIZE_CACHE.has(path)) return MEDIA_SIZE_CACHE.get(path);
  const timeout = (ms) => new Promise(r => setTimeout(r, ms));
  try {
    if (isVideo(path)) {
      const v = document.createElement("video");
      v.preload = "metadata"; v.muted = true; v.src = path;
      const size = await Promise.race([
        new Promise((resolve, reject) => {
          v.onloadedmetadata = () => resolve({ w: v.videoWidth || 0, h: v.videoHeight || 0 });
          v.onerror = () => reject(new Error("video meta error"));
        }),
        timeout(1200).then(() => ({ w: 0, h: 0 }))
      ]);
      MEDIA_SIZE_CACHE.set(path, size); return size;
    } else if (isImage(path)) {
      const img = new Image();
      img.decoding = "async"; img.loading = "eager"; img.src = path;
      const size = await Promise.race([
        new Promise((resolve, reject) => {
          img.onload = () => resolve({ w: img.naturalWidth || 0, h: img.naturalHeight || 0 });
          img.onerror = () => reject(new Error("img meta error"));
        }),
        timeout(1200).then(() => ({ w: 0, h: 0 }))
      ]);
      MEDIA_SIZE_CACHE.set(path, size); return size;
    }
  } catch (e) { console.warn("getMediaSize error", e); }
  const fallback = { w: 0, h: 0 }; MEDIA_SIZE_CACHE.set(path, fallback); return fallback;
}

/* ============== Category Configuration UI (FormApplication) ============== */
function getAvailableSources() {
  try {
    const FPClass = FP();
    const fp = FPClass ? new FPClass() : null;
    const sources = fp?.sources || FilePicker?.availableSources || {};
    const map = {};
    for (const [k, v] of Object.entries(sources)) map[k] = v?.label || k;
    return Object.keys(map).length ? map : { data: "Data", s3: "S3" };
  } catch { return { data: "Data", s3: "S3" }; }
}

class CategoriesConfigForm extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: `${MODULE_ID}-cat-config`,
      title: "Category Mapping Configuration",
      template: `modules/${MODULE_ID}/templates/viewer.hbs`,
      width: 720, height: 600, resizable: true
    });
  }
  getData() { return {}; }
  async _render(force, options) {
    const r = await super._render(force, options);
    const wc = this.element[0].querySelector(".window-content");
    if (!wc) return r;
    wc.style.display = "flex"; wc.style.flexDirection = "column"; wc.style.overflow = "hidden"; wc.style.height = "100%";
    wc.innerHTML = "";

    const header = document.createElement("div");
    header.style.flex = "0 0 auto";
    header.style.display = "flex"; header.style.alignItems = "center"; header.style.gap = "8px";
    const title = document.createElement("div");
    title.textContent = "Category Mappings (Max 50)"; title.style.fontWeight = "600";
    const addBtn = document.createElement("button");
    addBtn.innerHTML = `<i class="fas fa-plus"></i> New Category`; addBtn.style.marginLeft = "auto";
    header.appendChild(title); header.appendChild(addBtn);

    const body = document.createElement("div");
    body.style.flex = "1 1 auto"; body.style.overflow = "auto"; body.style.marginTop = "6px";

    const footer = document.createElement("div");
    footer.style.flex = "0 0 auto"; footer.style.display = "flex"; footer.style.justifyContent = "flex-end"; footer.style.gap = "6px"; footer.style.marginTop = "8px";
    const saveBtn = document.createElement("button"); saveBtn.innerHTML = `<i class="fas fa-save"></i> Save`;
    const closeBtn = document.createElement("button"); closeBtn.innerHTML = `Close`;
    footer.appendChild(saveBtn); footer.appendChild(closeBtn);

    wc.appendChild(header); wc.appendChild(body); wc.appendChild(footer);

    const sourcesMap = getAvailableSources();
    const catsObj = foundry.utils.duplicate(getCategoriesObject());
    const keys = Object.keys(catsObj).filter(k => /^cat\d+$/.test(k)).sort((a,b)=> parseInt(a.slice(3))-parseInt(b.slice(3)));
    const rows = [];
    const renderRows = () => { body.innerHTML = ""; rows.forEach(r => body.appendChild(r.el)); };

    const createRow = (data, key) => {
      const el = document.createElement("div");
      el.className = "cat-row"; el.dataset.key = key;
      el.style.display = "grid";
      el.style.gridTemplateColumns = "40px 1fr 140px 1fr auto";
      el.style.gap = "6px"; el.style.alignItems = "center";
      el.style.border = "1px solid #6666"; el.style.borderRadius = "6px"; el.style.padding = "6px"; el.style.margin = "6px 0";

      const label = document.createElement("div"); label.textContent = key; label.style.opacity = ".7";
      const nameInput = document.createElement("input"); nameInput.type = "text"; nameInput.placeholder = "Category Name"; nameInput.value = data.name || key;

      const srcSel = document.createElement("select");
      for (const [k, v] of Object.entries(sourcesMap)) {
        const opt = document.createElement("option"); opt.value = k; opt.textContent = v;
        if ((data.source || "data") === k) opt.selected = true;
        srcSel.appendChild(opt);
      }

      const folderInput = document.createElement("input"); folderInput.type = "text"; folderInput.placeholder = "Root Folder (optional)"; folderInput.value = data.folder || "";
      const browseBtn = document.createElement("button"); browseBtn.innerHTML = `<i class="fas fa-folder-open"></i> Browse`;
      const uploadBtn = document.createElement("button"); uploadBtn.innerHTML = `<i class="fas fa-plus"></i> Add`; // "Add"
      const delBtn = document.createElement("button"); delBtn.innerHTML = `<i class="fas fa-trash"></i>`; delBtn.title = "Delete this category";

      el.appendChild(label); el.appendChild(nameInput); el.appendChild(srcSel); el.appendChild(folderInput); el.appendChild(browseBtn); el.appendChild(uploadBtn); el.appendChild(delBtn);

      browseBtn.addEventListener("click", () => {
        const FPClass = FP();
        if (!FPClass) return ui.notifications?.warn("FilePicker is not available.");
        const picker = new FPClass({
          type: "folder",
          current: folderInput.value || "",
          activeSource: srcSel.value || "data",
          callback: (p) => { if (p) folderInput.value = p; }
        });
        picker.render(true);
      });

      uploadBtn.addEventListener("click", async () => {
        const chosen = await pickMediaPathViaFilePicker({
          source: srcSel.value || "data",
          current: folderInput.value || "",
          allowUpload: true
        });
        if (!chosen) return;
        await addFileToCategory(key, chosen);
        ui.notifications?.info(`Added to allowlist: ${chosen}`);
        try { WebMViewerApp?.instance?.refreshIndex?.(false); } catch {}
      });

      delBtn.addEventListener("click", async () => {
        const ok = await Dialog.confirm({ title: "Delete Category", content: `<p>Are you sure you want to delete: ${escapeHtml(nameInput.value || key)}?</p>` });
        if (!ok) return;
        const idx = rows.findIndex(r => r.el === el);
        if (idx >= 0) rows.splice(idx, 1);
        renderRows();
      });

      return {
        el,
        getData() {
          return {
            name: nameInput.value?.trim() || key,
            source: srcSel.value || "data",
            folder: folderInput.value?.trim() || "",
            extraFiles: Array.isArray(data.extraFiles) ? data.extraFiles : [],
            hiddenFiles: Array.isArray(data.hiddenFiles) ? data.hiddenFiles : []
          };
        }
      };
    };

    for (const k of keys) rows.push(createRow(catsObj[k] || { name: k, folder: "", source: "data" }, k));
    renderRows();

    addBtn.addEventListener("click", () => {
      if (rows.length >= MAX_CATEGORIES) return ui.notifications?.warn(`A maximum of ${MAX_CATEGORIES} categories are supported.`);
      const used = new Set(rows.map(r => r.el.dataset.key));
      let n = 1; while (used.has(`cat${n}`)) n++;
      const key = `cat${n}`;
      rows.push(createRow({ name: `Category ${n}`, folder: "", source: "data", extraFiles: [], hiddenFiles: [] }, key));
      renderRows();
    });

    saveBtn.addEventListener("click", async () => {
      const out = {};
      const rowEls = Array.from(body.querySelectorAll(".cat-row"));
      let idx = 1;
      for (const el of rowEls) {
        const row = rows.find(r => r.el === el); if (!row) continue;
        out[`cat${idx}`] = row.getData();
        idx++;
      }
      await game.settings.set(MODULE_ID, "categories", out);
      FOLDER_LIST_CACHE.clear();
      ui.notifications?.info("Category configuration saved.");
      try { WebMViewerApp?.instance?.refreshIndex?.(true); } catch {}
    });

    closeBtn.addEventListener("click", () => this.close());
    return r;
  }
}

/* ============== Sequencer Related ============== */
async function endEffectByUniqueName(name) {
  if (!name) return;
  try {
    if (Sequencer?.EffectManager?.endEffects) await Sequencer.EffectManager.endEffects({ name });
    else await canvas?.sequencer?.endEffects?.({ name });
  } catch (e) { console.warn(`[${MODULE_ID}] Failed to end ${name}`, e); }
}
async function endEffectRobust(name) {
  try { await endEffectByUniqueName(name); } catch {}
  try {
    const list = (Sequencer?.EffectManager?.getEffects?.() && Array.from(Sequencer.EffectManager.getEffects())) || [];
    const hits = list.filter(e => e?.data?.name === name || e?.name === name);
    for (const ef of hits) { try { await ef.end?.(); } catch {} }
  } catch {}
}
function removeActiveRecordByName(name) {
  const i = ACTIVE_EFFECTS.findIndex(r => r.name === name);
  if (i >= 0) ACTIVE_EFFECTS.splice(i, 1);
}
async function clearSequencerEffects() {
  try {
    if (ACTIVE_EFFECTS.length) {
      const names = ACTIVE_EFFECTS.map(r => r.name);
      for (const n of names) await endEffectRobust(n);
      ACTIVE_EFFECTS = [];
      LAST_CLEAR_AT = Date.now();
      ORDER_COUNTER = 0;
      CURRENT_PRESET_TAG = null;
      try { (WebMViewerApp?.instance ?? window.sequencerWebmOrbViewer)?.renderNowPlaying?.(); } catch {}
      ui.notifications?.info("All effects from this module have been cleared.");
      return;
    }
    if (Sequencer?.EffectManager?.endAllEffects) await Sequencer.EffectManager.endAllEffects();
    LAST_CLEAR_AT = Date.now(); ORDER_COUNTER = 0; CURRENT_PRESET_TAG = null;
    ui.notifications?.info("All Sequencer effects have been cleared.");
  } catch (e2) {
    console.error(e2);
    ui.notifications?.warn("Failed to clear effects, please check the console.");
  }
}

// Get "Environment" volume from core
function getEnvironmentVolume() {
  try {
    const core = "core";
    const keys = ["globalAmbientVolume", "globalEnvironmentVolume", "globalEnvironment", "globalAmbient"];
    for (const k of keys) {
      const v = game.settings.get(core, k);
      if (typeof v === "number") return Math.max(0, Math.min(1, v));
    }
  } catch {}
  return 1.0;
}

// Play fullscreen on map (cover calculation; videos allow audio tracks, scaled by environment volume)
async function playFullscreen(path, {
  effectName = EFFECT_TAG,
  skipGlobalClear = false,
  explicitZ = null,
  explicitName = null,
  registerActive = true,
  fadeInOverride = undefined,
  fadeOutOverride = undefined
} = {}) {
  // BUG FIX: Ensure path is decoded before being used by Sequencer
  const decodedPath = decodeURIComponent(path);

  const opts = game.settings.get(MODULE_ID, "playOptions") || {};
  const fadeInMs = (fadeInOverride !== undefined ? fadeInOverride : (opts.fadeIn ?? 250));
  const fadeOutMs = (fadeOutOverride !== undefined ? fadeOutOverride : (opts.fadeOut ?? 400));

  if (opts.clearBeforePlay && !skipGlobalClear) await clearSequencerEffects();

  if (!canvas || !canvas.scene) {
    ui.notifications.error("Cannot play effect: No active scene.");
    return;
  }
  const sceneDims = canvas.scene.dimensions;
  if (!sceneDims || !sceneDims.width || !sceneDims.height) {
      ui.notifications.error("Cannot get scene dimensions. Please ensure the scene is configured correctly.");
      console.error(`[${MODULE_ID}] Scene dimensions are invalid:`, sceneDims);
      return;
  }

  if (typeof Sequence !== "function") {
    ui.notifications?.error("Sequencer is not available.");
    return;
  }

  let zIndex;
  const orderMode = game.settings.get(MODULE_ID, "orderMode") || "asc";
  if (explicitZ === null || explicitZ === undefined) {
    zIndex = orderMode === "asc" ? (Z_BASE + (ORDER_COUNTER++)) : (Z_BASE + Z_RANGE - (ORDER_COUNTER++));
  } else zIndex = explicitZ;

  const rec = { id: rid(16), path: decodedPath, tag: effectName, z: zIndex };
  rec.name = explicitName || `${effectName}:${rec.id}`;

  const seq = new Sequence();
  let e = seq.effect().file(decodedPath).name(rec.name).persist(true);
  e = chainCall(e, "loop", true);
  e = chainCall(e, "fadeIn", fadeInMs);
  e = chainCall(e, "fadeOut", fadeOutMs);

  try {
    if (isVideo(decodedPath)) {
      const vol = getEnvironmentVolume();
      e = chainCall(e, "noAudio", false);
      e = chainCall(e, "volume", vol);
    }
  } catch {}

  let placed = false;
  try {
    const center = { x: sceneDims.width / 2, y: sceneDims.height / 2 };
    e = chainCall(e, "atLocation", center);
    placed = true;
    
    const { w, h } = await getMediaSize(decodedPath);
    const imageW = canvas.scene.width;
    const imageH = canvas.scene.height;

    if (w > 0 && h > 0) {
      const arMedia = w / h;
      const arImage = imageW / imageH;
      let outW, outH;

      if (arMedia < arImage) {
        outW = imageW;
        outH = imageW / arMedia;
      } else {
        outH = imageH;
        outW = imageH * arMedia;
      }
      e = chainCall(e, "size", { width: outW, height: outH });
    } else {
      e = chainCall(e, "size", { width: imageW, height: imageH });
    }
  } catch(err) {
      console.error(`[${MODULE_ID}] Failed to position or scale effect`, err);
      placed = false;
  }
  
  e = chainCall(e, "anchor", { x: 0.5, y: 0.5 });
  e = chainCall(e, "zIndex", zIndex);

  if (!placed) {
    ui.notifications?.error("Failed to determine playback position, please check the console.");
    return;
  }

  try {
    await seq.play();
    if (registerActive) ACTIVE_EFFECTS.push(rec);
    try { (WebMViewerApp?.instance ?? window.sequencerWebmOrbViewer)?.renderNowPlaying?.(); } catch {}
    PLAY_LOG.push({ path: decodedPath, ts: Date.now() });
    return rec;
  } catch (err) {
    console.error("Sequencer playback failed", err);
    ui.notifications?.error("Playback failed, please check the file path and Sequencer.");
  }
}


async function replaceActiveEffectByName(name, newPath) {
  const idx = ACTIVE_EFFECTS.findIndex(r => r.name === name);
  if (idx < 0) { ui.notifications?.warn("The selected effect no longer exists."); NP_SELECTED = null; return false; }
  const rec = ACTIVE_EFFECTS[idx];

  await endEffectRobust(rec.name);

  const newId = rid(16);
  const newName = `${rec.tag}:${newId}`;
  const newRec = await playFullscreen(newPath, { effectName: rec.tag, skipGlobalClear: true, explicitZ: rec.z, explicitName: newName, registerActive: false });
  if (newRec) {
    ACTIVE_EFFECTS[idx] = newRec;
    NP_SELECTED = null;
    try { (WebMViewerApp?.instance ?? window.sequencerWebmOrbViewer)?.renderNowPlaying?.(); } catch {}
    return true;
  }
  return false;
}

/* ============== Presets: Utility Functions ============== */
function getPresets() {
  return foundry.utils.duplicate(game.settings.get(MODULE_ID, "presets") || {});
}
async function setPresets(obj) {
  await game.settings.set(MODULE_ID, "presets", obj);
}
async function createPresetFolder(name) {
  const ps = getPresets();
  if (!ps[name]) ps[name] = [];
  await setPresets(ps);
}
async function addPreset(folder, preset) {
  const ps = getPresets();
  if (!ps[folder]) ps[folder] = [];
  ps[folder].push(preset);
  await setPresets(ps);
}
async function renamePresetFolder(oldName, newName) {
  const ps = getPresets();
  if (!ps[oldName]) return;
  if (ps[newName]) return ui.notifications?.warn("A folder with the same name already exists.");
  ps[newName] = ps[oldName];
  delete ps[oldName];
  await setPresets(ps);
}
async function deletePresetFolder(name) {
  const ps = getPresets();
  delete ps[name];
  await setPresets(ps);
}
async function renamePreset(folder, id, newName) {
  const ps = getPresets();
  const list = ps[folder] || [];
  const p = list.find(x => x.id === id);
  if (!p) return;
  p.name = newName;
  await setPresets(ps);
}
async function deletePreset(folder, id) {
  const ps = getPresets();
  const list = ps[folder] || [];
  ps[folder] = list.filter(x => x.id !== id);
  await setPresets(ps);
}

/* ============== Save Preset ============== */
function buildPresetItems() {
  if (ACTIVE_EFFECTS.length) {
    const seen = new Set(); const arr = [];
    for (const r of ACTIVE_EFFECTS) { if (seen.has(r.path)) continue; seen.add(r.path); arr.push({ path: r.path }); }
    return arr;
  }
  const list = PLAY_LOG.filter(e => e.ts >= LAST_CLEAR_AT).sort((a, b) => a.ts - b.ts);
  return list.map(e => ({ path: e.path }));
}
async function savePresetFlow() {
  const items = buildPresetItems();
  if (!items.length) return ui.notifications?.warn("No effects to save: please play some effects first.");
  const ps = getPresets(); const names = Object.keys(ps);
  const def = `Preset ${new Date().toLocaleString()}`;
  let content = `<div class="fvtt-dialog"><p>Select a folder to save to:</p><div class="fav-list">`;
  for (const n of names) content += `<label style="display:block;margin:4px 0;"><input type="radio" name="pf" value="${escapeAttr(n)}"> ${escapeHtml(n)}</label>`;
  content += `</div><div style="display:flex;gap:8px;align-items:center;margin:6px 0;"><input type="text" name="nf" placeholder="New Folder Name" style="flex:1;"></div><hr/><div style="display:flex;gap:8px;align-items:center;"><label style="min-width:70px;">Preset Name</label><input type="text" name="pn" value="${escapeAttr(def)}" style="flex:1;"></div></div>`;
  new Dialog({
    title: "Save Preset",
    content,
    buttons: {
      ok: {
        label: "Save", icon: '<i class="fas fa-save"></i>',
        callback: async (h) => {
          if (!game.user?.isGM) return ui.notifications?.warn("Only GMs can save presets.");
          const folderSel = h[0].querySelector('input[name="pf"]:checked')?.value?.trim();
          const newFolder = h[0].querySelector('input[name="nf"]')?.value?.trim();
          const name = h[0].querySelector('input[name="pn"]')?.value?.trim() || def;
          const folder = newFolder || folderSel || "Default";
          if (newFolder && !getPresets()[newFolder]) await createPresetFolder(newFolder);
          const preset = { id: rid(16), name, created: Date.now(), items };
          await addPreset(folder, preset);
          ui.notifications?.info(`Preset saved to folder: ${folder}`);
        }
      },
      cancel: { label: "Cancel" }
    }
  }).render(true);
}

/* ============== Application (Compact single-column UI) ============== */
let WebMViewerApp;

Hooks.once("init", () => {
  class _ViewerV1 extends Application {
    static _instance = null;
    static get defaultOptions() {
      return foundry.utils.mergeObject(super.defaultOptions, {
        id: `${MODULE_ID}-viewer`,
        title: "Fullscreen Media Player",
        template: `modules/${MODULE_ID}/templates/viewer.hbs`,
        width: 1024, height: 768, resizable: true
      });
    }
    static get instance() { return this._instance; }
    static show() { if (!game.user.isGM) return ui.notifications?.warn("Only GMs can use the player."); if (!this._instance) { this._instance = new _ViewerV1(); window.sequencerWebmOrbViewer = this._instance; } this._instance.render(true); }
    constructor(...a) {
      super(...a);
      this.mode = "overview";
      this.activeCategoryKey = null;
      this.mediaFilterMode = "all";
      this.searchQuery = "";
      this.index = [];
      this.loading = false;
      this.activeFav = null;
      this.activeFolder = null;
      this._lastRightClick = { ts: 0, path: null };
      this._rctxSuppressUntil = 0;
      this._virtual = { chunkSize: 72, next: 0, files: [], observer: null };
      this.isNowPlayingExpanded = true;
    }
    getData() {
      const cats = getCategoriesArray().map(c => ({ ...c, isActive: this.mode === "category" && this.activeCategoryKey === c.key }));
      const files = this.filteredFiles();
      let activeCategoryName = "Category";
      const activeCat = cats.find(c => c.isActive);
      if (activeCat) {
          activeCategoryName = activeCat.name;
      }
      return {
        categories: cats,
        activeCategoryName,
        isOverview: this.mode === "overview",
        isFavorites: this.mode === "favorites",
        isPresets: this.mode === "presets",
        hasFiles: files.length > 0,
        loading: this.loading,
        searchQuery: this.searchQuery,
        filterLabel: this.mediaFilterMode === "all" ? "All" : this.mediaFilterMode === "img" ? "Images" : "Videos",
        canAddCurrent: this.mode === "category" && !!this.activeCategoryKey,
        isNowPlayingExpanded: this.isNowPlayingExpanded,
        activeEffectsCount: ACTIVE_EFFECTS.length,
      };
    }
    filteredFiles() {
      let f = [];
      if (this.mode === "overview") f = this.index;
      else if (this.mode === "category" && this.activeCategoryKey) f = this.index.filter(x => x.categoryKey === this.activeCategoryKey);
      const q = this.searchQuery?.trim()?.toLowerCase();
      if (q) f = f.filter(x => {
        const name = displayNameFor(x.path).toLowerCase();
        const pathBase = stripQuery(x.path).toLowerCase();
        return name.includes(q) || pathBase.includes(q);
      });
      if (this.mediaFilterMode === "img") f = f.filter(x => isImage(x.path));
      else if (this.mediaFilterMode === "vid") f = f.filter(x => isVideo(x.path));
      return f.sort((a, b) => displayNameFor(a.path).localeCompare(displayNameFor(b.path), "en-US"));
    }
    async _render(force, options) {
      const r = await super._render(force, options);
      if (!this._indexInitialized) { this._indexInitialized = true; await this.refreshIndex(false); }
      attachViewerEvents(this, this.element[0]);
      makeTopStickyLayout(this, this.element[0]);
      renderMainPanel(this, this.element[0]);
      renderNowPlayingGrid(this, this.element[0]);
      attachGlobalAddFileHandler(this, this.element[0]);
      return r;
    }
    async refreshIndex(force = false) {
      this.loading = true; this.render(false);
      const cats = getCategoriesArray().filter(c => c.folder?.trim() || (c.extraFiles?.length));
      const all = [];
      for (const cat of cats) {
        const set = new Set();
        const hiddenArr = Array.isArray(cat.hiddenFiles) ? cat.hiddenFiles : [];
        const hiddenExact = new Set(hiddenArr);
        const hiddenBase = new Set(hiddenArr.map(stripQuery));

        if (cat.folder?.trim()) {
          const list = await getFolderFilesCached(cat.folder, cat.source || "data", force);
          for (const file of list) {
            const base = stripQuery(file);
            if (hiddenExact.has(file) || hiddenBase.has(base)) continue;
            if (!set.has(file)) {
              set.add(file);
              all.push({ path: file, name: stripQuery(file).split("/").pop(), categoryKey: cat.key, source: cat.source || "data" });
            }
          }
        }
        for (const file of (cat.extraFiles || [])) {
          if (!hasMediaExt(file)) continue;
          const base = stripQuery(file);
          if (hiddenExact.has(file) || hiddenBase.has(base)) continue;
          if (!set.has(file)) {
            set.add(file);
            all.push({ path: file, name: stripQuery(file).split("/").pop(), categoryKey: cat.key, source: cat.source || "data" });
          }
        }
      }
      this.index = all;
      this.loading = false; this.render(false);
    }
    renderNowPlaying() {
        // BUG FIX: Targeted update instead of full re-render
        renderNowPlayingGrid(this, this.element[0]);
        const rootEl = this.element[0];
        if (rootEl) {
            const countEl = rootEl.querySelector('.np-title .count');
            if (countEl) countEl.textContent = ACTIVE_EFFECTS.length;
        }
    }
  }

  WebMViewerApp = _ViewerV1;
  registerSettings();
});

/* ============== Settings Registration ============== */
function registerSettings() {
  game.settings.register(MODULE_ID, "categories", { name: "Category Mappings", scope: "world", config: false, type: Object, default: defaultCategories() });
  game.settings.register(MODULE_ID, "presets", { name: "Presets", scope: "world", config: false, type: Object, default: {} });
  game.settings.register(MODULE_ID, "favorites", { name: "Favorites", scope: "client", config: false, type: Object, default: {} });
  game.settings.register(MODULE_ID, "aliases", { name: "File Aliases", scope: "world", config: false, type: Object, default: {} });
  game.settings.register(MODULE_ID, "orbPosition", { name: "Floating Orb Position", scope: "client", config: false, type: Object, default: { left: 20, top: 120 } });
  game.settings.register(MODULE_ID, "playOptions", { name: "Playback Options", scope: "client", config: false, type: Object, default: { clearBeforePlay: false, fadeIn: 250, fadeOut: 400 } });

  game.settings.register(MODULE_ID, "orderMode", {
    name: "Placement Order",
    hint: "Determines stacking direction: Ascending = played later is on top; Descending = played later is on bottom.",
    scope: "client",
    config: true,
    type: String,
    choices: { asc: "Ascending (Played later is on top)", desc: "Descending (Played later is on bottom)" },
    default: "asc"
  });
  game.settings.register(MODULE_ID, "previewMaxActive", {
    name: "Video Preview Concurrency Limit",
    hint: "Maximum number of video thumbnails to load simultaneously. Higher values reduce blank spaces but may impact performance.",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 8, max: 128, step: 1 },
    default: 24
  });
  game.settings.register(MODULE_ID, "hoverPreview", {
    name: "Hover to Preview Videos",
    hint: "Play a muted, looped preview when hovering over a video thumbnail.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "showOrb", {
    name: "Show Floating Orb (GM only)",
    hint: "Show/hide the floating orb entry point for the player on the canvas.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "previewBg", {
    name: "Preview Background Color",
    hint: "Background color used for thumbnails and previews.",
    scope: "client",
    config: true,
    type: String,
    choices: {
      "white": "White",
      "black": "Black",
      "pale-yellow": "Pale Yellow",
      "light-brown": "Light Brown",
      "deep-brown": "Deep Brown",
      "mustard": "Mustard",
      "gray": "Gray"
    },
    default: "black",
    onChange: () => { try { WebMViewerApp?.instance?.render?.(false); } catch {} }
  });

  game.settings.register(MODULE_ID, "openCatConfig", {
    name: "Open Category Mapping Manager",
    hint: "Checking this will immediately open the category configuration UI (GM only).",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: async (v) => {
      if (v) {
        await game.settings.set(MODULE_ID, "openCatConfig", false);
        if (!game.user?.isGM) return ui.notifications?.warn("Only GMs can configure categories.");
        new CategoriesConfigForm().render(true);
      }
    }
  });

  game.settings.registerMenu(MODULE_ID, "categoriesConfig", {
    name: "Category Mappings",
    label: "Configure Categories & Folders",
    hint: "Create/delete up to 50 categories, and for each, select a source and root folder (S3 supported). Can also be left empty to use only allowlisted files.",
    icon: "fas fa-folder-tree",
    type: CategoriesConfigForm,
    restricted: true
  });
}

/* ============== Floating Orb (GM only) ============== */
class FloatingOrb {
  static ensure() {
    if (!game.user.isGM) return;
    if (!game.settings.get(MODULE_ID, "showOrb")) return;
    if (document.getElementById(`${MODULE_ID}-orb`)) return;
    const pos = game.settings.get(MODULE_ID, "orbPosition") ?? { left: 20, top: 120 };
    const orb = document.createElement("div");
    orb.id = `${MODULE_ID}-orb`;
    orb.title = "Left Double-Click: Open Player; Right Double-Click: Save Preset";
    Object.assign(orb.style, {
      position: "fixed", left: `${pos.left}px`, top: `${pos.top}px`,
      width: "44px", height: "44px", borderRadius: "50%",
      background: "rgba(30,30,30,.85)", boxShadow: "0 2px 8px rgba(0,0,0,.4)",
      color: "#fff", zIndex: "100000", display: "flex", alignItems: "center",
      justifyContent: "center", cursor: "pointer", userSelect: "none",
      transition: "opacity .2s, box-shadow .2s", opacity: "0.8"
    });
    orb.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;"><i class="fas fa-film" style="font-size:18px;"></i></div>`;
    document.body.appendChild(orb);
    let dragging = false; let offset = { x: 0, y: 0 };
    orb.addEventListener("mousedown", (ev) => { if (ev.button !== 0) return; dragging = true; orb.style.opacity = "1"; orb.style.boxShadow = "0 0 12px rgba(0, 170, 255, 0.7)"; offset.x = ev.clientX - orb.offsetLeft; offset.y = ev.clientY - orb.offsetTop; });
    window.addEventListener("mousemove", (ev) => { if (!dragging) return; const left = Math.max(0, Math.min(window.innerWidth - orb.offsetWidth, ev.clientX - offset.x)); const top = Math.max(0, Math.min(window.innerHeight - orb.offsetHeight, ev.clientY - offset.y)); orb.style.left = `${left}px`; orb.style.top = `${top}px`; });
    window.addEventListener("mouseup", async () => { if (!dragging) return; dragging = false; orb.style.opacity = "0.8"; orb.style.boxShadow = "0 2px 8px rgba(0,0,0,.4)"; await game.settings.set(MODULE_ID, "orbPosition", { left: parseInt(orb.style.left), top: parseInt(orb.style.top) }); });
    orb.addEventListener("mouseenter", () => { if (!dragging) orb.style.opacity = "1"; });
    orb.addEventListener("mouseleave", () => { if (!dragging) orb.style.opacity = "0.8"; });
    orb.addEventListener("dblclick", () => { if (!game.user.isGM) return ui.notifications?.warn("Only GMs can use this feature."); WebMViewerApp.show(); });
    let lastCtx = 0;
    orb.addEventListener("contextmenu", (ev) => { ev.preventDefault(); if (!game.user.isGM) return ui.notifications?.warn("Only GMs can use this feature."); const now = Date.now(); if (now - lastCtx < 400) { lastCtx = 0; savePresetFlow(); } else lastCtx = now; });
  }
}
Hooks.once("ready", () => {
  if (game.user.isGM && game.settings.get(MODULE_ID, "showOrb")) FloatingOrb.ensure();
});

/* ============== Preloading (True images only) ============== */
function eagerLoadMediaIn(rootEl) {
  if (!rootEl) return;
  const nodes = rootEl.querySelectorAll(
    "img.preview-img:not([data-eager]), img.layer-preview-img:not([data-eager]), img.np-thumb-img:not([data-eager])"
  );
  for (const el of nodes) {
    const src = el.dataset.src || "";
    if (!src) continue;
    if (el.dataset.eager === "1") continue;
    el.dataset.eager = "1";
    try { el.src = src; } catch {}
  }
}

/* ============== Video Previews: Mount src only for visible items (no playback) + Hover to play ============== */
function attachVideoPreview(v) {
  if (!v || v.dataset.attached === "1") return;
  const limit = getPreviewMaxActive();
  if (PREVIEW_ACTIVE_SET.size >= limit) return;
  const src = v.dataset.src || v.closest("[data-path]")?.dataset.path || "";
  if (!src) return;
  try {
    v.muted = true;
    v.playsInline = true;
    v.preload = "metadata";
    v.src = src;
    v.dataset.attached = "1";
    PREVIEW_ACTIVE_SET.add(v);
    v.onloadeddata = () => {};
    v.onerror = () => { detachVideoPreview(v); };
  } catch {}
}
function detachVideoPreview(v) {
  if (!v || v.dataset.attached !== "1") return;
  try { v.pause?.(); v.removeAttribute("src"); v.load?.(); } catch {}
  delete v.dataset.attached;
  PREVIEW_ACTIVE_SET.delete(v);
}
function enableHoverPlayback(container) {
  if (!container || container._hoverDelegated) return;
  container.addEventListener("mouseover", (ev) => {
    if (!game.settings.get(MODULE_ID, "hoverPreview")) return;
    const v = ev.target.closest("video.preview, video.layer-preview, video.np-thumb");
    if (!v || !container.contains(v)) return;
    try { v.muted = true; v.loop = true; v.play().catch(()=>{}); } catch {}
  });
  container.addEventListener("mouseout", (ev) => {
    const v = ev.target.closest("video.preview, video.layer-preview, video.np-thumb");
    if (!v || !container.contains(v)) return;
    try { v.pause(); } catch {}
  });
  container._hoverDelegated = true;
}
function observeVideoPreviews(container, opts = {}) {
  if (!container) return;
  const root = opts.root || container;
  let io = container._vpIO;
  if (!io) {
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const v = e.target;
        if (!(v instanceof HTMLVideoElement)) continue;
        if (e.isIntersecting) attachVideoPreview(v);
        else detachVideoPreview(v);
      }
    }, { root, rootMargin: "200px 0px", threshold: 0.01 });
    container._vpIO = io;
  }
  const vids = container.querySelectorAll("video.preview, video.layer-preview, video.np-thumb");
  vids.forEach(v => io.observe(v));
  enableHoverPlayback(container);
}

/* ============== Top-Sticky + Middle-Scroll Layout ============== */
function makeTopStickyLayout(app, rootEl) {
  const wc = getWC(rootEl); if (!wc) return;
  wc.style.display = "flex";
  wc.style.flexDirection = "column";
  wc.style.height = "100%";
  wc.style.overflow = "hidden";
}
function getWC(rootEl) { return rootEl?.querySelector?.(".window-content") || null; }

/* ============== Main Panel Rendering ============== */
function renderMainPanel(app, rootEl) {
  const scroller = rootEl.querySelector(".main-panel-scroller");
  if (!scroller) return;

  const gridHost = scroller.querySelector(".grid");
  const favPanel = scroller.querySelector("#orb-fav-panel");
  const prePanel = scroller.querySelector("#orb-pre-panel");

  if (!gridHost || !favPanel || !prePanel) return;

  gridHost.style.display = "none";
  favPanel.style.display = "none";
  prePanel.style.display = "none";

  if (app.mode === "favorites") {
    favPanel.innerHTML = buildFavoritesPanelHTML(app);
    favPanel.style.display = "";
    attachFavoritesInline(app, favPanel);
    eagerLoadMediaIn(favPanel);
    observeVideoPreviews(favPanel, { root: scroller });
    bindPlayDelegates(app, favPanel);
    bindCornerDelegates(app, favPanel);
  } else if (app.mode === "presets") {
    prePanel.innerHTML = buildPresetsPanelHTML(app);
    prePanel.style.display = "";
    attachPresetsInline(app, prePanel);
    eagerLoadMediaIn(prePanel);
    observeVideoPreviews(prePanel, { root: scroller });
    bindPlayDelegates(app, prePanel);
    bindCornerDelegates(app, prePanel);
  } else {
    gridHost.style.display = "grid";
    mountVirtualGrid(app, scroller, gridHost);
    eagerLoadMediaIn(gridHost);
    observeVideoPreviews(gridHost, { root: scroller });
    bindPlayDelegates(app, gridHost);
    bindCornerDelegates(app, gridHost);
  }
}

/* ============== Favorites/Presets Panels ============== */
function buildFavoritesPanelHTML(app) {
  const favs = getFavorites();
  const names = Object.keys(favs).sort((a, b) => a.localeCompare(b, "en-US"));
  if (!app.activeFav && names.length) app.activeFav = names[0];
  const files = (favs[app.activeFav] || []);
  const sidebar = `
    <div class="sidebar">
      <div class="side-actions">
        <button data-action="fav-create" title="New"><i class="fas fa-plus"></i></button>
        <button data-action="fav-rename" title="Rename"><i class="fas fa-i-cursor"></i></button>
        <button data-action="fav-delete" title="Delete"><i class="fas fa-trash"></i></button>
      </div>
      <ul class="side-list">
        ${names.map(n => `<li class="side-item ${n===app.activeFav?'active':''}" data-name="${escapeAttr(n)}"><span>${escapeHtml(n)}</span> <span class="count">${(favs[n]||[]).length}</span></li>`).join("")}
      </ul>
    </div>`;
  const body = `
    <div class="side-content">
      <div class="grid">
        ${files.map(p => buildFavTileHTML(p)).join("") || `<div class="empty-placeholder">This favorite is empty.</div>`}
      </div>
    </div>`;
  return `<div class="orb-panel">${sidebar}${body}</div>`;
}
function buildFavTileHTML(path) {
  const label = displayNameFor(path);
  const media = isVideo(path)
    ? `<video class="preview" muted preload="metadata" playsinline data-src="${escapeAttr(path)}"></video>`
    : `<img class="preview-img" data-src="${escapeAttr(path)}" />`;
  return `<div class="webm-item fav-file" data-path="${escapeAttr(path)}">
    <div class="thumb">${media}</div>
    <div class="title-bar">
      <div class="name" title="${escapeAttr(path)}">${escapeHtml(label)}</div>
      <button data-action="rename-alias" class="action-btn" title="Rename"><i class="fas fa-pencil-alt"></i></button>
    </div>
    <button class="remove-from-fav" title="Remove from Favorites"><i class="fas fa-times"></i></button>
  </div>`;
}
function attachFavoritesInline(app, panel) {
  if (!panel) return;
  panel.addEventListener("click", async (ev) => {
      const item = ev.target.closest(".side-item");
      if(item) {
        app.activeFav = item.dataset.name;
        renderMainPanel(app, app.element[0]);
        return;
      }

      const actionBtn = ev.target.closest(".side-actions button");
      if(actionBtn) {
        const action = actionBtn.dataset.action;
        if (action === "fav-create") {
            const name = await promptString("New Favorite", "Enter a name");
            if (name) { await createFavorite(name); app.activeFav = name; renderMainPanel(app, app.element[0]); }
        } else if (action === "fav-rename") {
            if (!app.activeFav) return;
            const name = await promptString("Rename Favorite", "Enter a new name", app.activeFav);
            if (name) { await renameFavorite(app.activeFav, name); app.activeFav = name; renderMainPanel(app, app.element[0]); }
        } else if (action === "fav-delete") {
            if (!app.activeFav) return;
            const ok = await Dialog.confirm({ title: "Delete Favorite", content: `<p>Are you sure you want to delete the favorite: ${escapeHtml(app.activeFav)}?</p>` });
            if (ok) { await deleteFavorite(app.activeFav); app.activeFav = null; renderMainPanel(app, app.element[0]); }
        }
        return;
      }
      
      const removeBtn = ev.target.closest(".remove-from-fav");
      if(removeBtn) {
        const path = removeBtn.closest(".fav-file")?.dataset.path;
        await removeFromFavorite(app.activeFav, path);
        renderMainPanel(app, app.element[0]);
        return;
      }

      const renameAliasBtn = ev.target.closest("button[data-action='rename-alias']");
      if(renameAliasBtn) {
        const card = renameAliasBtn.closest(".fav-file");
        const path = card?.dataset.path;
        const old = getFileAlias(path) || displayNameFor(path);
        const name = await promptString("Set Display Name", "Enter new display name (leave blank to restore original)", old);
        await setFileAlias(path, name || "");
        card.querySelector(".name").textContent = displayNameFor(path);
      }
  });
}

function buildPresetsPanelHTML(app) {
  const ps = getPresets();
  const folders = Object.keys(ps).sort((a, b) => a.localeCompare(b, "en-US"));
  if (!app.activeFolder && folders.length) app.activeFolder = folders[0];
  const list = Array.isArray(ps[app.activeFolder]) ? ps[app.activeFolder] : [];
  
  const sidebar = `
    <div class="sidebar">
      <div class="side-actions">
        <button data-action="pre-create-folder" title="New Folder"><i class="fas fa-folder-plus"></i></button>
        <button data-action="pre-rename-folder" title="Rename Folder"><i class="fas fa-i-cursor"></i></button>
        <button data-action="pre-delete-folder" title="Delete Folder"><i class="fas fa-trash"></i></button>
      </div>
      <ul class="side-list">
        ${folders.map(n => `<li class="side-item ${n===app.activeFolder?'active':''}" data-name="${escapeAttr(n)}"><span>${escapeHtml(n)}</span> <span class="count">${(Array.isArray(ps[n]) ? ps[n].length : 0)}</span></li>`).join("")}
      </ul>
    </div>`;
  const body = `
    <div class="side-content preset-body">
      <div class="preset-list">
        ${list.map(p => `
          <div class="pcard" data-id="${escapeAttr(p.id)}" data-name="${escapeAttr(p.name)}">
            <div class="pcard-main">
                <div class="pcard-title" title="${escapeAttr(p.name)}">${escapeHtml(p.name)}</div>
                <div class="pcard-meta">${new Date(p.created||0).toLocaleDateString()} · ${(p.items||[]).length} layers</div>
            </div>
            <div class="pcard-layers">
              ${(p.items || []).slice(0, 5).map(item => {
                const path = item.path;
                if (isVideo(path)) {
                    return `<video class="layer-preview" muted preload="metadata" playsinline data-src="${escapeAttr(path)}"></video>`;
                } else {
                    return `<img class="layer-preview-img" data-src="${escapeAttr(path)}" />`;
                }
              }).join("")}
              ${(p.items || []).length > 5 ? `<div class="layer-more">+${(p.items || []).length - 5}</div>` : ''}
            </div>
            <div class="pcard-actions">
              <button class="play" title="Play"><i class="fas fa-play"></i></button>
              <button class="rename" title="Rename"><i class="fas fa-i-cursor"></i></button>
              <button class="delete" title="Delete"><i class="fas fa-trash"></i></button>
            </div>
          </div>
        `).join("") || `<div class="empty-placeholder">This folder is empty.</div>`}
      </div>
    </div>`;
  return `<div class="orb-panel">${sidebar}${body}</div>`;
}
function attachPresetsInline(app, panel) {
  if (!panel) return;
  panel.addEventListener("click", async (ev) => {
    // Switch folder
    const item = ev.target.closest(".side-item");
    if(item) {
        app.activeFolder = item.dataset.name;
        renderMainPanel(app, app.element[0]);
        return;
    }
    // Sidebar actions
    const sideActionBtn = ev.target.closest(".side-actions button");
    if(sideActionBtn) {
        const action = sideActionBtn.dataset.action;
        if (action === "pre-create-folder") {
            const name = await promptString("New Preset Folder", "Enter a name");
            if(name) { await createPresetFolder(name); app.activeFolder = name; renderMainPanel(app, app.element[0]); }
        } else if (action === "pre-rename-folder") {
            if(!app.activeFolder) return;
            const name = await promptString("Rename Folder", "Enter a new name", app.activeFolder);
            if(name) { await renamePresetFolder(app.activeFolder, name); app.activeFolder = name; renderMainPanel(app, app.element[0]); }
        } else if (action === "pre-delete-folder") {
            if(!app.activeFolder) return;
            const ok = await Dialog.confirm({ title: "Delete Folder", content: `<p>Are you sure you want to delete the folder ${escapeHtml(app.activeFolder)} and all its presets?</p>` });
            if(ok) { await deletePresetFolder(app.activeFolder); app.activeFolder = null; renderMainPanel(app, app.element[0]); }
        }
        return;
    }
    // Preset card actions
    const pcardActionBtn = ev.target.closest(".pcard-actions button");
    if(pcardActionBtn) {
        const row = pcardActionBtn.closest(".pcard");
        if(pcardActionBtn.classList.contains("play")) {
            await activatePresetById(app.activeFolder, row.dataset.id);
        } else if (pcardActionBtn.classList.contains("rename")) {
            const old = row.dataset.name;
            const name = await promptString("Rename Preset", "New name", old);
            if(name) { await renamePreset(app.activeFolder, row.dataset.id, name); renderMainPanel(app, app.element[0]); }
        } else if (pcardActionBtn.classList.contains("delete")) {
            const ok = await Dialog.confirm({ title: "Delete Preset", content: "<p>Are you sure you want to delete this preset?</p>" });
            if(ok) { await deletePreset(app.activeFolder, row.dataset.id); renderMainPanel(app, app.element[0]); }
        }
        return;
    }
    // Double click to play
    const pcard = ev.target.closest('.pcard');
    if (pcard && ev.detail === 2) {
        await activatePresetById(app.activeFolder, pcard.dataset.id);
    }
  });
}

/* ============== Generic Bindings ============== */
function bindPlayDelegates(app, root) {
  if (!root || root._playDelegated) return;
  const triggerPlay = async (path) => {
    if (!path) return;
    if (NP_SELECTED) await replaceActiveEffectByName(NP_SELECTED, path);
    else await playFullscreen(path);
    (WebMViewerApp?.instance ?? window.sequencerWebmOrbViewer)?.renderNowPlaying?.();
  };
  root.addEventListener("dblclick", async (ev) => {
    const item = ev.target.closest(".webm-item, .layer-tile");
    if (!item || !root.contains(item) || ev.target.closest("button, .corner-actions, .remove-from-fav, .title-bar")) return;
    const now = Date.now();
    if (root._dblLock && now < root._dblLock) return;
    root._dblLock = now + 250;
    ev.stopImmediatePropagation();
    await triggerPlay(item.dataset.path);
  });
  root.addEventListener("mousedown", async (ev) => {
    if (ev.button !== 2) return;
    const item = ev.target.closest(".webm-item");
    if (!item || !root.contains(item)) return;
    const now = Date.now(); const path = item.dataset.path;
    const last = app._lastRightClick || { ts: 0, path: "" };
    if (now - last.ts < 400 && last.path === path) {
      ev.preventDefault(); ev.stopImmediatePropagation();
      app._rctxSuppressUntil = now + 800;
      await clearSequencerEffects(); await triggerPlay(path);
    } else app._lastRightClick = { ts: now, path };
  }, true);

  root.addEventListener("contextmenu", (ev) => { ev.preventDefault(); });
  root._playDelegated = true;
}
function bindCornerDelegates(app, root) {
  if (!root || root._cornerDelegated) return;
  root.addEventListener("click", async (ev) => {
    const starBtn = ev.target.closest(".corner.add-fav");
    if (starBtn) {
      ev.preventDefault();
      const item = starBtn.closest("[data-path]");
      if (item) openFavDialog(item.dataset.path);
      return;
    }
    const banBtn = ev.target.closest(".corner.delete");
    if (banBtn) {
      ev.preventDefault();
      const item = banBtn.closest("[data-path]");
      const path = item?.dataset.path; const key = item?.dataset.catKey || (WebMViewerApp?.instance?.activeCategoryKey);
      if (!key) return ui.notifications?.warn("Please perform this action within a category.");
      const ok = await Dialog.confirm({ title: "Block/Remove this file", content: `<p>Are you sure you want to remove this file from the current category (or hide it for this category)?</p><p><small>${escapeHtml(path)}</small></p>` });
      if (!ok) return;
      const changed = await removeFromCategoryOrHide(key, path);
      if (changed) {
        ui.notifications?.info("File has been removed/hidden from this category.");
        try { await WebMViewerApp?.instance?.refreshIndex?.(false); } catch {}
      } else {
        ui.notifications?.warn("No changes were made.");
      }
    }
  });
  root._cornerDelegated = true;
}

/* ============== "Add File to Category" Dialog ============== */
async function openAddSingleFileDialog(catKey, appInstance) {
  const cat = getCategoriesArray().find(c => c.key === catKey);
  let content = `
    <div class="fvtt-dialog">
      <p style="margin-bottom: 8px;">Select a file to add to the allowlist of category "${escapeHtml(cat.name)}".</p>
      <div style="display:flex;gap:6px;align-items:center;">
        <input type="text" name="path" placeholder="Path will be shown here..." readonly style="flex:1;">
        <button type="button" name="browse"><i class="fas fa-folder-open"></i> Browse/Upload</button>
      </div>
    </div>`;
  return new Promise((resolve) => {
    const dlg = new Dialog({
      title: "Add File to Category",
      content,
      buttons: {
        ok: { label: "Add", icon: '<i class="fas fa-plus"></i>', callback: async (html) => {
          const path = html[0].querySelector('input[name="path"]')?.value?.trim();
          if (!path) return ui.notifications?.warn("Please select a file first.");
          await addFileToCategory(catKey, path);
          ui.notifications?.info("Added to category allowlist.");
          try { await appInstance?.refreshIndex?.(false); } catch {}
          resolve(true);
        }},
        cancel: { label: "Cancel", callback: () => resolve(false) }
      },
      default: "ok",
      render: (html) => {
        const pathInput = html[0].querySelector('input[name="path"]');
        const browseBtn = html[0].querySelector('button[name="browse"]');
        if(browseBtn && !browseBtn._listener) {
            browseBtn._listener = true;
            browseBtn.addEventListener("click", async () => {
                const p = await pickMediaPathViaFilePicker({
                    source: cat?.source || "data",
                    current: cat?.folder || "",
                    allowUpload: true
                });
                if (p) { pathInput.value = p; }
            });
        }
      }
    });
    dlg.render(true);
  });
}

/* ============== Handle "Add File to Current Category" Click ============== */
async function handleAddFileToCategory(app) {
  if (app?.mode === "category" && app?.activeCategoryKey) {
    await openAddSingleFileDialog(app.activeCategoryKey, app);
    return;
  }
}

/* ============== Toolbar Events (Full-window delegation) ============== */
function attachViewerEvents(app, rootEl) {
  if (!rootEl) return;
  const wc = getWC(rootEl);
  if (!wc || wc._delegated) return;

  wc.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-action]");
    const dropdownMenu = wc.querySelector('.category-dropdown .dropdown-menu');
    if (dropdownMenu && dropdownMenu.classList.contains('show')) {
      if (!ev.target.closest('.category-dropdown')) {
        dropdownMenu.classList.remove('show');
      }
    }
    
    // Now playing close button handler (BUG FIXED)
    const npCloseBtn = ev.target.closest(".np-close");
    if (npCloseBtn) {
        const item = npCloseBtn.closest(".np-item");
        if (item) {
            const ename = item.dataset.ename;
            await endEffectRobust(ename);
            removeActiveRecordByName(ename);
            if (NP_SELECTED === ename) NP_SELECTED = null;
            app.renderNowPlaying?.();
        }
        return;
    }

    if (!btn || !wc.contains(btn)) return;
    const a = btn.dataset.action;

    if (a === "overview") { app.mode = "overview"; app.activeCategoryKey = null; app.render(false); }
    else if (a === "toggle-category-dropdown") { btn.closest('.category-dropdown').querySelector('.dropdown-menu').classList.toggle('show'); }
    else if (a === "category") {
      app.mode = "category"; app.activeCategoryKey = btn.dataset.key;
      const menu = btn.closest('.dropdown-menu');
      if (menu) menu.classList.remove('show');
      app.render(false);
    }
    else if (a === "favorites") { app.mode = "favorites"; app.render(false); }
    else if (a === "presets") { app.mode = "presets"; app.render(false); }
    else if (a === "clear") { await clearSequencerEffects(); app.renderNowPlaying?.(); }
    else if (a === "filter-media") {
      const cur = app.mediaFilterMode || "all";
      const next = cur === "all" ? "img" : (cur === "img" ? "vid" : "all");
      app.mediaFilterMode = next;
      app.render(false);
    }
    else if (a === "add-file-current") { await handleAddFileToCategory(app); }
    else if (a === "open-cat-config") { if (game.user?.isGM) new CategoriesConfigForm().render(true); }
    else if (a === "toggle-now-playing") { app.isNowPlayingExpanded = !app.isNowPlayingExpanded; app.render(false); }
  }, true);

  wc.addEventListener("input", (ev) => {
    const t = ev.target;
    if (t?.name === "search") {
      app.searchQuery = t.value ?? "";
      // BUG FIX: Only re-render the main panel, not the whole app, to keep focus.
      renderMainPanel(app, rootEl);
    }
  }, true);
  
  // Now playing dblclick handler for selection
  wc.addEventListener("dblclick", (ev) => {
    const item = ev.target.closest(".np-item");
    if (item) {
        const ename = item.dataset.ename;
        NP_SELECTED = (NP_SELECTED === ename) ? null : ename;
        app.renderNowPlaying?.();
    }
  });

  wc._delegated = true;
}
function attachGlobalAddFileHandler(app, rootEl) { /* No changes needed */ }

/* ============== Virtual Grid ============== */
function mountVirtualGrid(app, scrollRoot, grid) {
  if (!grid) return;
  const files = app.filteredFiles();
  grid.innerHTML = "";
  app._virtual.files = files; app._virtual.next = 0;
  if (app._virtual.observer) { app._virtual.observer.disconnect(); app._virtual.observer = null; }

  if(!files.length){
      grid.innerHTML = `<div class="empty-placeholder">No matching files found.</div>`;
      return;
  }

  const sentinel = document.createElement("div"); sentinel.className = "grid-sentinel";
  grid.appendChild(sentinel);
  const appendChunk = () => {
    const start = app._virtual.next; const end = Math.min(start + app._virtual.chunkSize, app._virtual.files.length);
    for (let i = start; i < end; i++) grid.insertBefore(createGridItem(app._virtual.files[i]), sentinel);
    app._virtual.next = end;
    eagerLoadMediaIn(grid);
    observeVideoPreviews(grid, { root: scrollRoot });
    if (end >= app._virtual.files.length && app._virtual.observer) { app._virtual.observer.disconnect(); app._virtual.observer = null; sentinel.remove(); }
  };
  appendChunk();
  if (app._virtual.next < app._virtual.files.length) {
    const io = new IntersectionObserver((ents) => { for (const e of ents) if (e.isIntersecting) appendChunk(); }, { root: scrollRoot, rootMargin: "300px 0px", threshold: 0 });
    io.observe(sentinel); app._virtual.observer = io;
  }
}

/* ============== Now Playing ============== */
function renderNowPlayingGrid(app, rootEl) {
  const wc = getWC(rootEl); if (!wc) return;
  const npBody = wc.querySelector(".np-body");
  if(!npBody) return;

  if (NP_SELECTED && !ACTIVE_EFFECTS.some(r => r.name === NP_SELECTED)) NP_SELECTED = null;

  const items = ACTIVE_EFFECTS.slice();
  if (!items.length) { npBody.innerHTML = `<div class="empty-placeholder">No effects are currently playing</div>`; return; }

  let html = `<div class="np-grid">`;
  for (let i=0;i<items.length;i++) {
    const r = items[i]; const selected = (NP_SELECTED === r.name);
    const media = isVideo(r.path)
      ? `<video class="np-thumb" muted preload="metadata" playsinline data-src="${escapeAttr(r.path)}"></video>`
      : `<img class="np-thumb-img" data-src="${escapeAttr(r.path)}" />`;
    html += `<div class="np-item ${selected ? 'selected' : ''}" draggable="true" data-index="${i}" data-ename="${escapeAttr(r.name)}" data-path="${escapeAttr(r.path)}">
      <button class="np-close" title="Stop"><i class="fas fa-times"></i></button>
      ${media}
      <div class="np-label" title="${escapeAttr(r.path)}">${escapeHtml(displayNameFor(r.path))}</div>
    </div>`;
  }
  html += `</div>`;
  npBody.innerHTML = html;
  
  if (!npBody._dragDelegated) {
    let dragInfo = null;
    npBody.addEventListener("dragstart", (ev) => {
      const item = ev.target.closest(".np-item"); if (!item) return;
      dragInfo = { from: parseInt(item.dataset.index) };
      setTimeout(() => item.classList.add("dragging"), 0);
      try { ev.dataTransfer.effectAllowed = "move"; } catch {}
    });
    npBody.addEventListener("dragend", (e) => {
      e.target.closest('.np-item')?.classList.remove("dragging");
      dragInfo = null;
    });
    npBody.addEventListener("dragover", (ev) => {
      if (dragInfo == null) return;
      ev.preventDefault();
      try { ev.dataTransfer.dropEffect = "move"; } catch {}
    });
    npBody.addEventListener("drop", async (ev) => {
      const item = ev.target.closest(".np-item"); if (!item || dragInfo == null) return;
      ev.preventDefault();
      const to = parseInt(item.dataset.index); const from = dragInfo.from;
      if (isNaN(from) || isNaN(to) || from === to) return;
      const arr = ACTIVE_EFFECTS.slice(); const [moved] = arr.splice(from, 1); arr.splice(to, 0, moved); ACTIVE_EFFECTS = arr;
      await replayActiveEffectsInCurrentOrder({ instant: true }); NP_SELECTED = null; app.renderNowPlaying();
    });
    npBody._dragDelegated = true;
  }

  eagerLoadMediaIn(npBody);
  observeVideoPreviews(npBody, { root: npBody });
}

/* ============== Replay After Drag-and-Drop Sorting ============== */
async function replayActiveEffectsInCurrentOrder({ instant = true } = {}) {
  if (!ACTIVE_EFFECTS.length) return;
  const list = ACTIVE_EFFECTS.slice();
  const mode = game.settings.get(MODULE_ID, "orderMode") || "asc";
  const zs = list.map((_, i) => mode === "asc" ? (Z_BASE + i) : (Z_BASE + Z_RANGE - i));
  for (const r of list) { try { await endEffectRobust(r.name); } catch {} }
  const newRecords = [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    const newRec = await playFullscreen(r.path, {
      effectName: r.tag || EFFECT_TAG,
      skipGlobalClear: true,
      explicitZ: zs[i],
      explicitName: `${r.tag || EFFECT_TAG}:${rid(16)}`,
      registerActive: false,
      fadeInOverride: instant ? 0 : undefined,
      fadeOutOverride: instant ? 0 : undefined
    });
    if (newRec) newRecords.push(newRec);
  }
  ACTIVE_EFFECTS = newRecords;
  try { (WebMViewerApp?.instance ?? window.sequencerWebmOrbViewer)?.renderNowPlaying?.(); } catch {}
}

/* ============== Presenter Grid Item ============== */
function createGridItem(f) {
  const isVid = isVideo(f.path);
  const d = document.createElement("div");
  d.className = "webm-item"; d.dataset.path = f.path; d.dataset.source = f.source || "data"; d.dataset.catKey = f.categoryKey || "";
  
  const media = isVid
    ? `<video class="preview" muted preload="metadata" playsinline data-src="${escapeAttr(f.path)}"></video>`
    : `<img class="preview-img" data-src="${escapeAttr(f.path)}" />`;
  d.innerHTML = `
    <div class="thumb">${media}</div>
    <div class="title-bar">
        <div class="name" title="${escapeAttr(f.path)}">${escapeHtml(displayNameFor(f.path))}</div>
    </div>
    <div class="corner-actions">
        <button class="corner add-fav" title="Add to Favorites"><i class="fas fa-star"></i></button>
        <button class="corner delete" title="Remove/Hide File"><i class="fas fa-ban"></i></button>
    </div>`;
  return d;
}

/* ============== Favorites Dialog ============== */
function openFavDialog(filePath) {
  const favorites = getFavorites();
  const listNames = Object.keys(favorites);
  let content = `<div class="fvtt-dialog"><p>Select a favorite:</p><div class="fav-list">`;
  for (const name of listNames) content += `<label style="display:block;margin:4px 0;"><input type="radio" name="favTarget" value="${escapeAttr(name)}"> ${escapeHtml(name)}</label>`;
  content += `</div><hr/><div style="display:flex;gap:8px;align-items:center;"><input type="text" name="newFavName" placeholder="New Favorite Name" style="flex:1;"></div></div>`;
  new Dialog({
    title: "Add to Favorites",
    content,
    buttons: {
      ok: { label: "Confirm", icon: '<i class="fas fa-star"></i>', callback: async (html) => {
        const sel = html[0].querySelector('input[name="favTarget"]:checked')?.value;
        let newName = html[0].querySelector('input[name="newFavName"]')?.value?.trim();
        let target = sel || newName;
        if (!target) return ui.notifications?.warn("Please select a favorite or enter a new name.");
        await addToFavorite(target, filePath);
        ui.notifications?.info(`Added to favorite: ${target}`);
      }},
      cancel: { label: "Cancel" }
    }
  }).render(true);
}

/* ============== Preset Activation ============== */
// Add a global lock to prevent concurrent execution
let PRESET_PLAYER_BUSY = false;

async function activatePresetById(folder, id) {
  // If the lock is active, a preset is already playing, so warn and return
  if (PRESET_PLAYER_BUSY) {
    ui.notifications?.warn("A preset is currently playing, please wait.");
    return;
  }
  // Activate the lock
  PRESET_PLAYER_BUSY = true;

  try {
    const ps = getPresets();
    const list = ps[folder] || [];
    const p = list.find(x => x.id === id);
    if (!p) {
      ui.notifications?.warn("Preset not found.");
      return; // Return directly, the finally block will ensure the lock is released
    }
    const items = (p.items || []).map(it => it.path).filter(Boolean);
    if (!items.length) {
      ui.notifications?.warn("Preset is empty.");
      return; // Return directly, the finally block will ensure the lock is released
    }

    await clearSequencerEffects();
    for (const path of items) {
      await playFullscreen(path, { skipGlobalClear: true });
    }
    CURRENT_PRESET_TAG = folder + ":" + id;
    (WebMViewerApp?.instance ?? window.sequencerWebmOrbViewer)?.renderNowPlaying?.();
  } catch (e) {
      // Add error handling for robustness
      console.error(`[${MODULE_ID}] An error occurred while playing a preset:`, e);
      ui.notifications?.error("An error occurred while playing the preset, please check the console.");
  } finally {
    // The lock must be released, whether successful or not
    PRESET_PLAYER_BUSY = false;
  }
}

/* ============== Categories: Add/Remove Files ============== */
async function addFileToCategory(catKey, filePath) {
  const cats = foundry.utils.duplicate(getCategoriesObject());
  const c = cats[catKey] ?? (cats[catKey] = { name: catKey, folder: "", source: "data", extraFiles: [], hiddenFiles: [] });
  if (!Array.isArray(c.extraFiles)) c.extraFiles = [];

  const baseNew = stripQuery(filePath);
  const already = (c.extraFiles || []).some(p => stripQuery(p) === baseNew);
  if (!already) c.extraFiles.push(filePath);

  await game.settings.set(MODULE_ID, "categories", cats);
}
async function removeFromCategoryOrHide(catKey, filePath) {
  const cats = foundry.utils.duplicate(getCategoriesObject());
  const c = cats[catKey] ?? (cats[catKey] = { name: catKey, folder: "", source: "data", extraFiles: [], hiddenFiles: [] });
  if (!Array.isArray(c.extraFiles)) c.extraFiles = [];
  if (!Array.isArray(c.hiddenFiles)) c.hiddenFiles = [];

  const base = stripQuery(filePath);
  let changed = false;

  const before = c.extraFiles.length;
  c.extraFiles = c.extraFiles.filter(p => stripQuery(p) !== base);
  if (c.extraFiles.length !== before) changed = true;

  const ensurePush = (val) => {
    if (!c.hiddenFiles.includes(val)) { c.hiddenFiles.push(val); changed = true; }
  };
  ensurePush(filePath);
  ensurePush(base);

  if (changed) {
    await game.settings.set(MODULE_ID, "categories", cats);
  }
  return changed;
}
