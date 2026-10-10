const API = "/lora_category_loader";

const STATE = {
  categories: [],
  loras: [],
  folders: [],
  missing: [],
  data_file: "",
  default_category: "default",
};

// 类别筛选是多选的：空集 = 不筛。
// 选中两个以上时出现「与 / 或」切换 —— 与 = 交集（同时属于这些类别），或 = 并集。
const filterCats = new Set();
let filterMode = "and";
let filterFolder = "*";
let query = "";
const picked = new Set();
let dragCatId = null;

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
};
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, body) {
  const res = await fetch(API + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.text().catch(() => "")) || res.statusText);
  return res.json();
}

/* ---------------- 预览图 ---------------- */

function previewUrl(l) {
  if (!l.preview) return "";
  return l.preview + (l.preview.includes("?") ? "&" : "?") + "v=" + (l.preview_ver || 0);
}

async function uploadPreview(lora, file) {
  const fd = new FormData();
  fd.append("name", lora.name);
  fd.append("file", file);
  const res = await fetch(API + "/api/preview/upload", { method: "POST", body: fd });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    /* 下面统一报错 */
  }
  if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  applyState(data.state);
}

async function deletePreview(lora) {
  const data = await api("/api/preview/delete", { name: lora.name });
  applyState(data.state);
}

function applyState(incoming) {
  if (!incoming) return;
  Object.assign(STATE, incoming);
  syncCatOptions();
  syncFolderOptions();
  renderSidebar();
  renderGrid();
}

/* ---------------- 子文件夹 ---------------- */

function syncFolderOptions() {
  const sel = $("#folderFilter");
  const named = (STATE.folders || []).filter((f) => f !== "");
  // 只要有 LoRA 落在子文件夹里就显示这个筛选（全是根目录时它没有意义）
  if (!named.length) {
    sel.classList.add("hidden");
    filterFolder = "*";
    return;
  }
  sel.classList.remove("hidden");
  sel.innerHTML =
    `<option value="*">全部文件夹</option>` +
    named.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join("") +
    ((STATE.folders || []).includes("") ? `<option value="">（根目录）</option>` : "");
  if (filterFolder !== "*" && !(STATE.folders || []).includes(filterFolder)) filterFolder = "*";
  sel.value = filterFolder;
}

/* ---------------- 提示条 ---------------- */

function toast(msg, isErr) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), isErr ? 5000 : 2600);
}

function banner(msg, warn) {
  const b = $("#banner");
  if (!msg) {
    b.classList.add("hidden");
    return;
  }
  b.className = "banner" + (warn ? " warn" : "");
  b.textContent = msg;
}

/* ------------------------------------------------------------------ */
/* 加载                                                                */
/* ------------------------------------------------------------------ */

async function load() {
  try {
    const data = await api("/api/state");
    Object.assign(STATE, data);
    $("#dataFile").textContent = data.data_file || "";
    syncCatOptions();
    syncFolderOptions();
    renderSidebar();
    renderGrid();
    renderBulk();
  } catch (e) {
    toast("读取数据失败：" + e.message, true);
  }
}

function syncCatOptions() {
  const sel = $("#bulkCat");
  // 第一个是占位项：批量条默认不选中任何类别，误点「＋ 加标签 / － 去标签」也不会悄悄改数据
  sel.innerHTML =
    `<option value="">— 选择类别 —</option>` +
    STATE.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
}

/* ------------------------------------------------------------------ */
/* 侧栏：类别                                                          */
/* ------------------------------------------------------------------ */

function catCount(id) {
  return STATE.loras.filter((l) => (l.categories || []).includes(id)).length;
}

function renderSidebar() {
  const list = $("#catList");
  list.innerHTML = "";

  list.appendChild(
    catRow({ id: "all", name: "全部", mode: null, count: STATE.loras.length })
  );  for (const c of STATE.categories) {
    const row = catRow({ ...c, count: catCount(c.id) });
    row.draggable = true;
    row.addEventListener("dragstart", () => {
      dragCatId = c.id;
      row.style.opacity = "0.4";
    });
    row.addEventListener("dragend", () => {
      dragCatId = null;
      row.style.opacity = "";
    });
    row.addEventListener("dragover", (ev) => ev.preventDefault());
    row.addEventListener("drop", async (ev) => {
      ev.preventDefault();
      if (!dragCatId || dragCatId === c.id) return;
      const ids = STATE.categories.map((x) => x.id).filter((x) => x !== dragCatId);
      ids.splice(ids.indexOf(c.id), 0, dragCatId);
      try {
        const r = await api("/api/category/reorder", { ids });
        STATE.categories = r.categories;
        needsNodeRefresh();
        renderSidebar();
      } catch (e) {
        toast("排序失败：" + e.message, true);
      }
    });
    list.appendChild(row);
  }

  syncFilterModeUI();
}

// 「与 / 或」只在选中两个以上类别时才有意义
function syncFilterModeUI() {
  const seg = $("#filterMode");
  if (!seg) return;
  seg.classList.toggle("hidden", filterCats.size < 2);
  for (const b of seg.querySelectorAll("button")) {
    b.classList.toggle("on", b.dataset.mode === filterMode);
  }
  const hint = $("#filterHint");
  if (hint) {
    if (filterCats.size >= 2) {
      const names = [...filterCats]
        .map((id) => (STATE.categories.find((c) => c.id === id) || {}).name || id)
        .join(filterMode === "and" ? " 且 " : " 或 ");
      hint.textContent = `筛选中：${names}`;
      hint.classList.remove("hidden");
    } else {
      hint.classList.add("hidden");
    }
  }
}

function catRow(cat) {
  const isAll = cat.id === "all";
  const active = isAll ? filterCats.size === 0 : filterCats.has(cat.id);
  const row = el("div", "cat" + (active ? " active" : ""));
  row.dataset.id = cat.id;
  row.title = isAll ? "显示全部（清空筛选）" : "点一下加入/移出筛选，可以选多个";

  const nm = el("span", "nm");
  nm.textContent = cat.name;
  row.appendChild(nm);

  if (cat.mode) {
    const mode = el("span", "mode");
    mode.textContent = cat.mode === "multi" ? "多选" : "单选";
    mode.title =
      cat.mode === "multi"
        ? "多选：这个类别里可以同时勾好几个"
        : "单选：在这个类别里勾一个，会自动关掉同类别里原来那个";
    row.appendChild(mode);
  }

  const cnt = el("span", "cnt");
  cnt.textContent = String(cat.count);
  row.appendChild(cnt);

  if (cat.id !== "all") {
    const tools = el("div", "tools");
    const edit = el("button");
    edit.textContent = "✎";
    edit.title = "重命名 / 改模式";
    edit.onclick = (ev) => {
      ev.stopPropagation();
      openCategoryDialog(cat);
    };
    const del = el("button");
    del.textContent = "✕";
    del.title = "删除（其下 LoRA 移回默认类别）";
    del.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm(`删除类别「${cat.name}」？\n这些 LoRA 会摘掉这个标签；如果它没有别的标签，就会回到「未分类」。`)) return;
      try {
        await api("/api/category/delete", { id: cat.id });
        filterCats.delete(cat.id);
        needsNodeRefresh();
        await load();
      } catch (e) {
        toast("删除失败：" + e.message, true);
      }
    };
    tools.append(edit, del);
    row.appendChild(tools);
  }

  row.onclick = () => {
    if (isAll) {
      filterCats.clear();
    } else if (filterCats.has(cat.id)) {
      filterCats.delete(cat.id);
    } else {
      filterCats.add(cat.id);
    }
    renderSidebar();
    renderGrid();
  };
  return row;
}

function openCategoryDialog(cat) {
  const isNew = !cat;
  const body = el("div");
  body.innerHTML = `
    <div class="field"><span>类别名称</span><input type="text" id="catName" value="${esc(cat?.name || "")}" placeholder="例如：角色 / 画风 / 题材"></div>
    <div class="field"><span>选择模式</span>
      <select id="catMode">
        <option value="exclusive">单选 · 同类互斥（当前版本节点即为此行为）</option>
        <option value="multi">多选（记录配置，节点端待自定义组件版本支持）</option>
      </select>
    </div>
    <p class="hint" style="margin:0">类别顺序决定节点上下拉框的顺序，也就是提示词的拼接顺序。</p>
  `;
  openDialog({
    title: isNew ? "新建类别" : "编辑类别",
    body,
    onMount: (root) => {
      root.querySelector("#catMode").value = cat?.mode || "exclusive";
    },
    onSave: async (root) => {
      const name = root.querySelector("#catName").value.trim();
      const mode = root.querySelector("#catMode").value;
      if (!name) {
        toast("类别名不能为空", true);
        return false;
      }
      await api("/api/category", isNew ? { name, mode } : { id: cat.id, name, mode });
      needsNodeRefresh();
      await load();
      return true;
    },
  });
}

/* ------------------------------------------------------------------ */
/* 主区：LoRA                                                          */
/* ------------------------------------------------------------------ */

function visibleLoras() {
  const q = query.trim().toLowerCase();
  return STATE.loras.filter((l) => {
    if (filterCats.size) {
      const mine = l.categories || [];
      const pools = [...filterCats];
      const ok =
        filterMode === "and"
          ? pools.every((c) => mine.includes(c)) // 交集：必须同时属于这些类别
          : pools.some((c) => mine.includes(c)); // 并集：属于其中任意一个即可
      if (!ok) return false;
    }
    if (filterFolder !== "*" && (l.top_folder || "") !== filterFolder) return false;
    if (!q) return true;
    return (
      l.name.toLowerCase().includes(q) ||
      (l.alias || "").toLowerCase().includes(q) ||
      (l.notes || "").toLowerCase().includes(q)
    );
  });
}

// 点名称就地改名。回车 / 失焦保存，Esc 取消；留空就是还原成文件名。
function editAlias(l, nameEl, body) {
  const inp = document.createElement("input");
  inp.type = "text";
  inp.className = "alias-input";
  inp.value = l.alias || "";
  inp.placeholder = l.display;
  inp.maxLength = 60;
  inp.onclick = (ev) => ev.stopPropagation();
  nameEl.replaceWith(inp);
  inp.focus();
  inp.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const v = inp.value.trim();
    if (save && v !== (l.alias || "")) {
      try {
        await api("/api/lora", { name: l.name, alias: v });
        l.alias = v;
        toast(v ? `已改名为「${v}」` : "已还原成文件名");
      } catch (e) {
        toast("保存别名失败：" + e.message, true);
      }
    }
    const card = body.closest(".card");
    if (card) card.replaceWith(loraCard(l));
  };
  inp.onkeydown = (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") {
      ev.preventDefault();
      finish(true);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      finish(false);
    }
  };
  inp.onblur = () => finish(true);
}

// 加 / 减一个类别标签（不动其他标签）
async function tagLora(l, { add, remove }, redraw) {
  try {
    const r = await api("/api/lora/tag", { name: l.name, add, remove });
    l.categories = r.categories;
    if (typeof redraw === "function") redraw();
    renderSidebar();
  } catch (e) {
    toast("修改类别失败：" + e.message, true);
  }
}

function renderGrid() {
  const grid = $("#grid");
  const list = visibleLoras();
  grid.innerHTML = "";

  $("#count").textContent = `${list.length} / ${STATE.loras.length} 个 LoRA`;

  if (!list.length) {
    $("#emptyState").classList.remove("hidden");
    $("#emptyState").textContent = STATE.loras.length
      ? "没有符合条件的 LoRA。"
      : "还没有扫描到 LoRA。请确认 models/loras 里有文件，然后点右上角「重新扫描」。";
    return;
  }
  $("#emptyState").classList.add("hidden");

  for (const l of list) grid.appendChild(loraCard(l));
}

function loraCard(l) {
  const card = el("div", "card" + (picked.has(l.name) ? " picked" : ""));
  card.dataset.name = l.name;

  /* 缩略图 */
  const thumb = el("div", "thumb");
  thumb.title = "点击选择 / 取消选择";
  const initial = el("span");
  initial.textContent = (l.display || "?").slice(0, 1).toUpperCase();
  thumb.appendChild(initial);

  const check = el("div", "check");
  check.textContent = picked.has(l.name) ? "✓" : "";
  thumb.appendChild(check);

  if (l.preview) {
    const img = el("img");
    img.loading = "lazy";
    img.alt = "";
    img.onerror = () => img.remove();
    img.src = previewUrl(l);
    thumb.insertBefore(img, check);
  }

  /* 预览图：上传 / 替换 / 删除 */
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/png,image/jpeg,image/webp,image/gif,image/avif";
  fileInput.style.display = "none";
  fileInput.onchange = async () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (!f) return;
    try {
      await uploadPreview(l, f);
      toast(`已更新「${l.display}」的预览图`);
    } catch (e) {
      toast("上传失败：" + e.message, true);
    }
  };

  const tools = el("div", "thumb-tools");
  const upBtn = el("button");
  upBtn.textContent = l.preview ? "换图" : "上传图";
  upBtn.title = "上传这个 LoRA 的预览图 —— 会显示在管理面板，也会出现在加载节点的悬停浮窗里";
  upBtn.onclick = (ev) => {
    ev.stopPropagation();
    fileInput.click();
  };
  tools.appendChild(upBtn);

  if (l.preview) {
    const delBtn = el("button");
    delBtn.textContent = "删除";
    delBtn.title = "删除这个预览图";
    delBtn.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm(`删除「${l.display}」的预览图？`)) return;
      try {
        await deletePreview(l);
        toast("已删除预览图");
      } catch (e) {
        toast("删除失败：" + e.message, true);
      }
    };
    tools.appendChild(delBtn);
  }

  thumb.append(tools, fileInput);

  thumb.onclick = () => {
    if (picked.has(l.name)) picked.delete(l.name);
    else picked.add(l.name);
    card.classList.toggle("picked", picked.has(l.name));
    check.textContent = picked.has(l.name) ? "✓" : "";
    renderBulk();
  };
  card.appendChild(thumb);

  /* 信息 */
  const body = el("div", "body");

  const name = el("div", "name editable");
  name.textContent = l.alias || l.display;
  name.title = l.alias
    ? `别名「${l.alias}」，原名 ${l.display} —— 点一下可以改`
    : "点一下给它起个别名（只影响显示，不改动文件）";
  name.onclick = (ev) => {
    ev.stopPropagation();
    editAlias(l, name, body);
  };
  body.appendChild(name);

  const path = el("div", "path");
  path.textContent = l.folder || "(根目录)";
  body.appendChild(path);

  // 只有设了别名才显示原名 —— 没别名时它跟上面那行一模一样，没必要重复
  if (l.alias) {
    const orig = el("div", "orig");
    orig.textContent = l.display;
    orig.title = l.name;
    body.appendChild(orig);
  }

  const rowCat = el("div", "row");
  rowCat.innerHTML = `<label>类别</label>`;
  const chips = el("div", "chips");
  rowCat.appendChild(chips);
  body.appendChild(rowCat);

  // 一个 LoRA 可以有多个标签，所以这里不是下拉单选，而是「标签 chips + 一个添加下拉」
  const drawChips = () => {
    chips.innerHTML = "";
    const mine = l.categories || [];
    if (!mine.length) {
      const none = el("span", "chip muted");
      none.textContent = "（未分类）";
      chips.appendChild(none);
    }
    for (const cid of mine) {
      const c = STATE.categories.find((x) => x.id === cid);
      const chip = el("span", "chip");
      chip.textContent = c ? c.name : cid;
      const isFallback = cid === STATE.default_category;
      if (isFallback) {
        chip.classList.add("fallback");
        chip.title = "没有别的标签时兜底显示的类别；摘掉它也会自动回来";
      } else {
        const x = el("b");
        x.textContent = "✕";
        x.title = "摘掉这个标签";
        x.onclick = (ev) => {
          ev.stopPropagation();
          tagLora(l, { remove: cid }, drawChips);
        };
        chip.appendChild(x);
      }
      chips.appendChild(chip);
    }

    const add = el("select", "chip-add");
    const rest = STATE.categories.filter((c) => !mine.includes(c.id));
    add.innerHTML =
      `<option value="">＋ 加类别</option>` +
      rest.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
    add.disabled = !rest.length;
    add.onchange = () => {
      if (!add.value) return;
      tagLora(l, { add: add.value }, drawChips);
    };
    chips.appendChild(add);
  };
  drawChips();

  // 只有一个强度 —— 只作用于 UNET 侧（CLIP 侧不参与，所以不再单列）
  const rowStr = el("div", "row");
  rowStr.innerHTML = `<label>强度</label>`;
  const mIn = el("input");
  mIn.type = "number";
  mIn.step = "0.05";
  mIn.min = "0";
  mIn.max = "4";
  mIn.value = l.model_strength;
  mIn.title = "LoRA 强度（新建/未改过的默认是 1）";
  mIn.onchange = async () => {
    const ms = parseFloat(mIn.value);
    if (Number.isNaN(ms)) return;
    l.model_strength = ms;
    try {
      await api("/api/lora", { name: l.name, model_strength: ms });
    } catch (e) {
      toast("保存强度失败：" + e.message, true);
    }
  };
  rowStr.append(mIn);
  body.appendChild(rowStr);

  const pre = el("button", "preset-btn");
  pre.innerHTML = `<span>提示词预设</span><span class="badge">${(l.presets || []).length} 条</span>`;
  pre.onclick = () => openPresetDialog(l);
  body.appendChild(pre);

  card.appendChild(body);
  return card;
}

function renderBulk() {
  const bar = $("#bulkBar");
  if (!picked.size) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  $("#selCount").textContent = String(picked.size);
}

/* ------------------------------------------------------------------ */
/* 预设编辑                                                            */
/* ------------------------------------------------------------------ */

function openPresetDialog(lora) {
  let presets = JSON.parse(JSON.stringify(lora.presets || []));

  const body = el("div");
  const list = el("div");
  body.appendChild(list);

  const addBtn = el("button", "ghost small");
  addBtn.textContent = "＋ 添加一条预设";
  addBtn.onclick = () => {
    presets.push({ id: uid(), name: "新预设", text: "" });
    draw();
  };
  body.appendChild(addBtn);

  const tail = el("p", "hint");
  tail.style.marginTop = "10px";
  tail.textContent = `属于「${lora.display}」。一个 LoRA 可以有多条预设，节点上可以任意勾选，也可以一条都不勾。`;
  body.appendChild(tail);

  function draw() {
    list.innerHTML = "";
    if (!presets.length) {
      const empty = el("p", "hint");
      empty.textContent = "这个 LoRA 还没有预设，点下面的按钮加一条。";
      list.appendChild(empty);
      return;
    }
    presets.forEach((p, i) => {
      const box = el("div", "preset");

      const head = el("div", "head");
      const nm = el("input");
      nm.type = "text";
      nm.value = p.name;
      nm.placeholder = "预设名称，例如：日常 / 赛博 / 礼裙";
      nm.oninput = () => (p.name = nm.value);

      const up = el("button");
      up.textContent = "↑";
      up.title = "上移";
      up.onclick = () => {
        if (i === 0) return;
        [presets[i - 1], presets[i]] = [presets[i], presets[i - 1]];
        draw();
      };
      const down = el("button");
      down.textContent = "↓";
      down.title = "下移（同 LoRA 内，勾选多个时按这个顺序拼接）";
      down.onclick = () => {
        if (i === presets.length - 1) return;
        [presets[i + 1], presets[i]] = [presets[i], presets[i + 1]];
        draw();
      };
      const rm = el("button");
      rm.textContent = "✕";
      rm.title = "删除";
      rm.onclick = () => {
        presets.splice(i, 1);
        draw();
      };
      head.append(nm, up, down, rm);

      const ta = document.createElement("textarea");
      ta.value = p.text;
      ta.placeholder = "完整提示词，例如：1girl, standing, soft light, detailed background";
      ta.oninput = () => (p.text = ta.value);

      box.append(head, ta);
      list.appendChild(box);
    });
  }
  draw();

  openDialog({
    title: `提示词预设 · ${lora.display}`,
    body,
    saveText: "保存预设",
    onSave: async () => {
      const cleaned = presets
        .map((p) => ({ id: p.id, name: (p.name || "").trim() || "未命名预设", text: p.text || "" }))
        .filter((p) => p.text.trim() || p.name.trim());
      await api("/api/lora", { name: lora.name, presets: cleaned });
      lora.presets = cleaned;
      renderGrid();
      return true;
    },
  });
}

function uid() {
  return "p" + Math.random().toString(16).slice(2, 10);
}

/* ------------------------------------------------------------------ */
/* 通用弹窗                                                            */
/* ------------------------------------------------------------------ */

function openDialog({ title, body, onSave, onMount, saveText = "保存" }) {
  const mask = el("div", "mask");
  const dlg = el("div", "dialog");

  const head = el("header");
  const h2 = el("h2");
  h2.textContent = title;
  const close = el("button", "ghost close");
  close.textContent = "✕";
  close.onclick = () => mask.remove();
  head.append(h2, close);

  const content = el("div", "content");
  content.appendChild(body);

  const foot = el("footer");
  const cancel = el("button", "ghost");
  cancel.textContent = "取消";
  cancel.onclick = () => mask.remove();
  foot.appendChild(cancel);

  if (onSave) {
    const save = el("button", "primary");
    save.textContent = saveText;
    save.onclick = async () => {
      save.disabled = true;
      try {
        const ok = await onSave(content);
        if (ok !== false) {
          mask.remove();
          toast("已保存");
        }
      } catch (e) {
        toast("保存失败：" + e.message, true);
      } finally {
        save.disabled = false;
      }
    };
    foot.appendChild(save);
  }

  dlg.append(head, content, foot);
  mask.appendChild(dlg);
  mask.onclick = (ev) => {
    if (ev.target === mask) mask.remove();
  };
  $("#modalRoot").appendChild(mask);
  if (onMount) onMount(content);
}

/* ------------------------------------------------------------------ */
/* 节点定义刷新提示                                                    */
/* ------------------------------------------------------------------ */

function needsNodeRefresh() {
  banner("类别有变动。ComfyUI 需要重新读取节点定义，节点上的下拉框才会更新 —— 点右上角「刷新节点定义」，或回到 ComfyUI 页面按 R。");
}

function refreshNodes() {
  const w = window.opener;
  if (w && !w.closed) {
    try {
      w.postMessage({ type: "lora-category-loader:refresh-node-defs" }, "*");
      toast("已请求 ComfyUI 刷新节点定义");
      banner("");
      return;
    } catch (e) {
      /* 落到下面的兜底提示 */
    }
  }
  toast("请在 ComfyUI 页面按 R 刷新节点定义");
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

$("#search").addEventListener("input", (ev) => {
  clearTimeout(query._t);
  const v = ev.target.value;
  query._t = setTimeout(() => {
    query = v;
    renderGrid();
  }, 160);
});

// 「与 / 或」：多个类别之间取交集还是并集
$("#filterMode").addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-mode]");
  if (!b) return;
  filterMode = b.dataset.mode;
  renderSidebar();
  renderGrid();
});

$("#folderFilter").addEventListener("change", (ev) => {
  filterFolder = ev.target.value || "*";
  renderGrid();
});

$("#btnNewCat").onclick = () => openCategoryDialog(null);
$("#btnRescan").onclick = async () => {
  try {
    await load();
    toast("已重新扫描");
  } catch (e) {
    toast("扫描失败：" + e.message, true);
  }
};
$("#btnAutotag").onclick = async () => {
  if (!confirm("把 models/loras 下的子目录名当作类别，批量归类尚未手动整理过的 LoRA？\n已经手动改过类别的不会被覆盖。")) return;
  try {
    const r = await api("/api/autotag", {});
    Object.assign(STATE, r.state);
    syncCatOptions();
    renderSidebar();
    renderGrid();
    needsNodeRefresh();
    toast(`已归类 ${r.assigned} 个 LoRA${r.created_categories.length ? "，新建类别：" + r.created_categories.join("、") : ""}`);
  } catch (e) {
    toast("自动归类失败：" + e.message, true);
  }
};
$("#btnRefreshNodes").onclick = refreshNodes;

async function bulkTag(mode) {
  const cid = $("#bulkCat").value;
  if (!picked.size) return;
  if (!cid) {
    toast("先在下拉里选一个类别", true);
    return;
  }
  const body = { names: [...picked] };
  if (mode === "add") body.add_category = cid;
  else if (mode === "remove") body.remove_category = cid;
  else body.categories = [cid];

  try {
    await api("/api/lora/bulk", body);
    for (const l of STATE.loras) {
      if (!picked.has(l.name)) continue;
      const cur = new Set(l.categories || []);
      if (mode === "add") cur.add(cid);
      else if (mode === "remove") cur.delete(cid);
      else {
        cur.clear();
        cur.add(cid);
      }
      l.categories = cur.size ? [...cur] : [STATE.default_category];
    }
    const target = STATE.categories.find((c) => c.id === cid);
    const verb = mode === "add" ? "加上" : mode === "remove" ? "去掉" : "设为唯一类别";
    picked.clear();
    renderBulk();
    renderSidebar();
    renderGrid();
    toast(`已对选中项${verb}「${target?.name || cid}」`);
  } catch (e) {
    toast("批量修改失败：" + e.message, true);
  }
}

$("#bulkAdd").onclick = () => bulkTag("add");
$("#bulkRemove").onclick = () => bulkTag("remove");
$("#bulkSet").onclick = () => bulkTag("set");

$("#bulkClear").onclick = () => {
  picked.clear();
  renderBulk();
  renderGrid();
};

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    const mask = document.querySelector(".mask");
    if (mask) mask.remove();
  }
});

load();
