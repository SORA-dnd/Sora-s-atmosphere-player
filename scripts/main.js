const MODULE_ID = "sequencer-webm-orb";
const EFFECT_TAG = `${MODULE_ID}-effect`;
const MAX_CATEGORIES = 8;
const WEBM_RE = /\.(webm|wbem)$/i; // 兼容“wbem”误写

// 获取 v13+ 的 FilePicker 实现（避免全局弃用警告）
function FP() {
  return foundry?.applications?.apps?.FilePicker?.implementation ?? window.FilePicker;
}

Hooks.once("init", () => {
  registerSettings();
  // 保险：注册一些常用 Handlebars helper（模板已尽量不依赖）
  if (window.Handlebars) {
    Handlebars.registerHelper("eq", (a, b) => a === b);
    Handlebars.registerHelper("and", (a, b) => a && b);
    Handlebars.registerHelper("gt", (a, b) => a > b);
    Handlebars.registerHelper("length", (x) => {
      if (Array.isArray(x)) return x.length;
      if (x && typeof x === "object") return Object.keys(x).length;
      return (x ?? "").toString().length || 0;
    });
  }
});

Hooks.once("ready", () => {
  if (!game.modules.get("sequencer")?.active) {
    ui.notifications?.error("需要启用 Sequencer 模块后才能使用 Sequencer WebM Orb 播放器。");
    return;
  }
  FloatingOrb.ensure();
});

/* ============================
   设置
============================ */
function registerSettings() {
  // 世界范围：分类配置（支持 extraFiles/hiddenFiles）
  game.settings.register(MODULE_ID, "categories", {
    name: "分类配置",
    hint: "最多8个分类，每个分类可自定义名称、文件夹，并可手动加入/屏蔽文件。",
    scope: "world",
    config: false,
    type: Object,
    default: defaultCategories()
  });

  // 客户端：收藏夹（当前用户独立）
  game.settings.register(MODULE_ID, "favorites", {
    name: "收藏夹",
    scope: "client",
    config: false,
    type: Object,
    default: {}
  });

  // 客户端：悬浮球位置
  game.settings.register(MODULE_ID, "orbPosition", {
    name: "悬浮球位置",
    scope: "client",
    config: false,
    type: Object,
    default: { left: 20, top: 120 }
  });

  // 客户端：播放选项（微调项）
  game.settings.register(MODULE_ID, "playOptions", {
    name: "播放选项",
    scope: "client",
    config: false,
    type: Object,
    default: {
      aboveUI: true,
      clearBeforePlay: false,
      fadeIn: 250,
      fadeOut: 400
    }
  });

  // 设置菜单：分类配置界面
  game.settings.registerMenu(MODULE_ID, "categoryConfigMenu", {
    name: "WebM 分类配置",
    label: "打开分类配置",
    hint: "为每个分类设置名称与文件夹，也可以上传 .webm 文件。",
    type: WebMCategorySettings,
    restricted: true
  });
}

function defaultCategories() {
  const cat = {};
  for (let i = 1; i <= MAX_CATEGORIES; i++) {
    cat[`cat${i}`] = { name: `分类${i}`, folder: "", source: "data", extraFiles: [], hiddenFiles: [] };
  }
  return cat;
}

/* ============================
   悬浮球（可拖动，双击打开，移出半透明）
============================ */
class FloatingOrb {
  static ensure() {
    if (document.getElementById(`${MODULE_ID}-orb`)) return;

    const pos = game.settings.get(MODULE_ID, "orbPosition") ?? { left: 20, top: 120 };
    const orb = document.createElement("div");
    orb.id = `${MODULE_ID}-orb`;
    orb.title = "双击打开 WebM 播放器";
    orb.classList.add(`${MODULE_ID}-orb`, "dim");
    orb.style.left = `${pos.left}px`;
    orb.style.top = `${pos.top}px`;
    orb.innerHTML = `<div class="${MODULE_ID}-orb-core"><i class="fas fa-film icon"></i></div>`;

    document.body.appendChild(orb);

    let dragging = false;
    let offset = { x: 0, y: 0 };

    orb.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      dragging = true;
      orb.classList.add("dragging");
      orb.classList.remove("dim");
      offset.x = ev.clientX - orb.offsetLeft;
      offset.y = ev.clientY - orb.offsetTop;
    });

    window.addEventListener("mousemove", (ev) => {
      if (!dragging) return;
      const left = Math.max(0, Math.min(window.innerWidth - orb.offsetWidth, ev.clientX - offset.x));
      const top = Math.max(0, Math.min(window.innerHeight - orb.offsetHeight, ev.clientY - offset.y));
      orb.style.left = `${left}px`;
      orb.style.top = `${top}px`;
    });

    window.addEventListener("mouseup", async () => {
      if (!dragging) return;
      dragging = false;
      orb.classList.remove("dragging");
      orb.classList.add("dim");
      await game.settings.set(MODULE_ID, "orbPosition", {
        left: parseInt(orb.style.left),
        top: parseInt(orb.style.top)
      });
    });

    // 悬停显现 / 离开半透明
    orb.addEventListener("mouseenter", () => orb.classList.remove("dim"));
    orb.addEventListener("mouseleave", () => { if (!dragging) orb.classList.add("dim"); });

    // 双击打开主界面（避免误触）
    orb.addEventListener("dblclick", () => {
      if (dragging) return;
      WebMViewerApp.show();
    });
  }
}

/* ============================
   主界面
============================ */
class WebMViewerApp extends Application {
  static #instance;

  static show() {
    if (!this.#instance) this.#instance = new WebMViewerApp();
    this.#instance.render(true, { focus: true });
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: `${MODULE_ID}-viewer`,
      title: "WebM 全屏播放器",
      template: `modules/${MODULE_ID}/templates/viewer.hbs`,
      width: 900,
      height: 680,
      resizable: true,
      popOut: true
    });
  }

  constructor(...args) {
    super(...args);
    this.mode = "overview"; // "overview" | "category"
    this.activeCategoryKey = null;
    this.searchQuery = "";
    this.index = []; // { path, name, categoryKey, source }
    this.loading = false;
  }

  getData() {
    const rawCats = getCategoriesArray();
    const categories = rawCats.map(c => ({
      ...c,
      isActive: this.mode === "category" && this.activeCategoryKey === c.key
    }));

    const files = this.filteredFiles();
    return {
      categories,
      isOverview: this.mode === "overview",
      files,
      hasFiles: files.length > 0,
      loading: this.loading,
      searchQuery: this.searchQuery
    };
  }

  filteredFiles() {
    let files = [];
    if (this.mode === "overview") {
      files = this.index;
    } else if (this.mode === "category" && this.activeCategoryKey) {
      files = this.index.filter(f => f.categoryKey === this.activeCategoryKey);
    }

    if (this.searchQuery?.trim()) {
      const q = this.searchQuery.trim().toLowerCase();
      files = files.filter(f => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q));
    }
    return files.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans"));
  }

  async _render(force, options) {
    const out = await super._render(force, options);
    if (!this._indexInitialized) {
      this._indexInitialized = true;
      await this.refreshIndex();
    }
    return out;
  }

  activateListeners(html) {
    super.activateListeners(html);

    // 顶部控制
    html.find("[data-action='overview']").on("click", () => {
      this.mode = "overview";
      this.activeCategoryKey = null;
      this.render();
    });

    html.find("[data-action='category']").on("click", (ev) => {
      const key = ev.currentTarget.dataset.key;
      this.mode = "category";
      this.activeCategoryKey = key;
      this.render();
    });

    // 添加单文件到分类
    html.find("[data-action='add-file']").on("click", async (ev) => {
      ev.stopPropagation();
      const key = ev.currentTarget.dataset.key;
      const cat = getCategoriesArray().find(c => c.key === key);
      const picker = new (FP())({
        type: "imagevideo",
        current: cat?.folder || "",
        callback: async (path) => {
          if (!WEBM_RE.test(path)) {
            ui.notifications?.warn("请选择 .webm（或 .wbem）文件。");
            return;
          }
          await addFileToCategory(key, path);
          ui.notifications?.info("已添加到该分类。");
          await this.refreshIndex();
        }
      });
      picker.render(true);
      picker.activeSource = cat?.source || "data";
    });

    html.find("[data-action='favorites']").on("click", () => {
      FavoritesApp.show();
    });

    html.find("[data-action='clear']").on("click", () => clearSequencerEffects());

    html.find("[name='search']").on("input", (ev) => {
      this.searchQuery = ev.currentTarget.value ?? "";
      this.render(false);
    });

    // 文件项：双击播放
    html.find(".webm-item").on("dblclick", async (ev) => {
      const path = ev.currentTarget.dataset.path;
      const source = ev.currentTarget.dataset.source || "data";
      await playFullscreen(path, { source });
    });

    // 右键加入收藏
    html.find(".webm-item").on("contextmenu", (ev) => {
      ev.preventDefault();
      const path = ev.currentTarget.dataset.path;
      this._openAddToFavoriteDialog(path);
    });

    // 快捷收藏按钮
    html.find(".webm-item .add-fav").on("click", (ev) => {
      ev.stopPropagation();
      const path = ev.currentTarget.closest(".webm-item").dataset.path;
      this._openAddToFavoriteDialog(path);
    });

    // 悬停预览（鼠标进入播放，离开暂停，循环）
    html.find(".webm-item").on("mouseenter", (ev) => {
      const item = ev.currentTarget;
      const video = item.querySelector("video.preview");
      const path = item.dataset.path;
      if (!video) return;
      if (!video.src) video.src = path;
      video.currentTime = 0;
      bindVideoState(video);
      video.play?.().catch(() => {});
    });
    html.find(".webm-item").on("mouseleave", (ev) => {
      const item = ev.currentTarget;
      const video = item.querySelector("video.preview");
      if (!video) return;
      video.pause?.();
    });

    // 双击“删除角标”从播放器中移除（extraFiles 移除；目录文件写入 hiddenFiles）
    html.find(".webm-item .delete").on("dblclick", async (ev) => {
      ev.stopPropagation();
      const item = ev.currentTarget.closest(".webm-item");
      const filePath = item.dataset.path;
      const catKey = item.dataset.catKey;
      try {
        const ok = await removeFromCategoryOrHide(catKey, filePath);
        if (ok) {
          ui.notifications?.info("已从播放器中移除该文件（可通过“添加文件”重新加入）");
          await this.refreshIndex();
        } else {
          ui.notifications?.warn("移除失败：找不到分类或权限不足。");
        }
      } catch (err) {
        console.error(err);
        ui.notifications?.error("移除失败，请查看控制台。");
      }
    });

    // 新增：打开后就为可见条目预加载预览视频（设置 src + load metadata）
    primePreviewsIn(html[0]);
  }

  getHeaderButtons() {
    const buttons = super.getHeaderButtons();
    buttons.unshift({
      label: "刷新",
      class: "refresh-index",
      icon: "fas fa-rotate",
      onclick: () => this.refreshIndex()
    });
    buttons.unshift({
      label: "设置",
      class: "open-settings",
      icon: "fas fa-cog",
      onclick: () => {
        const app = new WebMCategorySettings();
        app.render(true);
      }
    });
    return buttons;
  }

  async refreshIndex() {
    this.loading = true;
    this.render(false);

    const categories = getCategoriesArray().filter(c => c.folder?.trim() || (c.extraFiles?.length));
    const all = [];
    for (const cat of categories) {
      const set = new Set();
      const hidden = new Set(cat.hiddenFiles || []);

      // 来自目录的文件
      if (cat.folder?.trim()) {
        const list = await listAllWebms(cat.folder, cat.source || "data");
        for (const file of list) {
          if (hidden.has(file)) continue; // 屏蔽
          if (!set.has(file)) {
            set.add(file);
            all.push({
              path: file,
              name: file.split("/").pop(),
              categoryKey: cat.key,
              source: cat.source || "data"
            });
          }
        }
      }
      // 手动添加的文件
      for (const file of (cat.extraFiles || [])) {
        if (hidden.has(file)) continue; // 屏蔽
        if (WEBM_RE.test(file) && !set.has(file)) {
          set.add(file);
          all.push({
            path: file,
            name: file.split("/").pop(),
            categoryKey: cat.key,
            source: cat.source || "data"
          });
        }
      }
    }

    this.index = all;
    this.loading = false;
    this.render(false);
  }

  _openAddToFavoriteDialog(filePath) {
    const favorites = getFavorites();
    const listNames = Object.keys(favorites);

    let content = `<div class="fvtt-dialog">
      <p>选择收藏夹：</p>
      <div class="fav-list">`;
    for (const name of listNames) {
      content += `<label style="display:block;margin:4px 0;">
        <input type="radio" name="favTarget" value="${escapeHtml(name)}"> ${escapeHtml(name)}
      </label>`;
    }
    content += `</div>
      <hr/>
      <div style="display:flex;gap:8px;align-items:center;">
        <input type="text" name="newFavName" placeholder="新建收藏夹名称" style="flex:1;">
        <button type="button" data-action="create">新建</button>
      </div>
    </div>`;

    new Dialog({
      title: "添加到收藏夹",
      content,
      buttons: {
        ok: {
          label: "确定",
          icon: '<i class="fas fa-star"></i>',
          callback: (html) => {
            const sel = html[0].querySelector('input[name="favTarget"]:checked')?.value;
            let target = sel;
            if (!target) {
              const newName = html[0].querySelector('input[name="newFavName"]')?.value?.trim();
              if (!newName) {
                ui.notifications?.warn("请选择一个收藏夹或输入新名称。");
                return false;
              }
              target = newName;
            }
            addToFavorite(target, filePath);
            ui.notifications?.info(`已添加到收藏夹：${target}`);
          }
        },
        cancel: { label: "取消" }
      },
      render: (html) => {
        html[0].querySelector('button[data-action="create"]')?.addEventListener("click", () => {
          const input = html[0].querySelector('input[name="newFavName"]');
          if (!input.value.trim()) return;
          html[0].querySelectorAll('input[name="favTarget"]').forEach(el => el.checked = false);
        });
      }
    }).render(true);
  }
}

/* ============================
   收藏夹界面
============================ */
class FavoritesApp extends Application {
  static #instance;

  static show() {
    if (!this.#instance) this.#instance = new FavoritesApp();
    this.#instance.render(true, { focus: true });
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: `${MODULE_ID}-favorites`,
      title: "收藏夹",
      template: `modules/${MODULE_ID}/templates/favorites.hbs`,
      width: 780,
      height: 600,
      resizable: true,
      popOut: true
    });
  }

  constructor(...args) {
    super(...args);
    this.activeFav = null;
  }

  getData() {
    const favorites = getFavorites();
    const names = Object.keys(favorites).sort((a, b) => a.localeCompare(b, "zh-Hans"));
    if (!this.activeFav && names.length) this.activeFav = names[0];

    const files = (favorites[this.activeFav] || []).map(path => ({
      path,
      name: path.split("/").pop()
    }));

    const favEntries = names.map(name => ({
      name,
      count: (favorites[name] || []).length,
      active: name === this.activeFav
    }));

    return {
      favorites,
      favEntries,
      hasNames: names.length > 0,
      activeFav: this.activeFav,
      files,
      hasFiles: files.length > 0
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    // 左侧切换收藏夹
    html.find(".fav-list .fav-item").on("click", (ev) => {
      this.activeFav = ev.currentTarget.dataset.name;
      this.render(false);
    });

    // 新建收藏夹
    html.find("[data-action='create-fav']").on("click", async () => {
      const name = await promptString("新建收藏夹", "输入收藏夹名称");
      if (!name) return;
      createFavorite(name);
      this.activeFav = name;
      this.render(false);
    });

    // 重命名收藏夹
    html.find("[data-action='rename-fav']").on("click", async () => {
      if (!this.activeFav) return;
      const name = await promptString("重命名收藏夹", "输入新名称", this.activeFav);
      if (!name) return;
      renameFavorite(this.activeFav, name);
      this.activeFav = name;
      this.render(false);
    });

    // 删除收藏夹
    html.find("[data-action='delete-fav']").on("click", async () => {
      if (!this.activeFav) return;
      const ok = await Dialog.confirm({ title: "删除收藏夹", content: `<p>确定删除收藏夹：${escapeHtml(this.activeFav)}？</p>` });
      if (!ok) return;
      deleteFavorite(this.activeFav);
      this.activeFav = null;
      this.render(false);
    });

    // 播放与移出
    html.find(".fav-file").on("dblclick", async (ev) => {
      const path = ev.currentTarget.dataset.path;
      await playFullscreen(path);
    });

    html.find(".fav-file .remove").on("click", (ev) => {
      ev.stopPropagation();
      const path = ev.currentTarget.closest(".fav-file").dataset.path;
      removeFromFavorite(this.activeFav, path);
      this.render(false);
    });

    // 悬停预览
    html.find(".fav-file").on("mouseenter", (ev) => {
      const item = ev.currentTarget;
      const video = item.querySelector("video.preview");
      const path = item.dataset.path;
      if (!video) return;
      if (!video.src) video.src = path;
      video.currentTime = 0;
      bindVideoState(video);
      video.play?.().catch(() => {});
    });
    html.find(".fav-file").on("mouseleave", (ev) => {
      const item = ev.currentTarget;
      const video = item.querySelector("video.preview");
      if (!video) return;
      video.pause?.();
    });

    // 新增：打开后就预加载预览
    primePreviewsIn(html[0]);
  }
}

/* ============================
   分类设置界面（使用模板）
============================ */
class WebMCategorySettings extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: `${MODULE_ID}-settings`,
      title: "WebM 分类配置",
      template: `modules/${MODULE_ID}/templates/settings.hbs`,
      width: 700,
      height: "auto",
      closeOnSubmit: true
    });
  }

  getData() {
    const cats = game.settings.get(MODULE_ID, "categories") ?? defaultCategories();
    const categories = Array.from({ length: MAX_CATEGORIES }, (_, i) => {
      const key = `cat${i + 1}`;
      const cat = cats[key] || { name: `分类${i + 1}`, folder: "", source: "data", extraFiles: [], hiddenFiles: [] };
      return { index: i + 1, key, name: cat.name, folder: cat.folder, source: cat.source || "data" };
    });
    return { categories };
  }

  async _updateObject(event, formData) {
    const prev = game.settings.get(MODULE_ID, "categories") ?? defaultCategories();
    const cats = {};
    for (let i = 1; i <= MAX_CATEGORIES; i++) {
      const key = `cat${i}`;
      cats[key] = {
        name: formData[`${key}-name`] || `分类${i}`,
        source: formData[`${key}-source`] || "data",
        folder: formData[`${key}-folder`] || "",
        extraFiles: Array.isArray(prev[key]?.extraFiles) ? prev[key].extraFiles : [],
        hiddenFiles: Array.isArray(prev[key]?.hiddenFiles) ? prev[key].hiddenFiles : []
      };
    }
    await game.settings.set(MODULE_ID, "categories", cats);
    ui.notifications?.info("分类设置已保存");
  }

  activateListeners(html) {
    super.activateListeners(html);
    const el = html[0];

    el.querySelectorAll(".browse").forEach(btn => {
      btn.addEventListener("click", async () => {
        const key = btn.dataset.key;
        const source = el.querySelector(`select[name='${key}-source']`).value || "data";
        const picker = new (FP())({
          type: "folder",
          current: el.querySelector(`input[name='${key}-folder']`).value || "",
          callback: (path) => {
            el.querySelector(`input[name='${key}-folder']`).value = path;
          }
        });
        picker.render(true);
        picker.activeSource = source;
      });
    });

    el.querySelectorAll(".upload").forEach(btn => {
      btn.addEventListener("click", async () => {
        const key = btn.dataset.key;
        const source = el.querySelector(`select[name='${key}-source']`).value || "data";
        const target = el.querySelector(`input[name='${key}-folder']`).value || "";
        if (!target) {
          ui.notifications?.warn("请先设置该分类的文件夹，再上传文件。");
          return;
        }
        const fp = new (FP())({
          type: "imagevideo",
          upload: true,
          current: target,
          callback: async (path) => {
            ui.notifications?.info(`已上传：${path}`);
          }
        });
        fp.render(true);
        fp.activeSource = source;
      });
    });
  }
}

/* ============================
   文件与播放工具
============================ */
async function listAllWebms(root, source = "data") {
  if (!root) return [];
  try {
    const visited = new Set();
    const out = [];
    async function walk(path) {
      const key = `${source}:${path}`;
      if (visited.has(key)) return;
      visited.add(key);
      const resp = await FP().browse(source, path);
      for (const file of resp.files) {
        if (WEBM_RE.test(file)) out.push(file);
      }
      for (const dir of resp.dirs) {
        await walk(dir);
      }
    }
    await walk(root);
    return out;
  } catch (err) {
    console.error(err);
    ui.notifications?.warn(`无法浏览文件夹：${root}`);
    return [];
  }
}

// 安全调用器（方法存在才调用，失败不抛错）
function chainCall(obj, method, ...args) {
  try {
    if (obj && typeof obj[method] === "function") {
      const ret = obj[method](...args);
      return ret ?? obj;
    }
  } catch (e) {
    console.warn(`[${MODULE_ID}] 调用 ${method} 失败:`, e);
  }
  return obj;
}

async function playFullscreen(filePath, { source = "data" } = {}) {
  const opts = game.settings.get(MODULE_ID, "playOptions") || {};
  if (opts.clearBeforePlay) {
    await clearSequencerEffects();
  }

  // 没有场景时直接提示（避免 Sequencer 报错）
  const hasCanvas = !!canvas?.scene && !!canvas?.dimensions;
  if (!hasCanvas && typeof Sequence !== "function") {
    ui.notifications?.error("当前没有已加载的场景，且 Sequencer 不可用，无法播放。");
    return;
  }

  const seq = new Sequence();
  let e = seq.effect()
    .file(filePath)
    .name(EFFECT_TAG)
    .persist(true);

  // 循环播放（版本支持时）
  e = chainCall(e, "loop", true);

  // 淡入淡出
  e = chainCall(e, "fadeIn", opts.fadeIn ?? 250);
  e = chainCall(e, "fadeOut", opts.fadeOut ?? 400);

  // 1) 优先尝试 fullscreen/screenSpace
  let placed = false;
  if (typeof e.fullscreen === "function") {
    try { e = e.fullscreen(true); placed = true; } catch {}
  }
  if (!placed && typeof e.screenSpace === "function") {
    try { e = e.screenSpace(true); placed = true; } catch {}
  }

  // 2) 始终提供画布位置兜底（世界坐标中心）
  const center = canvas?.dimensions?.center;
  if (center && typeof e.atLocation === "function") {
    try { e = e.atLocation(center); placed = true; } catch {}
  }

  // 3) 若之前进入了 screenSpace，则尽量撑满屏幕
  if (typeof e.size === "function") {
    try { e = e.size({ width: window.innerWidth, height: window.innerHeight }); } catch {}
  }
  e = chainCall(e, "anchor", { x: 0.5, y: 0.5 });
  e = chainCall(e, "zIndex", 1000);

  if (!placed) {
    ui.notifications?.error("未能确定播放位置，请确认已加载一个场景，或升级 Sequencer 以支持 screenSpace/fullscreen。");
    return;
  }

  try {
    await seq.play();
  } catch (err) {
    console.error("Sequencer 播放失败：", err);
    ui.notifications?.error("播放失败，请检查文件路径与 Sequencer 模块。");
  }
}

async function clearSequencerEffects() {
  try {
    if (Sequencer?.EffectManager?.endAllEffects) {
      await Sequencer.EffectManager.endAllEffects();
    } else if (Sequencer?.EffectManager?.endEffects) {
      await Sequencer.EffectManager.endEffects({ name: EFFECT_TAG });
    } else {
      await canvas?.sequencer?.endEffects?.({ name: EFFECT_TAG });
    }
    ui.notifications?.info("已清除所有 Sequencer 动画。");
  } catch (err) {
    console.warn("清除动画失败，尝试使用名称筛选回退。", err);
    try {
      await Sequencer.EffectManager.endEffects({ name: EFFECT_TAG });
      ui.notifications?.info("已清除本模块触发的动画。");
    } catch (e2) {
      console.error(e2);
      ui.notifications?.warn("未能清除动画，请检查 Sequencer 版本或控制台错误。");
    }
  }
}

/* ============================
   收藏夹工具
============================ */
function getFavorites() {
  return foundry.utils.duplicate(game.settings.get(MODULE_ID, "favorites") || {});
}
async function setFavorites(obj) {
  await game.settings.set(MODULE_ID, "favorites", obj);
}

function createFavorite(name) {
  const fav = getFavorites();
  if (!fav[name]) fav[name] = [];
  return setFavorites(fav);
}

function renameFavorite(oldName, newName) {
  const fav = getFavorites();
  if (!fav[oldName]) return;
  if (fav[newName]) {
    ui.notifications?.warn("已存在同名收藏夹。");
    return;
  }
  fav[newName] = fav[oldName];
  delete fav[oldName];
  return setFavorites(fav);
}

function deleteFavorite(name) {
  const fav = getFavorites();
  delete fav[name];
  return setFavorites(fav);
}

function addToFavorite(name, path) {
  const fav = getFavorites();
  if (!fav[name]) fav[name] = [];
  if (!fav[name].includes(path)) fav[name].push(path);
  return setFavorites(fav);
}

function removeFromFavorite(name, path) {
  const fav = getFavorites();
  if (!fav[name]) return;
  fav[name] = fav[name].filter(p => p !== path);
  return setFavorites(fav);
}

/* ============================
   分类工具
============================ */
async function addFileToCategory(key, filePath) {
  const cats = foundry.utils.duplicate(game.settings.get(MODULE_ID, "categories") ?? defaultCategories());
  if (!cats[key]) return;
  if (!Array.isArray(cats[key].extraFiles)) cats[key].extraFiles = [];
  if (!Array.isArray(cats[key].hiddenFiles)) cats[key].hiddenFiles = [];
  // 添加时，如路径此前被隐藏，则移除隐藏
  cats[key].hiddenFiles = cats[key].hiddenFiles.filter(p => p !== filePath);
  if (!cats[key].extraFiles.includes(filePath)) cats[key].extraFiles.push(filePath);
  await game.settings.set(MODULE_ID, "categories", cats);
}

// 移除逻辑：优先从 extraFiles 移除；否则写入 hiddenFiles
async function removeFromCategoryOrHide(key, filePath) {
  if (!game.user?.isGM) {
    ui.notifications?.warn("只有 GM 可以在全局范围移除/屏蔽文件。");
    return false;
  }
  const cats = foundry.utils.duplicate(game.settings.get(MODULE_ID, "categories") ?? defaultCategories());
  const cat = cats[key];
  if (!cat) return false;

  let changed = false;
  if (!Array.isArray(cat.extraFiles)) cat.extraFiles = [];
  if (!Array.isArray(cat.hiddenFiles)) cat.hiddenFiles = [];

  const before = cat.extraFiles.length;
  cat.extraFiles = cat.extraFiles.filter(p => p !== filePath);
  if (cat.extraFiles.length !== before) changed = true;

  if (!changed) {
    if (!cat.hiddenFiles.includes(filePath)) {
      cat.hiddenFiles.push(filePath);
      changed = true;
    }
  }

  if (changed) {
    await game.settings.set(MODULE_ID, "categories", cats);
    return true;
  }
  return false;
}

/* ============================
   工具函数
============================ */
function getCategoriesArray() {
  const cats = game.settings.get(MODULE_ID, "categories") ?? defaultCategories();
  return Object.keys(cats).slice(0, MAX_CATEGORIES).map((key, idx) => ({
    key,
    idx,
    name: cats[key]?.name || `分类${idx + 1}`,
    folder: cats[key]?.folder || "",
    source: cats[key]?.source || "data",
    extraFiles: Array.isArray(cats[key]?.extraFiles) ? cats[key].extraFiles : [],
    hiddenFiles: Array.isArray(cats[key]?.hiddenFiles) ? cats[key].hiddenFiles : []
  }));
}

function escapeHtml(s = "") {
  return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m]));
}
function escapeAttr(s = "") { return escapeHtml(s); }

async function promptString(title, label, initial = "") {
  return new Promise((resolve) => {
    let value = initial;
    const d = new Dialog({
      title,
      content: `<div class="fvtt-dialog"><label>${label}</label><input type="text" name="str" value="${escapeAttr(initial)}" style="width:100%"></div>`,
      buttons: {
        ok: {
          label: "确定",
          callback: (html) => {
            value = html[0].querySelector("input[name='str']")?.value?.trim();
            resolve(value || null);
          }
        },
        cancel: { label: "取消", callback: () => resolve(null) }
      },
      default: "ok"
    });
    d.render(true);
  });
}

// 预览视频状态（显示/隐藏图标）
function bindVideoState(video) {
  if (video._hasStateListeners) return;
  video._hasStateListeners = true;
  video.addEventListener("playing", () => {
    const thumb = video.closest(".thumb");
    thumb?.classList.add("playing");
  });
  video.addEventListener("pause", () => {
    const thumb = video.closest(".thumb");
    thumb?.classList.remove("playing");
  });
}

// 预加载预览视频：为所有条目设置 src 并加载 metadata（不自动播放）
function primePreviewsIn(rootEl) {
  if (!rootEl) return;
  const items = rootEl.querySelectorAll(".webm-item, .fav-file");
  for (const el of items) {
    const video = el.querySelector("video.preview");
    const path = el.dataset.path;
    if (!video || !path) continue;
    if (video.dataset.srcSet === "1") continue; // 避免重复设置
    video.src = path;
    video.preload = "metadata";
    try { video.load(); } catch(e) {}
    video.dataset.srcSet = "1";
  }
}