// 「LoRA提示词选择」的打钩界面。
//
// 界面本身不参与计算：它只负责把「哪些 LoRA 的哪些预设被勾了」写进节点上一个
// 隐藏的 selection widget（JSON 字符串），真正的拼接在后端 Python 里做。

import { app } from "../../scripts/app.js";

const PICKER_CLASS = "LoraPromptPicker";
const LOADER_CLASS = "LoraCategoryLoader";
const WIDGET_PREFIX = "loracat_";
const NONE = "(不使用)";
const SEL_WIDGET = "selection";
const STATE_URL = "/lora_category_loader/api/state";
const PANEL_URL = "/lora_category_loader";

const LIB_TTL_MS = 4000;

let _lib = null;
let _libTs = 0;
let _libPending = null;

async function fetchLibrary(force = false) {
  const now = Date.now();
  if (!force && _lib && now - _libTs < LIB_TTL_MS) return _lib;
  if (_libPending) return _libPending;

  _libPending = fetch(STATE_URL)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
    .then((data) => {
      _lib = data;
      _libTs = Date.now();
      return data;
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

export function invalidateLibrary() {
  _lib = null;
  _libTs = 0;
}

/**
 * 修正「载入工作流时 widget 值整体错一位」的前端 bug。
 *
 * 前端 configure 时是按**位置**恢复值的（`namedValuesRestore` 默认关闭）：
 *
 *   let t = 0;
 *   for (const w of node.widgets) {
 *     if (w.serialize === false) continue;
 *     const v = restore(nodeId, node.id, w.name, t++);   // 取 widgets_values[t]
 *     if (v) w.value = v.value;
 *   }
 *
 * 而 forceInput 的 STRING 输入（本插件的 `lora_names`）在建节点时**也会占一个 widget 槽位**、
 * 一起参与 t++，但它存盘时那一格并不存在。于是从它后面的第一个 widget 起，每个值都往前错一位：
 * `selection` 拿到 `separator` 的值、`separator` 拿到 `prefix` 的值…… 而且错位后的值会被
 * **再存回去**，所以每载入一次就烂得更厉害。
 *
 * 前端同时也写了一份按名字索引的 `widgets_values_named`（内容是对的），这里按名字重放一次修正回来。
 * 老前端没有这个字段时直接跳过 —— 那种情况下按位置恢复本来就是对的。
 */
export function repairWidgetValues(node, info) {
  const named = info && info.widgets_values_named;
  if (!named || typeof named !== "object") return 0;

  let fixed = 0;
  for (const w of node.widgets || []) {
    if (!w || typeof w.name !== "string" || !(w.name in named)) continue;
    const want = named[w.name];
    let same;
    try {
      same = JSON.stringify(w.value) === JSON.stringify(want);
    } catch (err) {
      same = w.value === want;
    }
    if (!same) {
      w.value = want;
      fixed++;
    }
  }
  return fixed;
}

const SEPARATOR_OPTIONS = ["换行", "双换行", "逗号+空格", "空格"];

function widgetOptions(w) {
  let v = w && w.options ? w.options.values : null;
  try {
    if (typeof v === "function") v = v(w);
  } catch (err) {
    return null;
  }
  return Array.isArray(v) ? v : null;
}

/**
 * 兜底：把「只可能是枚举 / JSON / 数字」的字段复位。
 *
 * 已经被错位污染并**存回工作流**的旧节点，widgets_values_named 里存的也是错位后的值，
 * 光靠按名字重放救不回来。但这类字段的取值范围是确定的 —— 一旦不是，就一定是错位留下的垃圾：
 *
 * - `loracat_*`：类别下拉框，值必须是它自己选项里的一个（类别增删后按位置恢复会把
 *   别的 widget 的值灌进来，比如整段 selection JSON）；
 * - `selection`：只能是 JSON 对象；
 * - `global_strength`：只能是数字。
 *
 * prefix / suffix 是自由文本，没法判断，只能用户自己重新填。
 */
export function sanitizeWidgetValues(node) {
  let fixed = 0;

  const force = (name, ok, fallback) => {
    const w = (node.widgets || []).find((x) => x.name === name);
    if (!w || ok(w.value)) return;
    w.value = fallback;
    fixed++;
  };

  const forceWidget = (w, ok, fallback) => {
    if (!w || ok(w.value)) return;
    w.value = fallback;
    fixed++;
  };

  // 类别下拉框（降级界面）：值不在自己的选项里就复位成「不使用」
  for (const w of node.widgets || []) {
    if (!w || typeof w.name !== "string" || !w.name.startsWith(WIDGET_PREFIX)) continue;
    const opts = widgetOptions(w);
    if (!opts || !opts.length) continue;
    forceWidget(w, (v) => opts.includes(v), opts.includes(NONE) ? NONE : opts[0]);
  }

  force("separator", (v) => SEPARATOR_OPTIONS.includes(v), "换行");
  force(
    "selection",
    (v) => {
      try {
        const d = JSON.parse(v);
        return !!d && typeof d === "object" && !Array.isArray(d);
      } catch (err) {
        return false;
      }
    },
    "{}"
  );
  force("global_strength", (v) => typeof v === "number" && Number.isFinite(v), 1);

  return fixed;
}

/* ------------------------------------------------------------------ */
/* 读上游                                                              */
/* ------------------------------------------------------------------ */

function upstreamNode(node) {
  const input = (node.inputs || []).find((i) => i.name === "lora_names");
  if (!input || input.link == null) return null;
  const link = app.graph?.links?.[input.link];
  if (!link) return null;
  return app.graph.getNodeById(link.origin_id) || null;
}

// 上游的真实选择存在 selection 里（折叠面板写的那份）。
// 原生下拉框只是降级通路：多选类别一个框根本装不下，新建的类别在刷新节点定义前
// 甚至没有对应的框。所以一律优先读 selection。
//
// 顺序必须和后端 parse_selection 完全一致，界面才不会跟实际输出对不上：
// 按库里的类别顺序 -> 类别内按名称排序。勾选先后不影响顺序。
function enabledLoras(node, lib) {
  const src = upstreamNode(node);
  if (!src) return null;

  const selW = (src.widgets || []).find((w) => w.name === SEL_WIDGET);
  if (selW && typeof selW.value === "string" && selW.value.trim() && selW.value.trim() !== "{}") {
    try {
      const data = JSON.parse(selW.value);
      if (data && typeof data === "object" && data.ui) {
        const names = [];
        const seen = new Set();
        const push = (n) => {
          if (typeof n === "string" && n && !seen.has(n)) {
            seen.add(n);
            names.push(n);
          }
        };

        if (Array.isArray(data.on)) {
          // v2：全局启用列表
          data.on.forEach(push);
        } else {
          // v1 旧格式：类别分桶 + 临时分类里的都算启用
          const cats = data.cats && typeof data.cats === "object" ? data.cats : {};
          const order = ((lib && lib.categories) || []).map((c) => c.id);
          for (const cid of order) for (const n of cats[cid] || []) push(n);
          for (const cid of Object.keys(cats)) {
            if (order.includes(cid)) continue;
            for (const n of cats[cid] || []) push(n);
          }
          for (const t of data.temps || []) {
            for (const n of (t && t.loras) || []) push(n);
          }
        }

        const onSet = new Set(names);
        const out = [];
        const taken = new Set();
        for (const cat of (lib && lib.categories) || []) {
          const members = ((lib && lib.loras) || [])
            .filter((l) => (l.categories || []).includes(cat.id) && onSet.has(l.name))
            .map((l) => l.name)
            .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
          for (const n of members) {
            if (!taken.has(n)) {
              taken.add(n);
              out.push(n);
            }
          }
        }
        for (const n of names) {
          if (!taken.has(n)) {
            taken.add(n);
            out.push(n);
          }
        }
        return out;
      }
    } catch (e) {
      /* 落到下拉框 */
    }
  }

  // 降级：上游的自定义界面没加载，读原生下拉框
  const out = [];
  for (const w of src.widgets || []) {
    if (typeof w.name === "string" && w.name.startsWith(WIDGET_PREFIX)) {
      const v = w.value;
      if (v && v !== NONE && !out.includes(v)) out.push(v);
    }
  }
  return out;
}

function presetsOf(lib, name) {
  const entry = (lib.loras || []).find((l) => l.name === name);
  return entry ? entry.presets || [] : null;
}

/* ------------------------------------------------------------------ */
/* 选择状态的读写                                                      */
/* ------------------------------------------------------------------ */

function selWidget(node) {
  return (node.widgets || []).find((w) => w.name === SEL_WIDGET);
}

function readSelection(node) {
  const w = selWidget(node);
  if (!w || !w.value) return {};
  try {
    const raw = typeof w.value === "string" ? JSON.parse(w.value) : w.value;
    if (!raw || typeof raw !== "object") return {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (Array.isArray(v)) out[k] = v.map(String);
    }
    return out;
  } catch (e) {
    return {};
  }
}

function writeSelection(node, map) {
  const w = selWidget(node);
  if (!w) return;
  const cleaned = {};
  for (const [k, v] of Object.entries(map)) {
    if (Array.isArray(v) && v.length) cleaned[k] = v;
  }
  w.value = JSON.stringify(cleaned);
}

/* ------------------------------------------------------------------ */
/* 界面                                                                */
/* ------------------------------------------------------------------ */

function hint(text, muted = true) {
  const d = document.createElement("div");
  d.textContent = text;
  d.style.cssText = `font-size:12px;line-height:1.5;color:${muted ? "var(--fg-color, #999)" : "inherit"};opacity:.75;padding:2px 0;`;
  return d;
}

function smallButton(label, title, onClick) {
  const b = document.createElement("button");
  b.textContent = label;
  b.title = title || "";
  b.style.cssText =
    "font-size:11px;padding:2px 8px;border-radius:6px;cursor:pointer;" +
    "background:rgba(128,128,128,.18);border:1px solid rgba(128,128,128,.35);color:inherit;";
  b.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onClick();
  };
  return b;
}

async function render(node, root) {
  const token = (node.__pickerToken || 0) + 1;
  node.__pickerToken = token;

  root.innerHTML = "";

  if (!upstreamNode(node)) {
    root.appendChild(hint("把「LoRA分类加载」的 LORA_NAMES 输出接到本节点的 lora_names 输入。"));
    resize(node);
    return;
  }

  const lib = await fetchLibrary();
  if (token !== node.__pickerToken) return;

  const names = enabledLoras(node, lib) || [];
  if (!names.length) {
    root.appendChild(hint("上游当前没有启用任何 LoRA。"));
    resize(node);
    return;
  }

  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap;";
  const selected = readSelection(node);
  let map = { ...selected };

  bar.appendChild(
    smallButton("全选", "把所有 LoRA 的所有预设都勾上", () => {
      for (const n of names) {
        const ps = node.__pickerPresets?.[n] || [];
        map[n] = ps.map((p) => p.id);
      }
      writeSelection(node, map);
      render(node, root);
    })
  );
  bar.appendChild(
    smallButton("全不选", "清空所有勾选（等于不注入任何提示词）", () => {
      map = {};
      writeSelection(node, map);
      render(node, root);
    })
  );
  bar.appendChild(
    smallButton("重载预设", "从管理面板重新读取最新预设", () => {
      invalidateLibrary();
      render(node, root);
    })
  );
  bar.appendChild(
    smallButton("管理面板", "打开 LoRA 分类管理面板", () => window.open(PANEL_URL, "_blank"))
  );
  root.appendChild(bar);

  const presetsCache = {};
  let missingPresets = 0;

  for (const name of names) {
    const presets = presetsOf(lib, name);
    presetsCache[name] = presets || [];

    const group = document.createElement("div");
    group.style.cssText =
      "border:1px solid rgba(128,128,128,.28);border-radius:8px;padding:7px 9px;margin-top:7px;";

    // 组标题
    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:4px;";

    // 组标题：起过别名就显示别名（管理面板里点名称可改）
    const title = document.createElement("span");
    const meta = (lib.loras || []).find((x) => x.name === name) || {};
    const short = name.split("/").pop();
    title.textContent = meta.alias || short;
    title.title = meta.alias ? `${meta.alias}（原名：${short}）` : name;
    title.style.cssText = "font-size:12px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";

    const count = document.createElement("span");
    count.style.cssText = "font-size:11px;opacity:.6;";

    head.append(title, count);

    if (presets && presets.length) {
      head.appendChild(
        smallButton("全选", "勾上这个 LoRA 的全部预设", () => {
          map[name] = presets.map((p) => p.id);
          writeSelection(node, map);
          render(node, root);
        })
      );
      head.appendChild(
        smallButton("清空", "取消这个 LoRA 的全部勾选", () => {
          delete map[name];
          writeSelection(node, map);
          render(node, root);
        })
      );
    }
    group.appendChild(head);

    if (!presets) {
      missingPresets++;
      group.appendChild(hint(`预设库里没有「${name}」的记录。`));
    } else if (!presets.length) {
      group.appendChild(hint("这个 LoRA 还没有提示词预设，去管理面板添加。"));
    } else {
      const current = new Set(map[name] || []);
      count.textContent = `${current.size}/${presets.length}`;

      for (const preset of presets) {
        const row = document.createElement("label");
        row.style.cssText =
          "display:flex;align-items:flex-start;gap:7px;padding:3px 0;cursor:pointer;user-select:none;";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = current.has(preset.id);
        cb.style.cssText = "margin-top:2px;flex:none;cursor:pointer;";

        const txt = document.createElement("span");
        txt.style.cssText = "font-size:12px;line-height:1.45;min-width:0;";

        const nm = document.createElement("span");
        nm.textContent = preset.name;
        txt.appendChild(nm);

        if (preset.text) {
          const preview = document.createElement("span");
          preview.textContent = "  " + preset.text.replace(/\s+/g, " ").slice(0, 42) + (preset.text.length > 42 ? "…" : "");
          preview.style.cssText = "opacity:.5;";
          txt.appendChild(preview);
          row.title = preset.text;
        }

        cb.onchange = () => {
          const list = new Set(map[name] || []);
          if (cb.checked) list.add(preset.id);
          else list.delete(preset.id);
          if (list.size) map[name] = [...list];
          else delete map[name];
          count.textContent = `${list.size}/${presets.length}`;
          writeSelection(node, map);
        };

        row.append(cb, txt);
        group.appendChild(row);
      }
    }

    root.appendChild(group);
  }

  node.__pickerPresets = presetsCache;

  if (missingPresets) {
    root.appendChild(hint("有一些 LoRA 不在预设库里 —— 可能是文件改名或删除了，去管理面板点「重新扫描」。"));
  }

  resize(node);
}

function resize(node) {
  const root = node.__pickerUI;
  if (!root) return;

  const measured = root.scrollHeight;
  // Nodes 2.0 的 DOM 是异步挂上去的，首帧可能量到 0 —— 拿 0 算会把节点压成一条缝
  if (!measured) {
    if (!node.__sizeRetry) {
      node.__sizeRetry = requestAnimationFrame(() => {
        node.__sizeRetry = 0;
        resize(node);
      });
    }
    return;
  }

  const needed = measured + 64;
  const width = Math.max(node.size?.[0] || 0, 320);
  // 只往大里撑、不往回缩；同一高度不重复设，免得 2.0 下反复 setSize 抖动
  if (!node.size || node.size[1] + 4 < needed) {
    if (node.__lastSetH === needed) return;
    node.__lastSetH = needed;
    node.setSize([width, needed]);
    app.graph?.setDirtyCanvas(true, true);
  }
}

/* ------------------------------------------------------------------ */
/* 注册                                                                */
/* ------------------------------------------------------------------ */

// 把原生 widget 从界面上藏起来，但**保留它的值** —— 它是后端读状态的入口，也要参与序列化。
// 两种前端压住的方式不一样，必须一起写：
//   · 旧画布（LiteGraph）看 computeSize，高度返回 0 就不画；
//   · Nodes 2.0（Vue 渲染）不看 computeSize，`hidden` 也未必被认，
//     得用 canvasOnly 明确告诉它「这个别用 Vue 渲染」。
// 少写其中任何一条，2.0 下那个 selection 输入框就会露出来（显示成 `{}`）。
export function hideNativeWidget(w) {
  w.computeSize = () => [0, -4];
  w.hidden = true;
  if (w.options && typeof w.options === "object") {
    w.options.canvasOnly = true;
  } else {
    w.options = { canvasOnly: true };
  }
}

// 反过来：万一自定义界面挂不出来，得把 selection 放出来 —— 藏着的状态容器 = 用户完全没法操作。
export function showNativeWidget(w) {
  delete w.hidden;
  delete w.computeSize;
  if (w.options && "canvasOnly" in w.options) delete w.options.canvasOnly;
}

function setupPicker(node) {
  // 隐藏后端用来接收状态的 selection widget
  const sel = selWidget(node);
  if (sel) hideNativeWidget(sel);

  const root = document.createElement("div");
  root.style.cssText =
    "box-sizing:border-box;display:flex;flex-direction:column;gap:2px;padding:2px 0;color:inherit;";
  node.__pickerUI = root;

  if (typeof node.addDOMWidget === "function") {
    try {
      node.addDOMWidget("lora_prompt_picker_ui", "div", root, { serialize: false, hideOnZoom: false });
    } catch (err) {
      console.warn("[LoRA分类加载] 创建打钩界面失败，可能是新版前端不兼容：", err);
      root.appendChild(hint("界面渲染失败，请退回旧版画布（legacy canvas）后重试。"));
      if (sel) showNativeWidget(sel); // 界面没了就把状态容器放出来，至少还能手改
    }
  } else {
    console.warn("[LoRA分类加载] 当前前端不支持 addDOMWidget，无法渲染打钩界面。");
    root.appendChild(hint("当前前端不支持自定义界面，请退回旧版画布（legacy canvas）。"));
    if (sel) showNativeWidget(sel);
  }

  node.__refreshPicker = () => {
    try {
      render(node, root);
    } catch (err) {
      console.warn("[LoRA分类加载] 刷新打钩界面失败：", err);
    }
  };

  node.__refreshPicker();
  // Nodes 2.0 的 DOM 挂载是异步的，首帧量高度可能还是 0 —— 补量一次
  requestAnimationFrame(() => resize(node));
}

app.registerExtension({
  name: "LoraCategoryLoader.PromptPicker",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== PICKER_CLASS) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      setupPicker(this);
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure?.apply(this, arguments);
      // 前端刚按位置恢复完（可能已经错位），这里立刻按名字修正回来。
      // 必须赶在 render 读 selection 之前，所以是同步做的。
      try {
        const fixed = repairWidgetValues(this, info) + sanitizeWidgetValues(this);
        if (fixed) console.info(`[LoRA分类加载] 已修正 ${fixed} 个错位的 widget 值（前端按位置恢复的 bug）`);
      } catch (err) {
        console.warn("[LoRA分类加载] 修正 widget 值失败：", err);
      }
      // 等 widget 值恢复完再画
      setTimeout(() => this.__refreshPicker?.(), 60);
      return r;
    };

    const onConn = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      const r = onConn?.apply(this, arguments);
      setTimeout(() => this.__refreshPicker?.(), 0);
      return r;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      const r = onRemoved?.apply(this, arguments);
      return r;
    };
  },

  setup() {
    // 工作流整体加载完之后统一刷一遍
    const kick = () => {
      for (const n of app.graph?._nodes || []) {
        if (n.comfyClass === PICKER_CLASS) n.__refreshPicker?.();
      }
    };
    setTimeout(kick, 300);
    setTimeout(kick, 1500);
  },
});

export { enabledLoras, render as renderPicker, LOADER_CLASS };
