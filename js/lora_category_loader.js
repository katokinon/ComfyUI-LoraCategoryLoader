// 「LoRA分类加载」的两件事：
//   A. 折叠面板自定义界面（类别分组 / 同类互斥 / 多选 / 临时分类拖拽 / 搜索 / 强度快调）
//   B. 联动与菜单入口
//
// 界面只负责把选择写进隐藏的 selection widget（JSON），加载在后端 Python 里做。
// 原生下拉框会被隐藏但保留 —— 万一这个自定义组件在当前前端渲染失败，用户还能靠
// 下拉框干活（后端会自动回退）。

import { app } from "../../scripts/app.js";
import { invalidateLibrary, repairWidgetValues, sanitizeWidgetValues } from "./lora_prompt_picker.js";

const LOADER_CLASS = "LoraCategoryLoader";
const PICKER_CLASS = "LoraPromptPicker";
const WIDGET_PREFIX = "loracat_";
const SEL_WIDGET = "selection";
const NONE = "(不使用)";
const PANEL_URL = "/lora_category_loader";
const STATE_URL = "/lora_category_loader/api/state";
const TAG_URL = "/lora_category_loader/api/lora/tag";
const MAX_PANEL_HEIGHT = 420;

const LINE = "rgba(128,128,128,.28)";
const LINE_SOFT = "rgba(128,128,128,.18)";
const FILL = "rgba(128,128,128,.10)";

/* ------------------------------------------------------------------ */
/* 预设库                                                              */
/* ------------------------------------------------------------------ */

let _lib = null;
let _libTs = 0;
let _libPending = null;

async function fetchLibrary(force = false) {
  const now = Date.now();
  if (!force && _lib && now - _libTs < 4000) return _lib;
  if (_libPending) return _libPending;
  _libPending = fetch(STATE_URL)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
    .then((d) => {
      _lib = d;
      _libTs = Date.now();
      return d;
    })
    .catch((err) => {
      console.warn("[LoRA分类加载] 读取预设库失败：", err);
      return _lib || { categories: [], loras: [] };
    })
    .finally(() => {
      _libPending = null;
    });
  return _libPending;
}

function presetsOf(lib, name) {
  const e = (lib.loras || []).find((l) => l.name === name);
  return e ? e.presets || [] : [];
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const div = (css) => {
  const d = document.createElement("div");
  if (css) d.style.cssText = css;
  return d;
};
const span = (css, text) => {
  const s = document.createElement("span");
  if (css) s.style.cssText = css;
  if (text !== undefined) s.textContent = text;
  return s;
};
const button = (text, title, onClick, css = "") => {
  const b = document.createElement("button");
  b.textContent = text;
  if (title) b.title = title;
  b.style.cssText =
    "font-size:11px;padding:1px 7px;border-radius:6px;cursor:pointer;flex:none;" +
    "background:rgba(128,128,128,.15);border:1px solid rgba(128,128,128,.3);color:inherit;" +
    css;
  b.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onClick();
  };
  return b;
};

function mark(css, text) {
  return span(
    "flex:none;display:inline-flex;align-items:center;justify-content:center;" +
      "font-size:10px;line-height:1;" +
      css,
    text
  );
}

/* ------------------------------------------------------------------ */
/* 悬停预览浮窗                                                        */
/* ------------------------------------------------------------------ */

let _hoverTimer = null;
let _hoverEl = null;

function hideHoverPreview() {
  if (_hoverTimer) {
    clearTimeout(_hoverTimer);
    _hoverTimer = null;
  }
  if (_hoverEl) {
    _hoverEl.remove();
    _hoverEl = null;
  }
}

function showHoverPreview(url, anchor) {
  hideHoverPreview();
  _hoverTimer = setTimeout(() => {
    const box = document.createElement("div");
    box.style.cssText =
      "position:fixed;left:-99999px;top:0;z-index:100000;pointer-events:none;line-height:0;" +
      "background:#0d0f12;border:1px solid rgba(255,255,255,.28);border-radius:9px;" +
      "overflow:hidden;box-shadow:0 8px 28px rgba(0,0,0,.55);";

    const img = document.createElement("img");
    img.src = url;
    img.style.cssText = "display:block;max-width:240px;max-height:240px;";
    box.appendChild(img);
    document.body.appendChild(box);

    const place = () => {
      const r = box.getBoundingClientRect();
      let x = anchor.right + 12;
      let y = anchor.top - 4;
      if (x + r.width > window.innerWidth - 10) x = anchor.left - r.width - 12;
      if (x < 10) x = 10;
      if (y + r.height > window.innerHeight - 10) y = window.innerHeight - r.height - 10;
      if (y < 10) y = 10;
      box.style.left = Math.round(x) + "px";
      box.style.top = Math.round(y) + "px";
    };

    if (img.complete && img.naturalWidth) place();
    else img.onload = place;
    img.onerror = () => hideHoverPreview();
    _hoverEl = box;
  }, 220);
}

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

function emptyState() {
  return { ui: true, v: 2, on: [], temps: [], strength: {}, folder: "" };
}

function selWidget(node) {
  return (node.widgets || []).find((w) => w.name === SEL_WIDGET);
}

// v1（cats 分桶）-> v2（on 全局启用列表）。
// 一个 LoRA 现在可以同时挂在多个类别里，勾选是全局状态，所以在多个类别里会联动。
function normalizeState(d) {
  const st = emptyState();
  st.temps = Array.isArray(d.temps) ? d.temps.filter((t) => t && typeof t === "object") : [];
  st.strength = d.strength && typeof d.strength === "object" ? d.strength : {};
  st.folder = typeof d.folder === "string" ? d.folder : "";

  const push = (n) => {
    if (typeof n === "string" && n && !st.on.includes(n)) st.on.push(n);
  };

  if (Array.isArray(d.on)) {
    d.on.forEach(push);
  } else {
    // 旧格式：类别分桶 + 临时分类里的，全都算「启用」
    const cats = d.cats && typeof d.cats === "object" ? d.cats : {};
    for (const list of Object.values(cats)) if (Array.isArray(list)) list.forEach(push);
    for (const t of st.temps) (t.loras || []).forEach(push);
  }
  for (const t of st.temps) t.loras = (t.loras || []).filter((n) => typeof n === "string");
  return st;
}

function readState(node) {
  const w = selWidget(node);
  if (w && typeof w.value === "string" && w.value.trim() && w.value.trim() !== "{}") {
    try {
      const d = JSON.parse(w.value);
      if (d && typeof d === "object" && d.ui) return normalizeState(d);
    } catch (e) {
      /* 落到下拉框初始化 */
    }
  }

  // 降级通路：用原生下拉框的当前值当作初始状态
  const st = emptyState();
  for (const w2 of node.widgets || []) {
    if (typeof w2.name === "string" && w2.name.startsWith(WIDGET_PREFIX)) {
      if (w2.value && w2.value !== NONE && !st.on.includes(w2.value)) st.on.push(w2.value);
    }
  }
  return st;
}

function membersOf(cid) {
  return (_lib && _lib.loras ? _lib.loras : [])
    .filter((l) => (l.categories || []).includes(cid))
    .map((l) => l.name);
}

function syncCombos(node, st) {
  node.__syncing = true;
  try {
    for (const w of node.widgets || []) {
      if (typeof w.name !== "string" || !w.name.startsWith(WIDGET_PREFIX)) continue;
      const cid = w.name.slice(WIDGET_PREFIX.length);
      const values = comboValues(w);
      // 下拉框只是降级通路：多选类别一个框装不下，这里只能镜像第一个，
      // 真正生效的始终是 selection。拿不到选项列表就干脆不动它。
      if (!values) continue;
      const first = membersOf(cid).find((n) => st.on.includes(n));
      w.value = first && values.includes(first) ? first : NONE;
    }
  } catch (e) {
    /* 降级通路同步失败不影响主通路 */
  } finally {
    node.__syncing = false;
  }
}

function comboValues(w) {
  let v = w && w.options ? w.options.values : null;
  try {
    if (typeof v === "function") v = v(w);
  } catch (e) {
    return null;
  }
  return Array.isArray(v) ? v : null;
}

function writeState(node, st, rerender = true) {
  const w = selWidget(node);
  if (w) w.value = JSON.stringify(st);
  syncCombos(node, st);
  notifyPickers();
  if (rerender) render(node);
}

function enabledCount(st) {
  return (st.on || []).length;
}

/* ------------------------------------------------------------------ */
/* 拖拽（自己实现，不用浏览器原生 DnD）                                 */
/*                                                                     */
/* 原生 HTML5 拖拽在 ComfyUI 的画布上很不可靠：实测真实鼠标拖动时        */
/* dragstart 之后立刻 dragend，目标上的 drop 永远不触发。所以改用         */
/* pointer 事件自己跟踪，落到哪儿由 elementFromPoint 判定。              */
/* ------------------------------------------------------------------ */

let _drag = null;
let _dragGhost = null;
let _lastDragEnd = 0;
let _edgeTimer = null;
let _edgeDir = 0;

function stopEdgeScroll() {
  if (_edgeTimer) {
    clearInterval(_edgeTimer);
    _edgeTimer = null;
  }
  _edgeDir = 0;
}

// 拖到面板上下边缘时自动滚动 —— 否则目标分类要是滚出了可视区，就永远拖不到
function updateEdgeScroll(root, y) {
  if (!root) return;
  const rr = root.getBoundingClientRect();
  const EDGE = 32;
  let dir = 0;
  if (y < rr.top + EDGE) dir = -1;
  else if (y > rr.bottom - EDGE) dir = 1;

  _edgeDir = dir;
  if (!dir) {
    stopEdgeScroll();
    return;
  }
  if (!_edgeTimer) {
    _edgeTimer = setInterval(() => {
      if (!_drag || !_drag.active || !_edgeDir) {
        stopEdgeScroll();
        return;
      }
      root.scrollTop += _edgeDir * 12;
    }, 30);
  }
}

function sectionUnder(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el || typeof el.closest !== "function") return null;
  const sec = el.closest("[data-drop-kind]");
  if (!sec) return null;
  return { el: sec, kind: sec.dataset.dropKind, id: sec.dataset.dropId };
}

function dimSection(hit, on) {
  if (!hit) return;
  hit.el.style.borderColor = on ? "rgba(120,170,255,.95)" : LINE;
  hit.el.style.background = on ? "rgba(90,150,255,.09)" : "";
}

function clearDragVisuals() {
  if (_drag && _drag.hover) {
    dimSection(_drag.hover, false);
    _drag.hover = null;
  }
  if (_drag && _drag.el) {
    dimSection(_drag.el, false);
    _drag.el = null;
  }
}

function moveGhost(x, y) {
  if (!_dragGhost) return;
  _dragGhost.style.left = Math.round(x + 12) + "px";
  _dragGhost.style.top = Math.round(y + 12) + "px";
}

function beginPointerDrag(node, st, loraName, ev) {
  if (ev.button !== 0) return;
  const tag = ev.target && ev.target.tagName;
  if (tag === "INPUT" || tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA") return;

  const startX = ev.clientX;
  const startY = ev.clientY;
  _drag = { name: loraName, startX, startY, active: false, hover: null, el: null };

  const onMove = (e) => {
    if (!_drag) return;
    const dx = e.clientX - _drag.startX;
    const dy = e.clientY - _drag.startY;
    if (!_drag.active) {
      if (Math.hypot(dx, dy) < 6) return;
      _drag.active = true;
      hideHoverPreview();
      // 双保险：万一某些情况下还是起了选区，进入拖拽时清掉
      const sel = window.getSelection();
      if (sel && sel.rangeCount) sel.removeAllRanges();
      _dragGhost = document.createElement("div");
      _dragGhost.textContent = loraName.split("/").pop();
      _dragGhost.style.cssText =
        "position:fixed;z-index:100001;pointer-events:none;max-width:220px;" +
        "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;" +
        "padding:3px 8px;border-radius:6px;background:rgba(30,36,48,.95);color:#e8eefc;" +
        "border:1px solid rgba(120,170,255,.7);box-shadow:0 4px 16px rgba(0,0,0,.5);";
      document.body.appendChild(_dragGhost);
      document.body.style.cursor = "grabbing";
    }
    e.preventDefault();
    e.stopPropagation();
    moveGhost(e.clientX, e.clientY);
    updateEdgeScroll(node.__catUI, e.clientY);

    const hit = sectionUnder(e.clientX, e.clientY);
    if (_drag.hover && (!hit || hit.el !== _drag.hover.el)) {
      dimSection(_drag.hover, false);
      _drag.hover = null;
    }
    if (hit && (!_drag.hover || hit.el !== _drag.hover.el)) {
      dimSection(hit, true);
      _drag.hover = hit;
    }
  };

  const onUp = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onUp, true);

    const wasActive = !!(_drag && _drag.active);
    const target = _drag ? _drag.hover : null;
    const grabbed = _drag ? _drag.name : null;

    stopEdgeScroll();
    clearDragVisuals();
    if (_dragGhost) {
      _dragGhost.remove();
      _dragGhost = null;
    }
    document.body.style.cursor = "";
    _drag = null;

    if (wasActive) {
      _lastDragEnd = Date.now();
      if (target && grabbed) dropOn(node, st, target, grabbed);
    }
  };

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onUp, true);
}

function justDragged() {
  return Date.now() - _lastDragEnd < 350;
}

// 拖拽落地：拖到类别 = 给这个 LoRA 加一个类别标签（写回全局库）；
// 拖到临时分类 = 加进这个工作流的临时候（不改变类别标签）。
function dropOn(node, st, target, name) {
  if (target.kind === "cat") {
    const cat = (node.__cats || []).find((c) => c.id === target.id);
    if (cat) addCategoryTag(node, st, cat, name);
  } else {
    const t = st.temps.find((x) => x.id === target.id);
    if (t) addToTemp(node, st, t, name);
  }
}

/* ------------------------------------------------------------------ */
/* 交互动作                                                            */
/* ------------------------------------------------------------------ */

async function postJSON(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

// 勾选是**全局**的：同一个 LoRA 挂在多个类别里时，勾一处、处处联动。
// 单选（exclusive）类别的互斥范围只到「它自己」：勾新的会把同类别里原来那些关掉；
// 被关掉的那个如果还挂在别的类别下，也会一起变成未勾选 —— 因为启用状态只有一份。
function toggleLora(node, st, cat, name) {
  if ((st.on || []).includes(name)) {
    st.on = st.on.filter((n) => n !== name);
  } else {
    if (cat && cat.mode !== "multi") {
      const siblings = new Set(membersOf(cat.id));
      st.on = (st.on || []).filter((n) => n === name || !siblings.has(n));
    }
    st.on = [...(st.on || []), name];
  }
  writeState(node, st);
}

// 拖到类别上 = 给这个 LoRA **加**一个类别标签（写回全局库，跟着工作流走的是勾选状态）
async function addCategoryTag(node, st, cat, name) {
  try {
    await postJSON(TAG_URL, { name, add: cat.id });
    invalidateLibrary();
    render(node);
  } catch (err) {
    console.warn("[LoRA分类加载] 加类别标签失败：", err);
  }
}

async function removeCategoryTag(node, st, cat, name) {
  try {
    await postJSON(TAG_URL, { name, remove: cat.id });
    invalidateLibrary();
    render(node);
  } catch (err) {
    console.warn("[LoRA分类加载] 去类别标签失败：", err);
  }
}

function addToTemp(node, st, temp, name) {
  // 临时分类是「这一张图想临时凑几个一起上」的地方 —— 拖进来顺手就启用，
  // 不然拖进去了却什么都没发生，很容易让人以为坏了。
  if (!(temp.loras || []).includes(name)) temp.loras = [...(temp.loras || []), name];
  if (!(st.on || []).includes(name)) st.on = [...(st.on || []), name];
  writeState(node, st);
}

function removeFromTemp(node, st, temp, name) {
  temp.loras = (temp.loras || []).filter((n) => n !== name);
  writeState(node, st);
}

function setStrength(node, st, name, value) {
  st.strength[name] = { model: value };
  writeState(node, st, false);
}

function clampStrength(v) {
  if (!Number.isFinite(v)) return 1;
  return Math.max(0, Math.min(4, Math.round(v * 100) / 100));
}

// 强度控件：一个够大的数字框 + 按住左右拖。
//
// 拖动是自己用 pointer 事件做的（画布上没法用原生 range）。关键有两点：
// ① `pointerdown` 必须 stopPropagation，否则冒泡到行上会触发「拖到别的分类」；
// ② 用 setPointerCapture，这样指针滑出输入框后事件仍然回来。
function strengthBox(node, st, lora) {
  const cur = st.strength[lora.name] || {};
  const shown = cur.model !== undefined ? cur.model : lora.model_strength;

  const inp = document.createElement("input");
  inp.type = "number";
  inp.step = "0.05";
  inp.min = "0";
  inp.max = "4";
  inp.value = shown;
  inp.title = "LoRA 强度：可以直接输入，也可以按住左右拖动（只影响当前工作流）";
  // 宽度用 flex-basis 一起定住：ComfyUI 的全局样式里有 input{width:100%} 之类的规则，
  // 只写 width 会被压回去，框太小就不好点、也不好拖。
  inp.style.cssText =
    "box-sizing:border-box;flex:0 0 92px;width:92px;min-width:92px;" +
    "font-size:12px;padding:3px 6px;border-radius:6px;text-align:center;cursor:ew-resize;" +
    // 输入框里还是得能选文字、能打字，把继承下来的 user-select:none 顶回去
    "user-select:text;-webkit-user-select:text;" +
    "background:rgba(128,128,128,.12);border:1px solid " + LINE + ";color:inherit;outline:none;";
  inp.onclick = (ev) => ev.stopPropagation();
  inp.onchange = () => {
    const v = parseFloat(inp.value);
    if (!Number.isNaN(v)) setStrength(node, st, lora.name, clampStrength(v));
  };

  let drag = null;
  inp.onpointerdown = (ev) => {
    ev.stopPropagation();
    if (ev.button !== 0) return;
    try {
      inp.setPointerCapture(ev.pointerId);
    } catch (e) {
      /* 拿不到捕获也能用，只是拖出框就不跟手了 */
    }
    drag = { x: ev.clientX, start: parseFloat(inp.value) || 0, moved: false };
  };
  inp.onpointermove = (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x;
    if (!drag.moved) {
      if (Math.abs(dx) < 3) return; // 几像素的抖动还算点击
      drag.moved = true;
      window.getSelection?.()?.removeAllRanges(); // 拖动时别把页面文字刷成选中
    }
    ev.preventDefault();
    // 横向 100px = 1.0 强度
    inp.value = clampStrength(drag.start + dx * 0.01).toFixed(2);
  };
  const finish = () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (!moved) return;
    const v = parseFloat(inp.value);
    if (!Number.isNaN(v)) setStrength(node, st, lora.name, clampStrength(v));
  };
  inp.onpointerup = finish;
  inp.onpointercancel = finish;
  inp.onlostpointercapture = finish;
  return inp;
}

function clearCat(node, st, cat) {
  const members = new Set(membersOf(cat.id));
  st.on = (st.on || []).filter((n) => !members.has(n));
  writeState(node, st);
}

function clearTemp(node, st, temp) {
  temp.loras = [];
  writeState(node, st);
}

function clearAll(node, st) {
  st.on = [];
  st.temps = [];
  writeState(node, st);
}

function createTemp(node, st, name) {
  const clean = (name || "").trim() || `临时分类 ${st.temps.length + 1}`;
  st.temps.push({ id: `t${Math.random().toString(16).slice(2, 8)}`, name: clean, loras: [] });
  writeState(node, st);
}

function deleteTemp(node, st, temp) {
  st.temps = st.temps.filter((t) => t.id !== temp.id);
  writeState(node, st);
}

function renameTemp(node, st, temp, name) {
  temp.name = (name || "").trim() || temp.name;
  writeState(node, st, false);
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

async function render(node) {
  const root = node.__catUI;
  if (!root) return;

  const token = (node.__catToken || 0) + 1;
  node.__catToken = token;

  const scrollTop = root.scrollTop;
  hideHoverPreview();
  const st = node.__st || (node.__st = readState(node));
  const lib = await fetchLibrary();
  if (token !== node.__catToken) return;

  const cats = lib.categories || [];
  node.__cats = cats;
  const filter = (node.__filter || "").trim().toLowerCase();
  const collapsed = node.__collapsed || (node.__collapsed = {});

  root.innerHTML = "";

  /* ---- 工具条：搜索 + 子文件夹过滤 ---- */
  const bar = div("display:flex;align-items:center;gap:5px;flex:none;");
  const search = document.createElement("input");
  search.type = "text";
  search.placeholder = "搜索 LoRA…";
  search.value = node.__filter || "";
  search.style.cssText =
    "flex:1;min-width:0;font-size:11px;padding:3px 7px;border-radius:6px;" +
    "background:rgba(128,128,128,.12);border:1px solid " + LINE + ";color:inherit;outline:none;";
  search.oninput = () => {
    clearTimeout(search._t);
    search._t = setTimeout(() => {
      node.__filter = search.value;
      render(node);
    }, 150);
  };
  bar.appendChild(search);

  // 只显示某个子文件夹里的 LoRA —— 按主模型分文件夹的人用这个把面板收窄。
  // 选择存在工作流里（selection 的 folder 字段），所以不同的工作流各自记各自。
  // 只要有 LoRA 落在子文件夹里就显示这个控件（全是根目录时它没有意义）。
  const named = (lib.folders || []).filter((f) => f !== "");
  if (named.length) {
    const pick = document.createElement("select");
    pick.title = "只显示某个子文件夹里的 LoRA（这个选择跟着当前工作流走）";
    pick.style.cssText =
      "flex:none;max-width:120px;font-size:11px;padding:3px 4px;border-radius:6px;" +
      "background:rgba(128,128,128,.12);border:1px solid " + LINE + ";color:inherit;outline:none;";
    const addOpt = (val, label) => {
      const o = document.createElement("option");
      o.value = val;
      o.textContent = label;
      pick.appendChild(o);
    };
    addOpt("*", "全部文件夹");
    for (const f of named) addOpt(f, f);
    if ((lib.folders || []).includes("")) addOpt("", "（根目录）");
    const valid = st.folder === "*" || (lib.folders || []).includes(st.folder);
    pick.value = valid ? st.folder : "*";
    pick.onchange = () => {
      st.folder = pick.value;
      writeState(node, st);
    };
    bar.appendChild(pick);
  }

  const summary = span("font-size:11px;opacity:.65;flex:none;", `启用 ${enabledCount(st)}`);
  const clearBtn = button("全清", "清空所有已启用的 LoRA", () => clearAll(node, st));
  const panelBtn = button("管理面板", "打开 LoRA 分类管理面板", () => window.open(PANEL_URL, "_blank"));
  bar.append(summary, clearBtn, panelBtn);
  root.appendChild(bar);

  /* ---- 没接 model：明确告诉用户「现在不会真的加载」 ---- */
  const missingInputs = missingSourceInputs(node);
  if (missingInputs.length) {
    const warn = div(
      "flex:none;font-size:11px;line-height:1.5;padding:4px 7px;border-radius:6px;" +
        "background:rgba(217,131,36,.13);border:1px solid rgba(217,131,36,.45);color:#d98324;"
    );
    warn.textContent =
      "未接 model —— 勾选只会写出名称与语法，不会真的加载 LoRA。" +
      "要让 LoRA 生效，请把基础模型接到左边的 model 输入。";
    warn.dataset.bareHint = "1";
    root.appendChild(warn);
  }

  /* ---- 类别 ---- */
  if (!cats.length) {
    root.appendChild(hint("还没有任何类别。先去管理面板建一个。"));
  }

  const folderActive = !!st.folder && st.folder !== "*";
  for (const cat of cats) {
    const sec = categorySection(node, st, cat, lib, filter, collapsed);
    if (sec) root.appendChild(sec);
  }

  /* ---- 临时分类 ---- */
  const tempWrap = div(`border:1px dashed ${LINE};border-radius:8px;flex:none;margin-top:2px;`);
  const tempHead = div("display:flex;align-items:center;gap:6px;padding:5px 8px;");
  tempHead.append(
    span("font-size:12px;font-weight:600;", "临时分类"),
    span("font-size:10px;opacity:.55;", "只存在当前工作流"),
    span("flex:1")
  );
  tempWrap.appendChild(tempHead);

  const creator = div("display:flex;gap:5px;padding:0 8px 7px;");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "输入名字，回车新建";
  nameInput.style.cssText =
    "flex:1;min-width:0;font-size:11px;padding:3px 7px;border-radius:6px;" +
    "background:rgba(128,128,128,.12);border:1px solid " + LINE + ";color:inherit;outline:none;";
  nameInput.onkeydown = (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      createTemp(node, st, nameInput.value);
    }
  };
  creator.append(
    nameInput,
    button("＋ 新建", "新建一个只属于当前工作流的临时分类", () => createTemp(node, st, nameInput.value))
  );
  tempWrap.appendChild(creator);

  if (!st.temps.length) {
    const empty = div("padding:0 8px 8px;font-size:11px;opacity:.5;");
    empty.textContent = "建好后，把上面任意 LoRA 拖进来即可 —— 拖进来会顺手启用它，但不改变它的类别标签。";
    tempWrap.appendChild(empty);
  }

  for (const temp of st.temps) {
    tempWrap.appendChild(tempBlock(node, st, temp, lib, collapsed, filter));
  }
  root.appendChild(tempWrap);

  root.scrollTop = scrollTop;
  resize(node);
}

function hint(text) {
  const d = div("font-size:11px;opacity:.65;line-height:1.5;padding:4px 2px;");
  d.textContent = text;
  return d;
}

// 没接 model 时节点只会输出名称与语法，不加载任何东西。
// 光靠日志说没人看得见 —— 界面上必须讲清楚，否则就是「勾了、强度也调了，毫无反应」。
function missingSourceInputs(node) {
  const inp = (node.inputs || []).find((i) => i.name === "model");
  return inp && inp.link != null ? [] : ["model"];
}

function matchesFolder(lora, folder) {
  if (!folder || folder === "*") return true;
  return (lora.top_folder || "") === folder;
}

function categorySection(node, st, cat, lib, filter, collapsed) {
  const isMulti = cat.mode === "multi";
  const members = (lib.loras || []).filter((l) => (l.categories || []).includes(cat.id));
  const all = members.filter((l) => matchesFolder(l, st.folder));
  const folderActive = !!st.folder && st.folder !== "*";

  // 文件夹过滤开着时，把被过滤干净的类别收起来 —— 否则面板一半都是空壳
  if (folderActive && !all.length) return null;

  const onCount = all.filter((l) => (st.on || []).includes(l.name)).length;

  const sec = div(`border:1px solid ${LINE};border-radius:8px;flex:none;margin-bottom:5px;`);
  sec.dataset.dropKind = "cat";
  sec.dataset.dropId = cat.id;

  /* 标题 */
  const head = div(
    "display:flex;align-items:center;gap:6px;padding:5px 8px;cursor:pointer;background:" + FILL + ";"
  );
  const isCollapsed = !!collapsed[cat.id];
  head.append(
    span("font-size:10px;opacity:.6;flex:none;", isCollapsed ? "\u25B8" : "\u25BE"),
    span("font-size:12px;font-weight:600;", cat.name),
    span(
      "font-size:10px;padding:0 6px;border-radius:99px;border:1px solid " + LINE + ";opacity:.75;flex:none;",
      isMulti ? "多选" : "单选"
    ),
    span("flex:1"),
    span("font-size:11px;opacity:.65;flex:none;", `${onCount}/${all.length}`)
  );
  if (onCount) {
    head.appendChild(button("清空", "取消这个类别里的全部勾选", () => clearCat(node, st, cat)));
  }
  head.onclick = () => {
    collapsed[cat.id] = !isCollapsed;
    render(node);
  };

  sec.appendChild(head);

  if (isCollapsed) return sec;

  /* 列表 */
  const visible = all.filter((l) => {
    if (!filter) return true;
    return l.name.toLowerCase().includes(filter) || (l.display || "").toLowerCase().includes(filter);
  });

  if (!all.length) {
    sec.appendChild(
      hint(
        folderActive
          ? "这个类别在当前文件夹里没有 LoRA。"
          : "这个类别还没有 LoRA。去管理面板把 LoRA 归到这一类，或把 LoRA 拖到这一栏。"
      )
    );
    return sec;
  }
  if (!visible.length) {
    sec.appendChild(hint("没有匹配的 LoRA。"));
    return sec;
  }

  for (const lora of visible) {
    sec.appendChild(loraRow(node, st, cat, lora, lib, (st.on || []).includes(lora.name)));
  }
  return sec;
}

function loraRow(node, st, cat, lora, lib, on) {
  const isMulti = cat.mode === "multi";
  const row = div(
    "display:flex;align-items:center;gap:6px;padding:3px 8px;" +
      "user-select:none;-webkit-user-select:none;" +
      (on ? "background:rgba(90,150,255,.10);" : "")
  );
  row.dataset.lora = lora.name;
  row.style.cursor = "grab";

  const box = isMulti ? "border-radius:4px;" : "border-radius:50%;";
  const inner = on
    ? `${box}background:#5b9dff;border:1px solid #5b9dff;color:#fff;`
    : `${box}border:1px solid rgba(128,128,128,.6);`;
  row.appendChild(mark(`width:13px;height:13px;${inner}`, on ? "\u2713" : ""));

  const nm = span("flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;");
  nm.textContent = lora.display || lora.name;
  nm.title = lora.name;
  row.appendChild(nm);

  // 还挂在别的类别里 —— 勾选会联动，这里给个提示
  const others = (lora.categories || []).filter((cid) => cid !== cat.id);
  if (others.length) {
    const names = others
      .map((cid) => ((lib.categories || []).find((c) => c.id === cid) || {}).name)
      .filter(Boolean);
    if (names.length) {
      const tag = mark(
        "padding:0 5px;border-radius:99px;font-size:9px;" +
          "border:1px solid rgba(120,170,255,.5);color:rgba(150,190,255,.95);",
        `+${names.length}`
      );
      tag.title = "这个 LoRA 还挂在：" + names.join("、") + "（勾选状态是联动的）";
      row.appendChild(tag);
    }
  }

  const presetCount = presetsOf(lib, lora.name).length;
  if (presetCount) {
    row.appendChild(span("font-size:10px;opacity:.5;flex:none;", `${presetCount} 预设`));
  }

  if (lora.preview) {
    const dot = mark(
      "width:11px;height:11px;border-radius:3px;font-size:8px;" +
        "border:1px solid rgba(120,170,255,.7);color:rgba(150,190,255,.95);",
      "\u25A3"
    );
    dot.title = "有预览图，鼠标悬停查看";
    row.appendChild(dot);
    const url =
      lora.preview + (lora.preview.includes("?") ? "&" : "?") + "v=" + (lora.preview_ver || 0);
    row.onmouseenter = () => showHoverPreview(url, row.getBoundingClientRect());
    row.onmouseleave = () => hideHoverPreview();
  }

  if (on) {
    row.appendChild(strengthBox(node, st, lora));
  }

  // 摘掉「本类别」这个标签。默认类别是兜底，摘了也会立刻回来，所以不给按钮。
  const cats = lora.categories || [];
  const canRemove = !(cats.length === 1 && cats[0] === (lib.default_category || "default"));
  if (canRemove) {
    const rm = mark(
      "width:14px;height:14px;border-radius:4px;font-size:9px;opacity:.35;border:1px solid " + LINE,
      "\u2715"
    );
    rm.title = `把「${cat.name}」这个标签从这个 LoRA 上摘掉（不改变勾选）`;
    rm.style.cursor = "pointer";
    rm.onpointerdown = (ev) => ev.stopPropagation();
    rm.onmouseenter = () => (rm.style.opacity = ".9");
    rm.onmouseleave = () => (rm.style.opacity = ".35");
    rm.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      removeCategoryTag(node, st, cat, lora.name);
    };
    row.appendChild(rm);
  }

  row.onpointerdown = (ev) => beginPointerDrag(node, st, lora.name, ev);
  row.onclick = () => {
    if (justDragged()) return; // 刚拖过就别再当成点击
    hideHoverPreview();
    toggleLora(node, st, cat, lora.name);
  };
  return row;
}

function tempBlock(node, st, temp, lib, collapsed, filter) {
  const loras = temp.loras || [];
  const isCollapsed = !!collapsed["temp:" + temp.id];
  const sec = div(`border:1px solid ${LINE};border-radius:8px;margin:0 8px 7px;`);
  sec.dataset.dropKind = "temp";
  sec.dataset.dropId = temp.id;

  const head = div("display:flex;align-items:center;gap:6px;padding:4px 8px;background:" + FILL);
  head.append(
    span("font-size:10px;opacity:.6;flex:none;", isCollapsed ? "\u25B8" : "\u25BE"),
    span("font-size:11px;font-weight:600;flex:1;", temp.name),
    span("font-size:10px;opacity:.6;flex:none;", String(loras.length))
  );
  if (loras.length) {
    head.appendChild(button("清空", "移出全部 LoRA", () => clearTemp(node, st, temp)));
  }
  const del = button("\u2715", "删除这个临时分类（只影响当前工作流）", () => deleteTemp(node, st, temp), "color:#e26a6a;");
  del.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    deleteTemp(node, st, temp);
  };
  head.appendChild(del);
  head.onclick = () => {
    collapsed["temp:" + temp.id] = !isCollapsed;
    render(node);
  };

  sec.appendChild(head);

  if (isCollapsed) return sec;

  if (!loras.length) {
    sec.appendChild(hint("把上面的 LoRA 拖到这里。它只是一个额外的显示位置，不会改变 LoRA 的类别标签。"));
    return sec;
  }

  const visible = loras.filter((n) => !filter || n.toLowerCase().includes(filter));
  if (!visible.length) {
    sec.appendChild(hint("没有匹配的 LoRA。"));
    return sec;
  }

  for (const name of visible) {
    const lora = (lib.loras || []).find((l) => l.name === name);
    const on = (st.on || []).includes(name);
    const row = div(
      "display:flex;align-items:center;gap:6px;padding:3px 8px;cursor:pointer;" +
        "user-select:none;-webkit-user-select:none;" +
        (on ? "background:rgba(90,150,255,.10);" : "")
    );
    row.appendChild(
      mark(
        `width:13px;height:13px;border-radius:4px;${
          on ? "background:#5b9dff;border:1px solid #5b9dff;color:#fff;" : "border:1px solid rgba(128,128,128,.6);"
        }`,
        on ? "\u2713" : ""
      )
    );
    const nm = span("flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;");
    nm.textContent = (lora && lora.display) || String(name).split("/").pop();
    nm.title = name;
    row.appendChild(nm);

    const rm = mark(
      "width:14px;height:14px;border-radius:4px;font-size:9px;opacity:.35;border:1px solid " + LINE,
      "\u2715"
    );
    rm.title = "从这个临时分类里移出（不改变勾选）";
    rm.style.cursor = "pointer";
    rm.onpointerdown = (ev) => ev.stopPropagation();
    rm.onmouseenter = () => (rm.style.opacity = ".9");
    rm.onmouseleave = () => (rm.style.opacity = ".35");
    rm.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      removeFromTemp(node, st, temp, name);
    };
    row.appendChild(rm);

    row.onpointerdown = (ev) => beginPointerDrag(node, st, name, ev);
    row.onclick = () => {
      if (justDragged()) return;
      hideHoverPreview();
      toggleLora(node, st, null, name);
    };
    sec.appendChild(row);
  }
  return sec;
}

function resize(node) {
  const root = node.__catUI;
  if (!root) return;
  const content = Math.min(root.scrollHeight, MAX_PANEL_HEIGHT + 40);
  const needed = content + 58;
  const width = Math.max(node.size?.[0] || 0, 330);
  if (!node.size || node.size[1] < needed) {
    node.setSize([width, needed]);
    app.graph?.setDirtyCanvas(true, true);
  }
}

/* ------------------------------------------------------------------ */
/* 装上界面                                                            */
/* ------------------------------------------------------------------ */

function installUI(node) {
  // 隐藏原生下拉框 + selection（保留它们作为降级通路）
  for (const w of node.widgets || []) {
    if (w.name === SEL_WIDGET) {
      w.computeSize = () => [0, -4];
    } else if (typeof w.name === "string" && w.name.startsWith(WIDGET_PREFIX)) {
      w.computeSize = () => [0, -4];
      w.hidden = true;
    }
  }

  const root = div(
    "display:flex;flex-direction:column;gap:2px;padding:2px;font-size:12px;color:inherit;" +
      // 拖拽是靠指针事件做的，不禁用文字选择的话拖动过程中会把 LoRA 名字刷成选中态
      "user-select:none;-webkit-user-select:none;" +
      `max-height:${MAX_PANEL_HEIGHT}px;overflow-y:auto;overflow-x:hidden;`
  );
  node.__catUI = root;
  node.__st = readState(node);

  if (typeof node.addDOMWidget === "function") {
    try {
      node.addDOMWidget("lora_category_panel", "div", root, { serialize: false, hideOnZoom: false });
    } catch (err) {
      console.warn("[LoRA分类加载] 折叠面板挂载失败，自动降级为下拉框：", err);
      restoreNative(node);
      return;
    }
  } else {
    console.warn("[LoRA分类加载] 当前前端不支持 addDOMWidget，降级为下拉框。");
    restoreNative(node);
    return;
  }

  node.__refreshPanel = () => render(node);
  root.addEventListener("scroll", hideHoverPreview, { passive: true });
  root.addEventListener("mouseleave", hideHoverPreview);
  render(node);
}

function restoreNative(node) {
  for (const w of node.widgets || []) {
    if (typeof w.name === "string" && w.name.startsWith(WIDGET_PREFIX)) {
      delete w.hidden;
      delete w.computeSize;
    }
  }
  const root = div("font-size:11px;opacity:.7;line-height:1.5;padding:4px 2px;");
  root.textContent = "折叠面板无法在当前前端渲染，已回退到下面的下拉框（功能完整，只是没有多选和临时分类）。";
  if (typeof node.addDOMWidget === "function") {
    try {
      node.addDOMWidget("lora_category_panel_fallback", "div", root, { serialize: false });
    } catch (e) {
      /* 忽略 */
    }
  }
  app.graph?.setDirtyCanvas(true, true);
}

/* ------------------------------------------------------------------ */
/* 联动 / 刷新节点定义 / 菜单入口                                      */
/* ------------------------------------------------------------------ */

function eachPicker(fn) {
  for (const n of app.graph?._nodes || []) {
    if (n.comfyClass === PICKER_CLASS || n.type === PICKER_CLASS) fn(n);
  }
}

export function notifyPickers(forceReload = false) {
  if (forceReload) invalidateLibrary();
  eachPicker((n) => n.__refreshPicker?.());
}

async function refreshNodeDefs() {
  try {
    const mod = await import("../../scripts/api.js");
    await mod.api.getNodeDefs();
    if (typeof app.refreshComboInNodes === "function") {
      await app.refreshComboInNodes();
    }
    return true;
  } catch (err) {
    console.warn("[LoRA分类加载] 自动刷新节点定义失败，请在页面上按 R 手动刷新。", err);
    return false;
  }
}

const MENU_SELECTORS = [".comfyui-menu", ".comfy-menu", "#comfyui-menu", ".comfyui-topbar"];

function injectMenuButton() {
  if (document.getElementById("lora-cat-panel-button")) return true;
  for (const sel of MENU_SELECTORS) {
    const host = document.querySelector(sel);
    if (!host) continue;
    const btn = document.createElement("button");
    btn.id = "lora-cat-panel-button";
    btn.title = "打开 LoRA 分类管理面板（新标签页）";
    btn.textContent = "LoRA 分类管理";
    btn.className = "comfyui-button";
    btn.style.cursor = "pointer";
    btn.onclick = () => window.open(PANEL_URL, "_blank");
    host.appendChild(btn);
    return true;
  }
  return false;
}

let menuTries = 0;
const menuTimer = setInterval(() => {
  if (injectMenuButton() || ++menuTries > 60) clearInterval(menuTimer);
}, 500);

// 切走标签页时别把浮窗留在屏幕上
window.addEventListener("blur", hideHoverPreview);

/* ------------------------------------------------------------------ */
/* 注册                                                                */
/* ------------------------------------------------------------------ */

app.registerExtension({
  name: "LoraCategoryLoader.LoaderUI",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== LOADER_CLASS) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      installUI(this);
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure?.apply(this, arguments);
      // 本节点现在没有 forceInput 的 widget 型输入，理论上不会被错位波及；
      // 但同一套修正顺手做上，免得以后加了输入又踩同一个坑。
      try {
        const fixed = repairWidgetValues(this, info) + sanitizeWidgetValues(this);
        if (fixed) console.info(`[LoRA分类加载] 已修正 ${fixed} 个错位的 widget 值`);
      } catch (err) {
        console.warn("[LoRA分类加载] 修正 widget 值失败：", err);
      }
      setTimeout(() => {
        this.__st = readState(this);
        this.__refreshPanel?.();
        notifyPickers();
      }, 80);
      return r;
    };

    const onWidgetChanged = nodeType.prototype.onWidgetChanged;
    nodeType.prototype.onWidgetChanged = function (name, value, oldValue, widget) {
      const r = onWidgetChanged?.apply(this, arguments);
      if (this.__syncing) return r;
      // 用户在降级界面上改了下拉框 —— 把状态同步回折叠面板
      if (widget && typeof widget.name === "string" && widget.name.startsWith(WIDGET_PREFIX)) {
        const cid = widget.name.slice(WIDGET_PREFIX.length);
        const st = this.__st || (this.__st = readState(this));
        const cat = (this.__cats || []).find((c) => c.id === cid) || null;
        const isOn = !!(value && value !== NONE);
        if (isOn) {
          // 降级界面是单选：先把这个类别里原来选中的清掉，再启用新选中的
          const members = new Set(membersOf(cid));
          st.on = (st.on || []).filter((n) => !members.has(n));
          if (!st.on.includes(value)) st.on.push(value);
        } else {
          const members = new Set(membersOf(cid));
          st.on = (st.on || []).filter((n) => !members.has(n));
        }
        const w = selWidget(this);
        if (w) w.value = JSON.stringify(st);
        this.__refreshPanel?.();
        notifyPickers();
      }
      return r;
    };

    const onConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      const r = onConnectionsChange?.apply(this, arguments);
      // 接上 / 断开 model 会改变「能不能真的加载」，提示条得跟着变
      setTimeout(() => this.__refreshPanel?.(), 0);
      return r;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      const r = onRemoved?.apply(this, arguments);
      setTimeout(() => notifyPickers(), 0);
      return r;
    };
  },

  setup() {
    window.addEventListener("message", (ev) => {
      if (ev?.data?.type === "lora-category-loader:refresh-node-defs") {
        refreshNodeDefs().then((ok) => {
          if (ok) {
            for (const n of app.graph?._nodes || []) {
              if (n.comfyClass === LOADER_CLASS) {
                n.__st = readState(n);
                n.__refreshPanel?.();
              }
            }
            notifyPickers(true);
          }
        });
      }
    });

    injectMenuButton();
  },
});
