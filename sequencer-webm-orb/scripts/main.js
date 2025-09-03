const MODULE_ID = "sequencer-webm-orb";

// 媒体格式
const IMAGE_RE = /\.(png|apng|jpe?g|gif|webp|avif|svg)$/i;
const VIDEO_RE = /\.(webm|mp4|m4v|ogv|mov|mkv)$/i;
const MEDIA_RE = /\.(png|apng|jpe?g|gif|webp|avif|svg|webm|mp4|m4v|ogv|mov|mkv)$/i;

const EFFECT_TAG = `${MODULE_ID}-effect`;
const MAX_CATEGORIES = 30;

// 记录
let PLAY_LOG = [];          // { path, ts }
let LAST_CLEAR_AT = 0;
let CURRENT_PRESET_TAG = null;

// 缓存
const FOLDER_LIST_CACHE = new Map();
const MEDIA_SIZE_CACHE = new Map();   // path -> {w,h}

// 预览视频并发限制（仅为可见项挂载 src）
const PREVIEW_ACTIVE_SET = new Set();
const PREVIEW_DEFAULT_MAX_ACTIVE = 24;
function getPreviewMaxActive() {
  const v = Number(game.settings?.get?.(MODULE_ID, "previewMaxActive"));
  return Number.isFinite(v) && v > 0 ? v : PREVIEW_DEFAULT_MAX_ACTIVE;
}

// 层级
let ORDER_COUNTER = 0;
const Z_BASE = 10000;
const Z_RANGE = 1000000;

// Now Playing（本模块启动的活动动画）
let ACTIVE_EFFECTS = []; // { id, name, path, tag, z }
let NP_SELECTED = null;

// FilePicker 取用（兼容 v9-v13+）
function FP() {
  return (
    foundry?.applications?.api?.FilePicker ??           // V2
    foundry?.applications?.apps?.FilePicker?.implementation ?? // v13 兼容
    window.FilePicker                                   // V1
  );
}

/* ============== 工具 ============== */
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
function createFavorite(name) { const fav = getFavorites(); if (!fav[name]) fav[name] = []; return setFavorites(fav); }
function renameFavorite(oldName, newName) { const fav = getFavorites(); if (!fav[oldName]) return; if (fav[newName]) return ui.notifications?.warn("A favorite with the same name already exists."); fav[newName] = fav[oldName]; delete fav[oldName]; return setFavorites(fav); }
function deleteFavorite(name) { const fav = getFavorites(); delete fav[name]; return setFavorites(fav); }
function addToFavorite(name, path) { const fav = getFavorites(); if (!fav[name]) fav[name] = []; if (!fav[name].includes(path)) fav[name].push(path); return setFavorites(fav); }
function removeFromFavorite(name, path) { const fav = getFavorites(); if (!fav[name]) return; fav[name] = fav[name].filter(p => p !== path); return setFavorites(fav); }

// 忽略 ?query/#hash 再判断扩展名（为 S3 预签名 URL 兜底）
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

// 文件别名（备注）
function getAliases() { return foundry.utils.duplicate(game.settings.get(MODULE_ID, "aliases") || {}); }
async function setAliases(obj) { await game.settings.set(MODULE_ID, "aliases", obj); }
function getFileAlias(path) { const a = getAliases(); return a[stripQuery(path)] || null; }
async function setFileAlias(path, alias) {
  const a = getAliases(); const key = stripQuery(path);
  if (alias && alias.trim()) a[key] = alias.trim();
  else delete a[key];
  await setAliases(a);
}

function displayNameFor(path) {
  return getFileAlias(path) || stripQuery(path).split("/").pop();
}

// 预览底图颜色设置
function getPreviewBgColor() {
  const key = game.settings?.get?.(MODULE_ID, "previewBg") || "pale-yellow";
  const map = {
    white: "#ffffff",
    black: "#000000",
    "pale-yellow": "#fff3d1",
    "light-brown": "#f4e2c3",
    "deep-brown": "#6b4f3b",
    "mustard": "#f3d36b",
    "gray": "#bdbdbd"
  };
  return map[key] || "#fff3d1";
}

function escapeHtml(s = "") { return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m])); }
function escapeAttr(s = "") { return escapeHtml(s); }
function rid(n=16) { return foundry?.utils?.randomID?.(n) ?? `${Date.now().toString(36)}-${Math.floor(Math.random()*1e9).toString(36)}`; }

/* Sequencer 不同版本容错 */
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
        ok: { label: "OK", callback: (html) => { const v = html[0].querySelector("input[name='str']")?.value?.trim(); resolve(v || null); } },
        cancel: { label: "Cancel", callback: () => resolve(null) }
      },
      default: "ok"
    }).render(true);
  });
}

/* ============== FilePicker 统一路径选择（允许在面板中上传，然后点击文件得到路径） ============== */
async function pickMediaPathViaFilePicker({ source = "data", current = "", allowUpload = false } = {}) {
  const FPClass = FP();
  if (!FPClass) { ui.notifications?.warn("FilePicker is not available."); return null; }
  return new Promise((resolve) => {
    let done = false;
    const finish = (p) => { if (done) return; done = true; cleanup(); resolve(p || null); try { picker?.close?.(); } catch {} };
    const cleanup = () => {
      document.removeEventListener("click", handler, true);
      document.removeEventListener("dblclick", handler, true);
    };
    const opts = { type: "imagevideo", activeSource: source, current, upload: !!allowUpload, callback: (p) => finish(p) };
    let picker = null;
    try { picker = new FPClass(opts); }
    catch { try { picker = new window.FilePicker(opts); } catch {} }
    picker?.render?.(true);

    // 监听 FilePicker 内部对文件项的点击/双击，直接取 data-path
    const handler = (ev) => {
      const win = ev.target.closest('.filepicker, .window-app.filepicker, .app.filepicker, [data-application="FilePicker"]');
      if (!win) return;
      const node = ev.target.closest('[data-path], li.file, .file');
      let p = null;
      if (node) p = node.dataset?.path || node.getAttribute?.("data-path") || null;
      if (!p) {
        const ti = win.querySelector?.('input[name="target"]');
        if (ti && ti.value) p = ti.value;
      }
      if (p && hasMediaExt(p)) {
        ev.preventDefault();
        finish(p);
      }
    };
    document.addEventListener("click", handler, true);
    document.addEventListener("dblclick", handler, true);
  });
}

/* ============== 浏览与索引（静态 FilePicker.browse，兼容 S3） ============== */
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

/* ============== 媒体原始尺寸（用于cover计算） ============== */
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

/* ============== 分类配置界面（FormApplication） ============== */
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
    title.textContent = "Category Mappings (Max 30)"; title.style.fontWeight = "600";
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
      const uploadBtn = document.createElement("button"); uploadBtn.innerHTML = `<i class="fas fa-plus"></i> Add File`; // Text: "Add File"
      const delBtn = document.createElement("button"); delBtn.innerHTML = `<i class="fas fa-trash"></i>`; delBtn.title = "Delete this category";

      el.appendChild(label); el.appendChild(nameInput); el.appendChild(srcSel); el.appendChild(folderInput); el.appendChild(browseBtn); el.appendChild(uploadBtn); el.appendChild(delBtn);

      // 浏览文件夹
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

      // “添加”：打开选择器（允许上传），点击任何媒体 => 路径加入该分类白名单
      uploadBtn.addEventListener("click", async () => {
        const chosen = await pickMediaPathViaFilePicker({
          source: srcSel.value || "data",
          current: folderInput.value || "",
          allowUpload: true
        });
        if (!chosen) return;
        await addFileToCategory(key, chosen);
        ui.notifications?.info(`Added to whitelist: ${chosen}`);
        try { WebMViewerApp?.instance?.refreshIndex?.(false); } catch {}
      });

      // 删除分类行（仅界面移除，保存后生效）
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

/* ============== Sequencer 相关 ============== */
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
      ui.notifications?.info("Cleared all effects from this module.");
      return;
    }
    if (Sequencer?.EffectManager?.endAllEffects) await Sequencer.EffectManager.endAllEffects();
    LAST_CLEAR_AT = Date.now(); ORDER_COUNTER = 0; CURRENT_PRESET_TAG = null;
    ui.notifications?.info("Cleared all Sequencer effects.");
  } catch (e2) {
    console.error(e2);
    ui.notifications?.warn("Could not clear effects, please check the console.");
  }
}

// 从 core 读取“环境”音量
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

// 全屏覆盖播放（cover 计算；视频允许音轨，按环境通道音量缩放）
async function playFullscreen(path, {
  effectName = EFFECT_TAG,
  skipGlobalClear = false,
  explicitZ = null,
  explicitName = null,
  registerActive = true,
  fadeInOverride = undefined,
  fadeOutOverride = undefined
} = {}) {
  const opts = game.settings.get(MODULE_ID, "playOptions") || {};
  const fadeInMs = (fadeInOverride !== undefined ? fadeInOverride : (opts.fadeIn ?? 250));
  const fadeOutMs = (fadeOutOverride !== undefined ? fadeOutOverride : (opts.fadeOut ?? 400));

  if (opts.clearBeforePlay && !skipGlobalClear) await clearSequencerEffects();

  const hasCanvas = !!canvas?.scene && !!canvas?.dimensions;
  if (!hasCanvas || typeof Sequence !== "function") {
    ui.notifications?.error("No scene is currently loaded or Sequencer is not available.");
    return;
  }

  let zIndex;
  const orderMode = game.settings.get(MODULE_ID, "orderMode") || "asc";
  if (explicitZ === null || explicitZ === undefined) {
    zIndex = orderMode === "asc" ? (Z_BASE + (ORDER_COUNTER++)) : (Z_BASE + Z_RANGE - (ORDER_COUNTER++));
  } else zIndex = explicitZ;

  const rec = { id: rid(16), path, tag: effectName, z: zIndex };
  rec.name = explicitName || `${effectName}:${rec.id}`;

  const seq = new Sequence();
  let e = seq.effect().file(path).name(rec.name).persist(true);
  e = chainCall(e, "loop", true);
  e = chainCall(e, "fadeIn", fadeInMs);
  e = chainCall(e, "fadeOut", fadeOutMs);

  try {
    if (isVideo(path)) {
      const vol = getEnvironmentVolume();
      e = chainCall(e, "noAudio", false);
      e = chainCall(e, "volume", vol);
    }
  } catch {}

  let placed = false;
  if (typeof e.fullscreen === "function") { try { e = e.fullscreen(true); placed = true; } catch {} }
  if (!placed && typeof e.screenSpace === "function") { try { e = e.screenSpace(true); placed = true; } catch {} }
  const center = canvas?.dimensions?.center;
  if (center && typeof e.atLocation === "function") { try { e = e.atLocation(center); placed = true; } catch {} }

  // cover 尺寸（尽量匹配视窗）
  try {
    const { w, h } = await getMediaSize(path);
    const VW = window.innerWidth, VH = window.innerHeight;
    if (w > 0 && h > 0) {
      const arMedia = w / h, arView = VW / VH;
      let outW, outH;
      if (arMedia < arView) { outW = VW; outH = Math.ceil(VW / arMedia); }
      else { outH = VH; outW = Math.ceil(VH * arMedia); }
      if (typeof e.size === "function") e = e.size({ width: outW, height: outH });
    }
  } catch {}

  e = chainCall(e, "anchor", { x: .5, y: .5 });
  e = chainCall(e, "zIndex", zIndex);

  if (!placed) { ui.notifications?.error("Could not determine playback position. Please ensure Sequencer supports fullscreen/screenSpace."); return; }

  try {
    await seq.play();
    if (registerActive) ACTIVE_EFFECTS.push(rec);
    try { (WebMViewerApp?.instance ?? window.sequencerWebmOrbViewer)?.renderNowPlaying?.(); } catch {}
    PLAY_LOG.push({ path, ts: Date.now() });
    return rec;
  } catch (e) {
    console.error("Sequencer playback failed", e);
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

/* ============== 预设：工具函数 ============== */
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

/* ============== 预设保存 ============== */
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
  if (!items.length) return ui.notifications?.warn("No effects to save: Please play some effects first.");
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

/* ============== 应用（保持单列紧凑 UI） ============== */
let WebMViewerApp;

Hooks.once("init", () => {
  class _ViewerV1 extends Application {
    static _instance = null;
    static get defaultOptions() {
      return foundry.utils.mergeObject(super.defaultOptions, {
        id: `${MODULE_ID}-viewer`,
        title: "Fullscreen Media Player",
        template: `modules/${MODULE_ID}/templates/viewer.hbs`,
        width: 980, height: 700, resizable: true
      });
    }
    static get instance() { return this._instance; }
    static show() { if (!game.user.isGM) return ui.notifications?.warn("Only GMs can use the player."); if (!this._instance) { this._instance = new _ViewerV1(); window.sequencerWebmOrbViewer = this._instance; } this._instance.render(true); }
    constructor(...a) {
      super(...a);
      this.mode = "overview";        // overview | category | favorites | presets
      this.activeCategoryKey = null;
      this.mediaFilterMode = "all";   // all | img | vid
      this.searchQuery = "";
      this.index = [];
      this.loading = false;
      this.activeFav = null;
      this.activeFolder = null;
      this._lastRightClick = { ts: 0, path: null };
      this._rctxSuppressUntil = 0;
      this._virtual = { chunkSize: 72, next: 0, files: [], observer: null };
    }
    getData() {
      const cats = getCategoriesArray().map(c => ({ ...c, isActive: this.mode === "category" && this.activeCategoryKey === c.key }));
      const files = this.filteredFiles();
      return {
        categories: cats,
        isOverview: this.mode === "overview",
        isFavorites: this.mode === "favorites",
        isPresets: this.mode === "presets",
        hasFiles: files.length > 0,
        loading: this.loading,
        searchQuery: this.searchQuery,
        filterLabel: this.mediaFilterMode === "all" ? "All" : this.mediaFilterMode === "img" ? "Images" : "Videos"
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
      attachViewerEvents(this, this.element[0]);  // 全窗委托
      enhanceToolbarLayout(this, this.element[0].querySelector(".toolbar"));
      makeTopStickyLayout(this, this.element[0]); // 顶部固定 + 中间滚动
      renderMainPanel(this, this.element[0]);     // 主面板（滚动）
      renderNowPlayingGrid(this, this.element[0]); // 正在播放（固定）
      attachGlobalAddFileHandler(this, this.element[0]); // 兜底：按钮点击
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
    renderNowPlaying() { renderNowPlayingGrid(this, this.element[0]); }
  }

  WebMViewerApp = _ViewerV1;
  registerSettings();
});

/* 让“显示名”统一为白色（兜底样式） */
Hooks.once("init", () => {
  const styleId = `${MODULE_ID}-inline-style`;
  if (!document.getElementById(styleId)) {
    const st = document.createElement("style");
    st.id = styleId;
    st.textContent = `
      #${MODULE_ID}-viewer .label.name,
      #${MODULE_ID}-viewer .name,
      #${MODULE_ID}-viewer .np2-label {
        color: #fff !important;
      }
    `;
    document.head.appendChild(st);
  }
});

/* ============== 设置注册 ============== */
function registerSettings() {
  game.settings.register(MODULE_ID, "categories", { name: "Category Mapping", scope: "world", config: false, type: Object, default: defaultCategories() });
  game.settings.register(MODULE_ID, "presets", { name: "Presets", scope: "world", config: false, type: Object, default: {} });
  game.settings.register(MODULE_ID, "favorites", { name: "Favorites", scope: "client", config: false, type: Object, default: {} });
  game.settings.register(MODULE_ID, "aliases", { name: "File Aliases", scope: "world", config: false, type: Object, default: {} });
  game.settings.register(MODULE_ID, "orbPosition", { name: "Floating Orb Position", scope: "client", config: false, type: Object, default: { left: 20, top: 120 } });
  game.settings.register(MODULE_ID, "playOptions", { name: "Playback Options", scope: "client", config: false, type: Object, default: { clearBeforePlay: false, fadeIn: 250, fadeOut: 400 } });

  game.settings.register(MODULE_ID, "orderMode", {
    name: "Placement Order",
    hint: "Determines the stacking order: Ascending = later effects are on top; Descending = later effects are at the bottom.",
    scope: "client",
    config: true,
    type: String,
    choices: { asc: "Ascending (Newer on Top)", desc: "Descending (Newer on Bottom)" },
    default: "asc"
  });
  game.settings.register(MODULE_ID, "previewMaxActive", {
    name: "Video Preview Concurrency Limit",
    hint: "The maximum number of video thumbnails to load simultaneously. Increasing it reduces empty spaces, decreasing it improves performance.",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 8, max: 128, step: 1 },
    default: 24
  });
  game.settings.register(MODULE_ID, "hoverPreview", {
    name: "Hover to Play Video Previews",
    hint: "Plays a muted, looping preview when hovering over a video thumbnail.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "showOrb", {
    name: "Show Floating Orb (GM Only)",
    hint: "Shows/hides the floating orb shortcut for the player on the canvas.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "previewBg", {
    name: "Preview Background Color",
    hint: "The background color used for thumbnails and previews.",
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
    default: "pale-yellow",
    onChange: () => { try { WebMViewerApp?.instance?.render?.(false); } catch {} }
  });

  game.settings.register(MODULE_ID, "openCatConfig", {
    name: "Open Category Mapping Manager",
    hint: "Check to immediately open the category configuration interface (GM only).",
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
    name: "Category Mapping",
    label: "Configure Categories & Folders",
    hint: "Create/delete up to 30 categories. For each, select a source and root folder (S3 supported). Can be left empty to only use whitelisted files.",
    icon: "fas fa-folder-tree",
    type: CategoriesConfigForm,
    restricted: true
  });
}

/* ============== 悬浮球（仅 GM） ============== */
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
      transition: "opacity .2s", opacity: "0.8"
    });
    orb.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;"><i class="fas fa-film" style="font-size:18px;"></i></div>`;
    document.body.appendChild(orb);
    let dragging = false; let offset = { x: 0, y: 0 };
    orb.addEventListener("mousedown", (ev) => { if (ev.button !== 0) return; dragging = true; orb.style.opacity = "1"; offset.x = ev.clientX - orb.offsetLeft; offset.y = ev.clientY - orb.offsetTop; });
    window.addEventListener("mousemove", (ev) => { if (!dragging) return; const left = Math.max(0, Math.min(window.innerWidth - orb.offsetWidth, ev.clientX - offset.x)); const top = Math.max(0, Math.min(window.innerHeight - orb.offsetHeight, ev.clientY - offset.y)); orb.style.left = `${left}px`; orb.style.top = `${top}px`; });
    window.addEventListener("mouseup", async () => { if (!dragging) return; dragging = false; orb.style.opacity = "0.8"; await game.settings.set(MODULE_ID, "orbPosition", { left: parseInt(orb.style.left), top: parseInt(orb.style.top) }); });
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

/* ============== 预加载（仅真正的图片） ============== */
const EAGER_QUEUE = []; let EAGER_SCHEDULED = false;
function eagerLoadMediaIn(rootEl) {
  if (!rootEl) return;
  const nodes = rootEl.querySelectorAll(
    "img.preview-img:not([data-eager]), img.layer-preview-img:not([data-eager]), img.np2-thumb-img:not([data-eager])"
  );
  for (const el of nodes) {
    const src = el.dataset.src || "";
    if (!src) continue;
    if (el.dataset.eager === "1") continue;
    el.dataset.eager = "1";
    try { el.src = src; } catch {}
  }
}

/* ============== 预览视频：仅为可见项挂载 src（不播放） + 悬停播放 ============== */
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
    const v = ev.target.closest("video.preview, video.layer-preview, video.np2-thumb");
    if (!v || !container.contains(v)) return;
    try { v.muted = true; v.loop = true; v.play().catch(()=>{}); } catch {}
  });
  container.addEventListener("mouseout", (ev) => {
    const v = ev.target.closest("video.preview, video.layer-preview, video.np2-thumb");
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
  const vids = container.querySelectorAll("video.preview, video.layer-preview, video.np2-thumb");
  vids.forEach(v => io.observe(v));
  enableHoverPlayback(container);
}

/* ============== 工具栏增强（紧凑同排） ============== */
function styleSmallButton(btn) {
  if (!btn) return;
  btn.style.padding = "2px 6px";
  btn.style.height = "24px";
  btn.style.minWidth = "auto";
  btn.style.width = "auto";
  btn.style.flex = "0 0 auto";
  btn.style.display = "inline-flex";
  btn.style.alignItems = "center";
  btn.style.gap = "4px";
  btn.style.whiteSpace = "nowrap";
}
function updateFilterButtonVisual(app, btn) {
  if (!btn) return;
  let lbl = btn.querySelector(".lbl");
  if (!lbl) { lbl = document.createElement("span"); lbl.className = "lbl"; btn.appendChild(lbl); }
  let icon = btn.querySelector("i");
  if (!icon) { icon = document.createElement("i"); btn.prepend(icon); }
  const mode = app.mediaFilterMode || "all";
  if (mode === "all") { lbl.textContent = "All"; icon.className = "fas fa-filter"; }
  else if (mode === "img") { lbl.textContent = "Images"; icon.className = "fas fa-image"; }
  else { lbl.textContent = "Videos"; icon.className = "fas fa-film"; }
}
function ensureSlimGroup(toolbar) {
  let g = toolbar.querySelector(".orb-slim-group");
  if (!g) {
    g = document.createElement("div");
    g.className = "orb-slim-group";
    g.style.display = "inline-flex";
    g.style.gap = "6px";
    g.style.flex = "0 0 auto";
    g.style.whiteSpace = "nowrap";
    toolbar.appendChild(g);
  }
  return g;
}
function enhanceToolbarLayout(app, toolbar) {
  if (!toolbar) return;
  toolbar.style.display = "flex";
  toolbar.style.flexWrap = "wrap";
  toolbar.style.gap = "6px";
  toolbar.style.alignItems = "center";

  const ovBtn = toolbar.querySelector("button[data-action='overview']");
  if (ovBtn) { toolbar.prepend(ovBtn); styleSmallButton(ovBtn); }
  toolbar.querySelectorAll("button[data-action='category']").forEach(styleSmallButton);

  let favBtn = toolbar.querySelector("button[data-action='favorites']");
  let preBtn = toolbar.querySelector("button[data-action='presets']");
  let filterBtn = toolbar.querySelector("button[data-action='filter-media']");
  let catCfgBtn = toolbar.querySelector("button[data-action='open-cat-config']");
  if (!favBtn) { favBtn = document.createElement("button"); favBtn.dataset.action = "favorites"; favBtn.innerHTML = `<i class="fas fa-star"></i><span>Favorites</span>`; }
  if (!preBtn) { preBtn = document.createElement("button"); preBtn.dataset.action = "presets"; preBtn.innerHTML = `<i class="fas fa-layer-group"></i><span>Presets</span>`; }
  if (!filterBtn) { filterBtn = document.createElement("button"); filterBtn.dataset.action = "filter-media"; filterBtn.innerHTML = `<i class="fas fa-filter"></i><span class="lbl"></span>`; }
  if (!catCfgBtn) { catCfgBtn = document.createElement("button"); catCfgBtn.dataset.action = "open-cat-config"; catCfgBtn.innerHTML = `<i class="fas fa-folder-tree"></i><span>Category Settings</span>`; }

  [favBtn, preBtn, filterBtn, catCfgBtn].forEach(styleSmallButton);
  updateFilterButtonVisual(app, filterBtn);

  const group = ensureSlimGroup(toolbar);
  [favBtn, preBtn, filterBtn, catCfgBtn].forEach(b => { if (b.parentElement !== group) group.appendChild(b); });

  toolbar.querySelectorAll("button").forEach(styleSmallButton);
}

/* ============== 顶部固定 + 中间滚动布局 ============== */
function makeTopStickyLayout(app, rootEl) {
  const wc = getWC(rootEl); if (!wc) return;
  wc.style.display = "flex";
  wc.style.flexDirection = "column";
  wc.style.height = "100%";
  wc.style.overflow = "hidden";
  const toolbar = rootEl.querySelector(".toolbar");
  if (toolbar) {
    toolbar.style.flex = "0 0 auto";
    toolbar.style.position = "relative";
    toolbar.style.zIndex = "1";
  }
}
function getWC(rootEl) { return rootEl?.querySelector?.(".window-content") || null; }
function ensureHost(wc) {
  let host = wc.querySelector(`#${MODULE_ID}-host`);
  if (!host) {
    host = document.createElement("div");
    host.id = `${MODULE_ID}-host`;
    host.style.display = "block";
    host.style.marginTop = "6px";
    host.style.flex = "1 1 auto";
    host.style.overflow = "auto";
    wc.appendChild(host);
    host.innerHTML = `
      <div class="grid" style="display:none;"></div>
      <div id="orb-fav-panel" style="display:none;"></div>
      <div id="orb-pre-panel" style="display:none;"></div>
    `;
  }
  return host;
}

/* ============== 主面板渲染（滚动在 host 内） ============== */
function renderMainPanel(app, rootEl) {
  const wc = getWC(rootEl); if (!wc) return;
  const host = ensureHost(wc);
  const gridHost = host.querySelector(".grid");
  const favPanel = host.querySelector("#orb-fav-panel");
  const prePanel = host.querySelector("#orb-pre-panel");

  gridHost.style.display = "none";
  favPanel.style.display = "none";
  prePanel.style.display = "none";

  if (app.mode === "favorites") {
    favPanel.innerHTML = buildFavoritesPanelHTML(app);
    favPanel.style.display = "";
    attachFavoritesInline(app, favPanel);
    eagerLoadMediaIn(favPanel);
    observeVideoPreviews(favPanel, { root: host });
    bindPlayDelegates(app, favPanel);
    bindCornerDelegates(app, favPanel);
  } else if (app.mode === "presets") {
    prePanel.innerHTML = buildPresetsPanelHTML(app);
    prePanel.style.display = "";
    attachPresetsInline(app, prePanel);
    eagerLoadMediaIn(prePanel);
    observeVideoPreviews(prePanel, { root: host });
    bindCornerDelegates(app, prePanel);
  } else {
    gridHost.style.display = "";
    mountVirtualGrid(app, host, gridHost);
    eagerLoadMediaIn(gridHost);
    observeVideoPreviews(gridHost, { root: host });
    bindPlayDelegates(app, gridHost);
    bindCornerDelegates(app, gridHost);
  }
}

/* ============== Favorites 面板 ============== */
function buildFavoritesPanelHTML(app) {
  const favs = getFavorites();
  const names = Object.keys(favs).sort((a, b) => a.localeCompare(b, "en-US"));
  if (!app.activeFav && names.length) app.activeFav = names[0];
  const files = (favs[app.activeFav] || []);
  const sidebar = `
    <div class="sidebar" style="width:200px;flex:0 0 auto;border-right:1px solid #6666;padding-right:8px;">
      <div style="display:flex;gap:6px;margin-bottom:6px;">
        <button data-action="fav-create" title="New" style="flex:1;"><i class="fas fa-plus"></i></button>
        <button data-action="fav-rename" title="Rename" style="flex:1;"><i class="fas fa-i-cursor"></i></button>
        <button data-action="fav-delete" title="Delete" style="flex:1;"><i class="fas fa-trash"></i></button>
      </div>
      <ul class="fav-folders" style="list-style:none;padding:0;margin:0;max-height:240px;overflow:auto;">
        ${names.map(n => `<li class="fav-item ${n===app.activeFav?'active':''}" data-name="${escapeAttr(n)}" style="padding:6px 8px;cursor:pointer;border-radius:4px;${n===app.activeFav?'background:#4aa3ff33;':''}">${escapeHtml(n)} (${(favs[n]||[]).length})</li>`).join("")}
      </ul>
    </div>`;
  const body = `
    <div class="fav-grid" style="flex:1 1 auto;padding-left:8px;">
      <div class="grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;">
        ${files.map(p => buildFavTileHTML(p)).join("") || `<div style="opacity:.6;">(Empty)</div>`}
      </div>
    </div>`;
  return `<div class="orb-panel" style="display:flex;gap:8px;padding-top:6px;">${sidebar}${body}</div>`;
}
function buildFavTileHTML(path) {
  const label = displayNameFor(path);
  const media = isVideo(path)
    ? `<video class="preview" muted preload="metadata" playsinline data-src="${escapeAttr(path)}" style="width:100%;height:110px;object-fit:cover;border-radius:4px;background:${getPreviewBgColor()};"></video>`
    : `<img class="preview-img" data-src="${escapeAttr(path)}" style="width:100%;height:110px;object-fit:cover;border-radius:4px;background:${getPreviewBgColor()};" />`;
  return `<div class="fav-file" data-path="${escapeAttr(path)}" style="position:relative;border:1px solid #6666;border-radius:6px;padding:6px;">
    <div class="thumb" style="position:relative;width:100%;height:110px;overflow:hidden;border-radius:4px;">${media}<i class="fas fa-film" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);opacity:.25;pointer-events:none;"></i></div>
    <div class="label-wrap" style="display:flex;align-items:center;gap:6px;margin-top:4px;">
      <div class="label name" title="${escapeAttr(path)}" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;color:#fff;">${escapeHtml(label)}</div>
      <button data-action="rename-alias" title="Rename Display Name" style="min-width:0;width:20px;height:20px;padding:0;border:none;background:#000c;color:#fff;border-radius:4px;"><i class="fas fa-pencil-alt" style="font-size:11px;"></i></button>
    </div>
    <button class="remove" title="Remove from favorites" style="position:absolute;right:4px;top:4px;border:none;background:#000c;color:#fff;border-radius:10px;width:18px;height:18px;line-height:18px;text-align:center;cursor:pointer;"><i class="fas fa-times" style="font-size:12px;pointer-events:none;"></i></button>
  </div>`;
}
function attachFavoritesInline(app, panel) {
  if (!panel) return;
  const sb = panel.querySelector(".sidebar");
  if (sb && !sb._delegated) {
    sb.addEventListener("click", async (ev) => {
      const entry = ev.target.closest(".fav-item");
      const btn = ev.target.closest("button");
      if (entry) { app.activeFav = entry.dataset.name; panel.innerHTML = buildFavoritesPanelHTML(app); attachFavoritesInline(app, panel); eagerLoadMediaIn(panel); observeVideoPreviews(panel, { root: panel }); bindPlayDelegates(app, panel); bindCornerDelegates(app, panel); return; }
      if (!btn) return;
      const a = btn.dataset.action;
      if (a === "fav-create") { const name = await promptString("New Favorite", "Enter name"); if (!name) return; createFavorite(name); app.activeFav = name; panel.innerHTML = buildFavoritesPanelHTML(app); attachFavoritesInline(app, panel); }
      else if (a === "fav-rename") { if (!app.activeFav) return; const name = await promptString("Rename Favorite", "Enter new name", app.activeFav); if (!name) return; renameFavorite(app.activeFav, name); app.activeFav = name; panel.innerHTML = buildFavoritesPanelHTML(app); attachFavoritesInline(app, panel); }
      else if (a === "fav-delete") { if (!app.activeFav) return; const ok = await Dialog.confirm({ title: "Delete Favorite", content: `<p>Are you sure you want to delete the favorite: ${escapeHtml(app.activeFav)}?</p>` }); if (!ok) return; deleteFavorite(app.activeFav); app.activeFav = null; panel.innerHTML = buildFavoritesPanelHTML(app); attachFavoritesInline(app, panel); }
    });
    sb._delegated = true;
  }
  const grid = panel.querySelector(".fav-grid .grid");
  if (grid && !grid._delegated) {
    grid.addEventListener("click", (ev) => {
      const rm = ev.target.closest(".remove"); if (!rm) return;
      ev.stopPropagation();
      const path = rm.closest(".fav-file")?.dataset.path;
      removeFromFavorite(app.activeFav, path);
      panel.innerHTML = buildFavoritesPanelHTML(app);
      attachFavoritesInline(app, panel);
      eagerLoadMediaIn(panel);
      observeVideoPreviews(panel, { root: panel });
      bindPlayDelegates(app, panel);
      bindCornerDelegates(app, panel);
    });
    grid.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("button[data-action='rename-alias']"); if (!btn) return;
      ev.stopPropagation();
      const card = btn.closest(".fav-file"); const path = card?.dataset.path;
      const old = getFileAlias(path) || stripQuery(path).split("/").pop();
      const name = await promptString("Set Display Name", "Enter new display name (leave empty to restore original)", old);
      await setFileAlias(path, name || "");
      card.querySelector(".label.name").textContent = displayNameFor(path);
    });
    grid._delegated = true;
  }
}

/* ============== 预设面板 ============== */
function buildPresetsPanelHTML(app) {
  const ps = getPresets();
  const folders = Object.keys(ps).sort((a, b) => a.localeCompare(b, "en-US"));
  if (!app.activeFolder && folders.length) app.activeFolder = folders[0];
  const list = (ps[app.activeFolder] || []);
  const sidebar = `
    <div class="sidebar" style="width:200px;flex:0 0 auto;border-right:1px solid #6666;padding-right:8px;">
      <div style="display:flex;gap:6px;margin-bottom:6px;">
        <button data-action="pre-create-folder" title="New" style="flex:1;"><i class="fas fa-folder-plus"></i></button>
        <button data-action="pre-rename-folder" title="Rename" style="flex:1;"><i class="fas fa-i-cursor"></i></button>
        <button data-action="pre-delete-folder" title="Delete" style="flex:1;"><i class="fas fa-trash"></i></button>
      </div>
      <ul class="pre-folders" style="list-style:none;padding:0;margin:0;max-height:240px;overflow:auto;">
        ${folders.map(n => `<li class="folder-item ${n===app.activeFolder?'active':''}" data-name="${escapeAttr(n)}" style="padding:6px 8px;cursor:pointer;border-radius:4px;${n===app.activeFolder?'background:#4aa3ff33;':''}">${escapeHtml(n)} (${(ps[n]||[]).length})</li>`).join("")}
      </ul>
    </div>`;
  const tiles = (p) => {
    const layers = (p.items || []).map(it => it.path);
    return layers.map((path, idx) => {
      const media = isVideo(path)
        ? `<video class="layer-preview" muted preload="metadata" playsinline data-src="${escapeAttr(path)}" style="width:144px;height:76px;object-fit:cover;border-radius:4px;background:${getPreviewBgColor()};"></video>`
        : `<img class="layer-preview-img" data-src="${escapeAttr(path)}" style="width:144px;height:76px;object-fit:cover;border-radius:4px;background:${getPreviewBgColor()};" />`;
      return `<div class="layer-tile" data-path="${escapeAttr(path)}" title="Layer ${idx+1}" style="position:relative;width:144px;">
        ${media}
        <span style="position:absolute;left:4px;top:4px;min-width:18px;height:18px;line-height:18px;text-align:center;border-radius:3px;background:#000a;color:#fff;font-size:11px;padding:0 4px;">${idx+1}</span>
      </div>`;
    }).join("");
  };
  const body = `
    <div class="preset-body" style="flex:1 1 auto;padding-left:8px;">
      <div class="preset-list" style="display:flex;flex-direction:column;gap:8px;">
        ${list.map(p => `
          <div class="pcard preset-row" data-id="${escapeAttr(p.id)}" data-name="${escapeAttr(p.name)}"
               style="display:flex;align-items:flex-start;justify-content:space-between;border:1px solid #6666;border-radius:6px;padding:8px;gap:10px;">
            <div class="pcard-left" style="display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0;">
              <div class="pcard-title" title="${escapeAttr(p.name)}" style="font-weight:600;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(p.name)}</div>
              <div class="pcard-meta" style="opacity:.7;font-size:12px;">${new Date(p.created||0).toLocaleString()} · ${(p.items||[]).length} layers</div>
              <div class="pcard-actions" style="display:flex;gap:4px;">
                <button class="play"   title="Play"   style="min-width:0;width:22px;height:22px;padding:0;display:inline-flex;align-items:center;justify-content:center;"><i class="fas fa-play" style="font-size:12px;"></i></button>
                <button class="rename" title="Rename" style="min-width:0;width:22px;height:22px;padding:0;display:inline-flex;align-items:center;justify-content:center;"><i class="fas fa-i-cursor" style="font-size:12px;"></i></button>
                <button class="delete" title="Delete"   style="min-width:0;width:22px;height:22px;padding:0;display:inline-flex;align-items:center;justify-content:center;"><i class="fas fa-trash" style="font-size:12px;"></i></button>
              </div>
            </div>
            <div class="pcard-layers" style="display:flex;flex-wrap:wrap;gap:8px;align-content:flex-start;justify-content:flex-start;max-height:240px;overflow:auto;">
              ${tiles(p) || `<div style="opacity:.6;">(Empty)</div>`}
            </div>
          </div>
        `).join("") || `<div style="opacity:.6;">(Empty)</div>`}
      </div>
    </div>`;
  return `<div class="orb-panel" style="display:flex;gap:8px;padding-top:6px;">${sidebar}${body}</div>`;
}
function attachPresetsInline(app, panel) {
  if (!panel) return;
  const sb = panel.querySelector(".sidebar");
  if (sb && !sb._delegated) {
    sb.addEventListener("click", async (ev) => {
      const entry = ev.target.closest(".folder-item");
      const btn = ev.target.closest("button");
      if (entry) {
        const name = entry.dataset.name;
        if (getPresets()[name]) { app.activeFolder = name; panel.innerHTML = buildPresetsPanelHTML(app); attachPresetsInline(app, panel); eagerLoadMediaIn(panel); observeVideoPreviews(panel, { root: panel }); bindCornerDelegates(app, panel); }
        return;
      }
      if (!btn) return;
      const a = btn.dataset.action;
      if (a === "pre-create-folder") { const name = await promptString("New Preset Folder", "Enter name"); if (!name) return; createPresetFolder(name); app.activeFolder = name; panel.innerHTML = buildPresetsPanelHTML(app); attachPresetsInline(app, panel); }
      else if (a === "pre-rename-folder") { if (!app.activeFolder) return; const name = await promptString("Rename Preset Folder", "Enter new name", app.activeFolder); if (!name) return; renamePresetFolder(app.activeFolder, name); app.activeFolder = name; panel.innerHTML = buildPresetsPanelHTML(app); attachPresetsInline(app, panel); }
      else if (a === "pre-delete-folder") { if (!app.activeFolder) return; const ok = await Dialog.confirm({ title: "Delete Preset Folder", content: `<p>Are you sure you want to delete the folder: ${escapeHtml(app.activeFolder)} (including all presets within)?</p>` }); if (!ok) return; deletePresetFolder(app.activeFolder); app.activeFolder = null; panel.innerHTML = buildPresetsPanelHTML(app); attachPresetsInline(app, panel); }
    });
    sb._delegated = true;
  }
  const list = panel.querySelector(".preset-list");
  if (list && !list._delegated) {
    list.addEventListener("dblclick", async (ev) => {
      const row = ev.target.closest(".preset-row"); if (!row) return;
      await activatePresetById(app.activeFolder, row.dataset.id);
    });
    list.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("button"); if (!btn) return;
      const row = ev.target.closest(".preset-row"); if (!row) return;
      if (btn.classList.contains("play")) { await activatePresetById(app.activeFolder, row.dataset.id); }
      else if (btn.classList.contains("rename")) {
        const old = row.dataset.name; const name = await promptString("Rename Preset", "Enter new name", old); if (!name) return;
        await renamePreset(app.activeFolder, row.dataset.id, name);
        panel.innerHTML = buildPresetsPanelHTML(app); attachPresetsInline(app, panel);
      } else if (btn.classList.contains("delete")) {
        const ok = await Dialog.confirm({ title: "Delete Preset", content: "<p>Are you sure you want to delete this preset?</p>" }); if (!ok) return;
        await deletePreset(app.activeFolder, row.dataset.id);
        panel.innerHTML = buildPresetsPanelHTML(app); attachPresetsInline(app, panel);
      }
    });
    list._delegated = true;
  }
}

/* ============== 通用绑定：双击播放 + 右键双击清空后播放 + 别名重命名 + 屏蔽文件 ============== */
function bindPlayDelegates(app, root) {
  if (!root || root._playDelegated) return;
  const triggerPlay = async (path) => {
    if (!path) return;
    if (NP_SELECTED) await replaceActiveEffectByName(NP_SELECTED, path);
    else await playFullscreen(path);
    (WebMViewerApp?.instance ?? window.sequencerWebmOrbViewer)?.renderNowPlaying?.();
  };
  root.addEventListener("dblclick", async (ev) => {
    const item = ev.target.closest(".webm-item, .fav-file, .layer-tile");
    if (!item || !root.contains(item)) return;
    if (ev.target.closest(".corner") || ev.target.closest("button")) return;
    const now = Date.now();
    if (root._dblLock && now < root._dblLock) return;
    root._dblLock = now + 250;
    ev.stopImmediatePropagation();
    await triggerPlay(item.dataset.path);
  });
  root.addEventListener("mousedown", async (ev) => {
    if (ev.button !== 2) return;
    const item = ev.target.closest(".webm-item, .fav-file");
    if (!item || !root.contains(item)) return;
    const now = Date.now(); const path = item.dataset.path;
    const last = app._lastRightClick || { ts: 0, path: "" };
    if (now - last.ts < 400 && last.path === path) {
      ev.preventDefault(); ev.stopImmediatePropagation();
      app._rctxSuppressUntil = now + 800;
      await clearSequencerEffects(); await triggerPlay(path);
    } else app._lastRightClick = { ts: now, path };
  }, true);
  // 别名：双击标题重命名
  root.addEventListener("dblclick", async (ev) => {
    const nameEl = ev.target.closest(".name"); if (!nameEl) return;
    const card = ev.target.closest("[data-path]"); const path = card?.dataset.path;
    const old = getFileAlias(path) || displayNameFor(path);
    const name = await promptString("Set Display Name", "Enter new display name (leave empty to restore original)", old);
    await setFileAlias(path, name || "");
    nameEl.textContent = displayNameFor(path);
  });
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
      const ok = await Dialog.confirm({ title: "Hide/Remove this file", content: `<p>Are you sure you want to remove this file from the current category (or hide it for this category)?</p><p><small>${escapeHtml(path)}</small></p>` });
      if (!ok) return;
      const changed = await removeFromCategoryOrHide(key, path);
      if (changed) {
        ui.notifications?.info("File has been removed/hidden from this category.");
        try { await WebMViewerApp?.instance?.refreshIndex?.(false); renderMainPanel(WebMViewerApp?.instance, WebMViewerApp?.instance?.element[0]); } catch {}
      } else {
        ui.notifications?.warn("No changes were made.");
      }
    }
  });
  root._cornerDelegated = true;
}

/* ============== “添加文件到分类”对话框（浏览/上传面板/手输 => 加白名单） ============== */
async function openAddSingleFileDialog(catKey, appInstance) {
  const srcMap = getAvailableSources();
  const srcOptions = Object.entries(srcMap).map(([k, v]) => `<option value="${escapeAttr(k)}">${escapeHtml(v)}</option>`).join("");
  const cat = getCategoriesArray().find(c => c.key === catKey);
  const initialSrc = cat?.source || "data";
  const initialPath = "";
  let content = `
    <div class="fvtt-dialog">
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">
        <label style="min-width:70px;">Source</label>
        <select name="src" style="flex:1;">${srcOptions}</select>
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        <label style="min-width:70px;">File Path</label>
        <input type="text" name="path" value="${escapeAttr(initialPath)}" placeholder="Paste or use 'Browse/Upload' to select" style="flex:1;">
        <button type="button" name="browse"><i class="fas fa-folder-open"></i> Browse</button>
        <button type="button" name="upload"><i class="fas fa-upload"></i> Upload</button>
      </div>
      <p style="margin-top:6px;opacity:.75;">Note: This adds a file to the category's whitelist. In the file picker, you can also upload a file first, then click it to add it to the whitelist.</p>
    </div>`;
  return new Promise((resolve) => {
    let dlg;
    dlg = new Dialog({
      title: "Add File to Category",
      content,
      buttons: {
        ok: { label: "Add", icon: '<i class="fas fa-plus"></i>', callback: async (html) => {
          const path = html[0].querySelector('input[name="path"]')?.value?.trim();
          if (!path) return ui.notifications?.warn("Please enter or select a file path.");
          if (!hasMediaExt(path)) return ui.notifications?.warn("Only image or video files are supported.");
          await addFileToCategory(catKey, path);
          ui.notifications?.info("Added to the category whitelist.");
          try { await appInstance?.refreshIndex?.(false); renderMainPanel(appInstance, appInstance.element[0]); } catch {}
          resolve(true);
        }},
        cancel: { label: "Cancel", callback: () => resolve(false) }
      },
      default: "ok",
      render: (html) => {
        const srcSel = html[0].querySelector('select[name="src"]');
        const pathInput = html[0].querySelector('input[name="path"]');
        const browseBtn = html[0].querySelector('button[name="browse"]');
        const uploadBtn = html[0].querySelector('button[name="upload"]');
        if (srcSel) srcSel.value = initialSrc;

        // 浏览：选择后直接回填并加白名单
        browseBtn?.addEventListener("click", async () => {
          const p = await pickMediaPathViaFilePicker({
            source: srcSel.value || "data",
            current: cat?.folder || "",
            allowUpload: false
          });
          if (!p) return;
          pathInput.value = p;
          await addFileToCategory(catKey, p);
          ui.notifications?.info("Added to this category's whitelist.");
          try { await appInstance?.refreshIndex?.(false); renderMainPanel(appInstance, appInstance.element[0]); } catch {}
        });

        // 上传面板（允许上传），上传后点击文件 => 加白名单
        uploadBtn?.addEventListener("click", async () => {
          const p = await pickMediaPathViaFilePicker({
            source: srcSel.value || "data",
            current: cat?.folder || "",
            allowUpload: true
          });
          if (!p) return;
          pathInput.value = p;
          await addFileToCategory(catKey, p);
          ui.notifications?.info("Uploaded/selected and added to this category's whitelist.");
          try { await appInstance?.refreshIndex?.(false); renderMainPanel(appInstance, appInstance.element[0]); } catch {}
        });
      }
    });
    dlg.render(true);
  });
}

/* ============== 处理“添加文件到当前分类”点击 ============== */
async function handleAddFileToCategory(app) {
  const cats = getCategoriesArray();
  if (app?.mode === "category" && app?.activeCategoryKey) {
    await openAddSingleFileDialog(app.activeCategoryKey, app);
    return;
  }
  if (!cats.length) {
    ui.notifications?.warn("No categories have been configured yet. Please create categories in the module settings first.");
    return;
  }
  const radios = cats.map(c => `<label style="display:block;margin:4px 0;">
    <input type="radio" name="catPick" value="${escapeAttr(c.key)}"> ${escapeHtml(c.name)} <small style="opacity:.7;">(${escapeHtml(c.key)})</small>
  </label>`).join("");

  const content = `<div class="fvtt-dialog">
    <p>Please select a category to add to:</p>
    <div class="cat-list">${radios}</div>
  </div>`;

  await new Promise((resolve) => {
    new Dialog({
      title: "Select Category",
      content,
      buttons: {
        ok: {
          label: "Next", icon: '<i class="fas fa-arrow-right"></i>',
          callback: async (html) => {
            const key = html[0].querySelector('input[name="catPick"]:checked')?.value;
            if (!key) { ui.notifications?.warn("Please select a category first."); return resolve(); }
            await openAddSingleFileDialog(key, app);
            resolve();
          }
        },
        cancel: { label: "Cancel", callback: () => resolve() }
      },
      default: "ok"
    }).render(true);
  });
}

/* ============== 工具栏事件（全窗委托） + 分类操作/别名编辑 ============== */
function attachViewerEvents(app, rootEl) {
  if (!rootEl) return;
  const wc = getWC(rootEl);
  if (!wc || wc._delegated) return;

  wc.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-action]");
    if (!btn || !wc.contains(btn)) return;
    const a = btn.dataset.action;

    if (a === "overview") {
      app.mode = "overview"; app.activeCategoryKey = null; renderMainPanel(app, rootEl);
    } else if (a === "category") {
      app.mode = "category"; app.activeCategoryKey = btn.dataset.key; renderMainPanel(app, rootEl);
    } else if (a === "favorites") {
      app.mode = "favorites"; renderMainPanel(app, rootEl);
    } else if (a === "presets") {
      app.mode = "presets"; renderMainPanel(app, rootEl);
    } else if (a === "clear") {
      await clearSequencerEffects(); app.renderNowPlaying?.();
    } else if (a === "toggle-order") {
      const cur = game.settings.get(MODULE_ID, "orderMode") || "asc";
      const next = cur === "asc" ? "desc" : "asc";
      await game.settings.set(MODULE_ID, "orderMode", next);
      ORDER_COUNTER = 0; renderMainPanel(app, rootEl);
      ui.notifications?.info(`Placement order switched to: ${next === "asc" ? "Ascending" : "Descending"}`);
    } else if (a === "filter-media") {
      const cur = app.mediaFilterMode || "all";
      const next = cur === "all" ? "img" : (cur === "img" ? "vid" : "all");
      app.mediaFilterMode = next;
      updateFilterButtonVisual(app, btn);
      renderMainPanel(app, rootEl);
    } else if (a === "add-file-current") {
      await handleAddFileToCategory(app);
    } else if (a === "open-cat-config") {
      if (!game.user?.isGM) return ui.notifications?.warn("Only GMs can configure categories.");
      new CategoriesConfigForm().render(true);
    } else if (a === "rename-alias") {
      const card = btn.closest("[data-path]"); const path = card?.dataset.path;
      const old = getFileAlias(path) || displayNameFor(path);
      const name = await promptString("Set Display Name", "Enter new display name (leave empty to restore original)", old);
      await setFileAlias(path, name || "");
      const nameEl = card.querySelector(".label.name, .name"); if (nameEl) nameEl.textContent = displayNameFor(path);
    }
  }, true);

  wc.addEventListener("input", (ev) => {
    const t = ev.target;
    if (t?.name === "search") {
      app.searchQuery = t.value ?? "";
      renderMainPanel(app, rootEl);
    }
  }, true);

  wc._delegated = true;
}

// 兜底：无论按钮在不在 toolbar，都能响应
function attachGlobalAddFileHandler(app, rootEl) {
  if (!rootEl || rootEl._globalAddFileDelegated) return;
  rootEl.addEventListener("click", async (ev) => {
    const btn = ev.target.closest('button[data-action="add-file-current"]');
    if (!btn) return;
    await handleAddFileToCategory(app);
  });
  rootEl._globalAddFileDelegated = true;
}

/* ============== 虚拟网格（滚动容器为 host） ============== */
function mountVirtualGrid(app, scrollRoot, grid) {
  if (!grid) return;
  const files = app.filteredFiles();
  grid.style.display = "grid";
  grid.style.gridTemplateColumns = "repeat(auto-fill,minmax(200px,1fr))";
  grid.style.gap = "8px";
  grid.innerHTML = "";
  app._virtual.files = files; app._virtual.next = 0;
  if (app._virtual.observer) { app._virtual.observer.disconnect(); app._virtual.observer = null; }

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
    const io = new IntersectionObserver((ents) => { for (const e of ents) if (e.isIntersecting) appendChunk(); }, { root: scrollRoot, rootMargin: "200px 0px", threshold: 0 });
    io.observe(sentinel); app._virtual.observer = io;
  }
}

/* ============== 正在播放（固定在顶部） ============== */
function renderNowPlayingGrid(app, rootEl) {
  const wc = getWC(rootEl); if (!wc) return;
  const host = wc.querySelector(`#${MODULE_ID}-host`) || ensureHost(wc);

  let np = wc.querySelector(".now-playing");
  if (!np) {
    np = document.createElement("div");
    np.className = "now-playing";
    np.style.flex = "0 0 auto";
    wc.insertBefore(np, host);
  }
  if (NP_SELECTED && !ACTIVE_EFFECTS.some(r => r.name === NP_SELECTED)) NP_SELECTED = null;

  const items = ACTIVE_EFFECTS.slice();
  if (!items.length) { np.innerHTML = `<div class="np2-empty" style="opacity:.6;margin-top:6px;">(No effects currently playing)</div>`; return; }

  let html = `<div class="np2-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;align-items:start;margin-top:6px;">`;
  for (let i=0;i<items.length;i++) {
    const r = items[i]; const selected = (NP_SELECTED === r.name);
    const border = selected ? "box-shadow:0 0 0 2px #4aa3ff;" : "";
    const media = isVideo(r.path)
      ? `<video class="np2-thumb" muted preload="metadata" playsinline data-src="${escapeAttr(r.path)}" style="width:100%;height:72px;object-fit:cover;border-radius:4px;background:${getPreviewBgColor()};"></video>`
      : `<img class="np2-thumb-img" data-src="${escapeAttr(r.path)}" style="width:100%;height:72px;object-fit:cover;border-radius:4px;background:${getPreviewBgColor()};" />`;
    html += `<div class="np2-item" draggable="true" data-index="${i}" data-ename="${escapeAttr(r.name)}" data-path="${escapeAttr(r.path)}"
      style="position:relative;border:1px solid #6666;border-radius:6px;padding:6px;background:#1e1e1e;${border}">
      <button class="np2-close" title="Stop this effect" style="position:absolute;right:4px;top:4px;border:none;background:#000c;color:#fff;border-radius:10px;width:18px;height:18px;line-height:18px;text-align:center;cursor:pointer;z-index:2;">
        <i class="fas fa-times" style="font-size:12px;pointer-events:none;"></i>
      </button>
      ${media}
      <div class="np2-label" title="${escapeAttr(r.path)}" style="margin-top:4px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#fff;">${escapeHtml(displayNameFor(r.path))}</div>
    </div>`;
  }
  html += `</div>`;
  np.innerHTML = html;

  if (!np._delegated) {
    np.addEventListener("click", async (ev) => {
      const btn = ev.target.closest(".np2-close"); if (!btn) return;
      const item = btn.closest(".np2-item"); if (!item) return;
      const ename = item.dataset.ename;
      await endEffectRobust(ename);
      removeActiveRecordByName(ename);
      if (NP_SELECTED === ename) NP_SELECTED = null;
      renderNowPlayingGrid(app, rootEl);
    });
    np.addEventListener("dblclick", (ev) => {
      const item = ev.target.closest(".np2-item"); if (!item) return;
      const ename = item.dataset.ename;
      NP_SELECTED = (NP_SELECTED === ename) ? null : ename;
      renderNowPlayingGrid(app, rootEl);
    });
    let dragInfo = null;
    np.addEventListener("dragstart", (ev) => {
      const item = ev.target.closest(".np2-item"); if (!item) return;
      dragInfo = { from: parseInt(item.dataset.index) }; item.classList.add("dragging");
      try { ev.dataTransfer.effectAllowed = "move"; } catch {}
    });
    np.addEventListener("dragend", () => {
      const draggingEl = np.querySelector(".np2-item.dragging"); if (draggingEl) draggingEl.classList.remove("dragging");
      dragInfo = null;
    });
    np.addEventListener("dragover", (ev) => {
      const item = ev.target.closest(".np2-item"); if (!item || dragInfo == null) return; ev.preventDefault();
      try { ev.dataTransfer.dropEffect = "move"; } catch {}
    });
    np.addEventListener("drop", async (ev) => {
      const item = ev.target.closest(".np2-item"); if (!item || dragInfo == null) return; ev.preventDefault();
      const to = parseInt(item.dataset.index); const from = dragInfo.from; dragInfo = null;
      if (isNaN(from) || isNaN(to) || from === to) return;
      const arr = ACTIVE_EFFECTS.slice(); const [moved] = arr.splice(from, 1); arr.splice(to, 0, moved); ACTIVE_EFFECTS = arr;
      await replayActiveEffectsInCurrentOrder({ instant: true }); NP_SELECTED = null; renderNowPlayingGrid(app, rootEl);
    });
    np._delegated = true;
  }

  eagerLoadMediaIn(np);
  observeVideoPreviews(np, { root: wc });
}

/* ============== 拖拽排序后重放以调整叠放顺序 ============== */
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

/* ============== Presenter 网格项（预览底色与别名） ============== */
function createGridItem(f) {
  const isVid = isVideo(f.path);
  const d = document.createElement("div");
  d.className = "webm-item"; d.title = f.path; d.dataset.path = f.path; d.dataset.source = f.source || "data"; d.dataset.catKey = f.categoryKey || "";
  d.style.position = "relative";
  d.style.border = "1px solid #6666"; d.style.borderRadius = "8px"; d.style.padding = "6px"; d.style.background = "#1e1e1e";
  const media = isVid
    ? `<video class="preview" muted preload="metadata" playsinline data-src="${escapeAttr(f.path)}" style="width:100%;height:120px;object-fit:cover;border-radius:6px;background:${getPreviewBgColor()};"></video>`
    : `<img class="preview-img" data-src="${escapeAttr(f.path)}" style="width:100%;height:120px;object-fit:cover;border-radius:6px;background:${getPreviewBgColor()};" />`;
  d.innerHTML = `
    <div class="thumb" style="position:relative;">
      ${media}
      <i class="fas fa-film fallback" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);opacity:.25;pointer-events:none;"></i>
    </div>
    <div class="label-wrap" style="display:flex;align-items:center;gap:6px;margin-top:6px;">
      <div class="name" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;color:#fff;" title="${escapeAttr(f.path)}">${escapeHtml(displayNameFor(f.path))}</div>
      <button data-action="rename-alias" title="Rename Display Name" style="min-width:0;width:20px;height:20px;padding:0;border:none;background:#000c;color:#fff;border-radius:4px;"><i class="fas fa-pencil-alt" style="font-size:11px;"></i></button>
    </div>
    <button class="corner delete" title="Remove/Hide this file" style="position:absolute;right:8px;top:8px;border:none;background:#000c;color:#fff;border-radius:10px;width:20px;height:20px;line-height:20px;text-align:center;cursor:pointer;"><i class="fas fa-ban" style="font-size:12px;pointer-events:none;"></i></button>
    <button class="corner add-fav" title="Add to Favorites" style="position:absolute;left:8px;top:8px;border:none;background:#000c;color:#fff;border-radius:10px;width:20px;height:20px;line-height:20px;text-align:center;cursor:pointer;"><i class="fas fa-star" style="font-size:12px;pointer-events:none;"></i></button>`;
  return d;
}

/* ============== 收藏对话（角标） ============== */
function openFavDialog(filePath) {
  const favorites = getFavorites();
  const listNames = Object.keys(favorites);
  let content = `<div class="fvtt-dialog"><p>Select a favorite:</p><div class="fav-list">`;
  for (const name of listNames) content += `<label style="display:block;margin:4px 0;"><input type="radio" name="favTarget" value="${escapeAttr(name)}"> ${escapeHtml(name)}</label>`;
  content += `</div><hr/><div style="display:flex;gap:8px;align-items:center;"><input type="text" name="newFavName" placeholder="New favorite name" style="flex:1;"></div></div>`;
  new Dialog({
    title: "Add to Favorites",
    content,
    buttons: {
      ok: { label: "OK", icon: '<i class="fas fa-star"></i>', callback: (html) => {
        const sel = html[0].querySelector('input[name="favTarget"]:checked')?.value;
        let newName = html[0].querySelector('input[name="newFavName"]')?.value?.trim();
        let target = sel || newName;
        if (!target) return ui.notifications?.warn("Please select a favorite or enter a new name.");
        addToFavorite(target, filePath);
        ui.notifications?.info(`Added to favorite: ${target}`);
      }},
      cancel: { label: "Cancel" }
    }
  }).render(true);
}

/* ============== 预设激活 ============== */
async function activatePresetById(folder, id) {
  const ps = getPresets();
  const list = ps[folder] || [];
  const p = list.find(x => x.id === id);
  if (!p) return ui.notifications?.warn("Preset does not exist.");
  const items = (p.items || []).map(it => it.path).filter(Boolean);
  if (!items.length) return ui.notifications?.warn("Preset is empty.");

  await clearSequencerEffects();
  for (const path of items) await playFullscreen(path, { skipGlobalClear: true });
  CURRENT_PRESET_TAG = folder + ":" + id;
  (WebMViewerApp?.instance ?? window.sequencerWebmOrbViewer)?.renderNowPlaying?.();
}

/* ============== 分类：添加文件到当前分类（白名单） ============== */
async function addFileToCategory(catKey, filePath) {
  const cats = foundry.utils.duplicate(getCategoriesObject());
  const c = cats[catKey] ?? (cats[catKey] = { name: catKey, folder: "", source: "data", extraFiles: [], hiddenFiles: [] });
  if (!Array.isArray(c.extraFiles)) c.extraFiles = [];

  const baseNew = stripQuery(filePath);
  const already = (c.extraFiles || []).some(p => stripQuery(p) === baseNew);
  if (!already) c.extraFiles.push(filePath);

  await game.settings.set(MODULE_ID, "categories", cats);
}

/* ============== 分类：从分类移除或隐藏（屏蔽按钮真正生效） ============== */
async function removeFromCategoryOrHide(catKey, filePath) {
  const cats = foundry.utils.duplicate(getCategoriesObject());
  const c = cats[catKey] ?? (cats[catKey] = { name: catKey, folder: "", source: "data", extraFiles: [], hiddenFiles: [] });
  if (!Array.isArray(c.extraFiles)) c.extraFiles = [];
  if (!Array.isArray(c.hiddenFiles)) c.hiddenFiles = [];

  const base = stripQuery(filePath);
  let changed = false;

  // 1) 从白名单中移除此文件（按去 query 后基名去重）
  const before = c.extraFiles.length;
  c.extraFiles = c.extraFiles.filter(p => stripQuery(p) !== base);
  if (c.extraFiles.length !== before) changed = true;

  // 2) 加入隐藏列表：完整路径与基础路径都加入，保证来自文件夹索引和带签名URL都可匹配
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