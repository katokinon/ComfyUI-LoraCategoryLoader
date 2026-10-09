"""节点 A：LoRA分类加载

两套界面，共用一套状态：

1. **自定义界面（默认）** —— 由 js/lora_category_loader.js 渲染的折叠面板，
   支持多选类别、临时分类、拖拽、搜索、强度快调。所有选择写进隐藏的
   `selection` widget（一段 JSON）。

2. **原生下拉框（降级）** —— 每个类别一个 Combo，单选即同类互斥。
   万一自定义组件在当前前端渲染失败，用户还能靠它干活。

`load()` 优先读 `selection`；只有当它里没有 UI 写入标记时才回退到下拉框。

`model` / `clip` 是**可选**输入：只想拿提示词文本时可以不接，此时照样输出
LORA_NAMES / LORA_SYNTAX（强度取库里的值），但不往模型里叠加任何东西。
否则用户为了看一眼提示词，还得被迫拉一整条采样链路，而且整张图会因为
「required_input_missing: model / clip」被判定无效、一次都不执行。
"""

from __future__ import annotations

import json
from typing import List, Optional, Sequence, Tuple

from ..scanner import index as lora_index
from ..scanner import resolve as resolve_lora
from ..store import DEFAULT_CATEGORY_ID, get_library
from ..util import log, norm

NONE = "(不使用)"
WIDGET_PREFIX = "loracat_"
SELECTION_WIDGET = "selection"
MAX_CATEGORY_WIDGETS = 60

# (名称, 模型强度或 None, CLIP 强度或 None)
Pick = Tuple[str, Optional[float], Optional[float]]


class LoraCategoryLoader:
    CATEGORY = "LoRA分类加载"
    FUNCTION = "load"

    RETURN_TYPES = ("MODEL", "CLIP", "STRING", "STRING")
    RETURN_NAMES = ("MODEL", "CLIP", "LORA_NAMES", "LORA_SYNTAX")
    RETURN_TOOLTIPS = (
        "叠加了所选 LoRA 的模型；没接 model 输入时原样透传为空",
        "叠加了所选 LoRA 的 CLIP；没接 clip 输入时原样透传为空",
        "本次启用的 LoRA 名称，按加载顺序换行分隔（接到「LoRA提示词选择」）",
        "<lora:名称:强度> 形式，便于写入元数据或排查",
    )

    @classmethod
    def INPUT_TYPES(cls):
        lib = get_library()
        scan_names = [e["name"] for e in lora_index().values()]

        categories = lib.categories() or [
            {"id": DEFAULT_CATEGORY_ID, "name": "未分类", "mode": "exclusive"}
        ]
        if len(categories) > MAX_CATEGORY_WIDGETS:
            log(f"类别数量 {len(categories)} 超过 {MAX_CATEGORY_WIDGETS}，超出部分不会出现在节点上。")
            categories = categories[:MAX_CATEGORY_WIDGETS]

        # 这里所有输入都声明成 **optional**，一个 required 都不留。
        #
        # 原因是类别数量会变：每次在管理面板加/删类别，节点上就多/少几个下拉框。
        # 而 ComfyUI 存 widget 值是**按位置**存的，于是旧工作流载入后，多出来的那几个
        # 下拉框拿不到值 —— 如果它们是 required，会直接报
        # 「Required input is missing: loracat_xxx」，整张图都提交不了（即使有 default 也不行）。
        # 全部改成 optional 之后：缺值就用默认，旧工作流照样能跑。
        #
        # ⚠️ 顺序别动！required 排在 optional 前面，widget 的先后由这个顺序决定。
        # 现在 required 是空的，所以 optional 里的书写顺序 = widget 顺序，
        # 必须保持 [model, clip, 各下拉框, selection, global_strength] 不变，
        # 否则已存工作流的位置映射会整体错位。
        optional = {
            # 不接也能跑：不实际加载，但仍然输出名称与语法。
            "model": ("MODEL", {"tooltip": "基础模型；不接则只输出 LoRA 名称与语法，不做加载"}),
            "clip": ("CLIP", {"tooltip": "CLIP 文本编码器；不接则只输出 LoRA 名称与语法，不做加载"}),
        }

        for cat in categories:
            options = [NONE] + lib.names_in_category(cat["id"], scan_names)
            hint = "单选，同类互斥" if cat.get("mode") != "multi" else "多选"
            optional[WIDGET_PREFIX + cat["id"]] = (
                options,
                {
                    "default": NONE,
                    "tooltip": f"{cat['name']} · {hint}（这是降级界面；正常应显示折叠面板）",
                },
            )

        # 自定义界面的状态容器。JS 会把它隐藏起来。
        optional[SELECTION_WIDGET] = (
            "STRING",
            {
                "default": "{}",
                "multiline": False,
                "tooltip": "由折叠面板自动维护的选择状态，一般不用手改",
            },
        )

        optional["global_strength"] = (
            "FLOAT",
            {
                "default": 1.0,
                "min": 0.0,
                "max": 4.0,
                "step": 0.05,
                "tooltip": "总强度倍率，会乘以每个 LoRA 的强度",
            },
        )

        return {"required": {}, "optional": optional}

    def load(
        self,
        model=None,
        clip=None,
        global_strength: float = 1.0,
        selection: str = "{}",
        **kwargs,
    ):
        lib = get_library()
        known = lora_index()
        factor = _safe_float(global_strength, 1.0)

        picks = parse_selection(selection)
        source = "折叠面板"
        if picks is None:
            picks = picks_from_combos(lib, kwargs)
            source = "下拉框（降级）"

        # model / clip 任一没接，就只做「名称 + 语法」输出。
        bare = model is None or clip is None

        names: List[str] = []
        syntax: List[str] = []
        seen = set()
        comfy_sd = None
        comfy_utils = None

        for name, ms_override, cs_override in picks:
            if name in seen:
                continue
            if name not in known:
                log(f"跳过：索引里找不到 LoRA「{name}」，可能文件已被删除或改名。")
                continue
            seen.add(name)

            entry = lib.entry(name, create=False) or {}
            ms = _safe_float(
                ms_override if ms_override is not None else entry.get("model_strength", 0.8), 0.8
            )
            cs = _safe_float(
                cs_override if cs_override is not None else entry.get("clip_strength", 0.8), 0.8
            )
            ms *= factor
            cs *= factor

            if not bare:
                path = resolve_lora(name)
                if not path:
                    log(f"跳过：无法解析「{name}」的文件路径。")
                    continue
                if comfy_sd is None:
                    import comfy.lora as comfy_lora
                    import comfy.sd as comfy_sd
                    import comfy.utils as comfy_utils

                # ⚠️ 先把文件读成 state_dict，**不能**把路径直接传给 load_lora_for_models。
                # 它内部会走 comfy.lora.load_lora(sd, key_map)，那里对 sd 调 .keys()；
                # 传字符串进去会抛 AttributeError("'str' object has no attribute 'keys'")，
                # 然后被下面的 except 吞掉 —— 表现就是「接了模型也毫无反应」。
                # 官方 LoraLoader 同样是先 load_torch_file 再传进去的。
                lora_sd = None
                lora_meta = None
                try:
                    lora_sd, lora_meta = comfy_utils.load_torch_file(
                        path, safe_load=True, return_metadata=True
                    )
                except TypeError:
                    # 老版本 ComfyUI 的 load_torch_file 没有 return_metadata
                    try:
                        lora_sd = comfy_utils.load_torch_file(path, safe_load=True)
                    except Exception as exc:
                        log(f"读取 LoRA 文件失败，跳过「{name}」：{exc!r}")
                        continue
                except Exception as exc:
                    log(f"读取 LoRA 文件失败，跳过「{name}」：{exc!r}")
                    continue

                # 自己算一遍「有多少处权重真的映射到了当前模型上」。
                # 加载器不会因为键对不上而报错，它只是把匹配不到的那些丢掉；
                # 一处都没对上时画面上毫无变化，所以必须主动说出来。
                # 用 key_map + load_lora 直接数，而不是比较 model.patches 的增量 ——
                # 后者在同一个 LoRA 被重复加载时会把「已经存在」误判成「没生效」。
                applied = None
                try:
                    key_map = {}
                    if model is not None:
                        key_map = comfy_lora.model_lora_keys_unet(model.model, key_map)
                    if clip is not None:
                        key_map = comfy_lora.model_lora_keys_clip(clip.cond_stage_model, key_map)
                    applied = len(comfy_lora.load_lora(lora_sd, key_map))
                except Exception:
                    applied = None

                try:
                    model, clip = comfy_sd.load_lora_for_models(
                        model, clip, lora_sd, ms, cs, lora_metadata=lora_meta
                    )
                except TypeError:
                    # 更老的版本没有 lora_metadata 参数
                    try:
                        model, clip = comfy_sd.load_lora_for_models(model, clip, lora_sd, ms, cs)
                    except Exception as exc:
                        log(f"加载 LoRA「{name}」失败：{exc!r}")
                        continue
                except Exception as exc:
                    log(f"加载 LoRA「{name}」失败：{exc!r}")
                    continue

                if applied == 0:
                    log(
                        f"⚠️ LoRA「{name}」与当前模型对不上：没有任何权重被应用，画面上不会有变化。"
                        f"多半这个 LoRA 不是给当前基础模型训练的。"
                    )
                elif applied is not None:
                    log(f"已加载 LoRA「{name}」（强度 {ms:.2f} / {cs:.2f}，应用 {applied} 处权重）")

            names.append(name)
            syntax.append(f"<lora:{name}:{ms:.2f}>")

        if not names:
            log(f"（来源：{source}）本次没有加载任何 LoRA。")
        elif bare:
            log(
                f"（来源：{source}）{len(names)} 个 LoRA 只输出了名称与语法，"
                f"没有接 model / clip，未做实际加载。"
            )

        return (model, clip, "\n".join(names), "\n".join(syntax))


# --------------------------------------------------------------------------- #
# 状态解析
# --------------------------------------------------------------------------- #

def parse_selection(raw) -> Optional[List[Pick]]:
    """解析折叠面板写入的状态。

    返回 None 表示「这份状态不是界面写的，请回退到下拉框」。
    返回空列表表示「界面在用，但什么都没选」—— 这是有效状态，不能回退。

    当前格式（v2，一个 LoRA 可以在多个类别里出现，勾选状态是全局的）：

        {"ui": true, "v": 2, "on": [名称…], "temps": [...], "strength": {...}, "folder": "sdxl"}

    旧格式（v1，按类别分桶）仍然能读，方便老工作流。
    """
    if not raw or not isinstance(raw, str) or not raw.strip():
        return None
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(data, dict) or not data.get("ui"):
        return None

    strength = data.get("strength")
    strength = strength if isinstance(strength, dict) else {}

    def overrides(name: str) -> Tuple[Optional[float], Optional[float]]:
        ov = strength.get(name) or {}
        if not isinstance(ov, dict):
            return (None, None)
        return (_maybe_float(ov.get("model")), _maybe_float(ov.get("clip")))

    on = data.get("on")
    if isinstance(on, list):
        names = [norm(n) for n in on if isinstance(n, str) and n.strip()]
        out: List[Pick] = []
        for name in _order_by_library(names):
            ms, cs = overrides(name)
            out.append((name, ms, cs))
        return out

    # ---- 以下是 v1 旧格式（cats / temps 分桶），继续支持 ----
    cats = data.get("cats")
    temps = data.get("temps")
    cats = cats if isinstance(cats, dict) else {}
    temps = temps if isinstance(temps, list) else []

    def normalize(names) -> Sequence[str]:
        if not isinstance(names, list):
            return ()
        return tuple(norm(n) for n in names if isinstance(n, str) and n.strip())

    out = []
    seen = set()

    def push(name: str) -> None:
        if not name or name in seen:
            return
        seen.add(name)
        ms, cs = overrides(name)
        out.append((name, ms, cs))

    # 1) 先按库里的类别顺序（= 面板上看到的顺序 = 加载顺序）
    lib = get_library()
    for cat in lib.categories():
        for name in normalize(cats.get(cat["id"])):
            push(name)

    # 2) 库里已经不存在、但状态里还有的类别 id，也按原顺序接上
    known_ids = {c["id"] for c in lib.categories()}
    for cid, names in cats.items():
        if cid in known_ids:
            continue
        for name in normalize(names):
            push(name)

    # 3) 临时分类按创建顺序排在最后
    for temp in temps:
        if isinstance(temp, dict):
            for name in normalize(temp.get("loras")):
                push(name)

    return out


def _order_by_library(names: Sequence[str]) -> List[str]:
    """把一组已启用的 LoRA 按「库里的类别顺序 -> 类别内顺序」重排。

    勾选顺序不该影响提示词顺序 —— 顺序必须只由库里的类别顺序决定，结果才可复现。
    在一个类别里找不到的（理论上不会有）接在最后。
    """
    lib = get_library()
    wanted = set(names)
    scan_names = [e["name"] for e in lora_index().values()]
    out: List[str] = []
    seen = set()

    for cat in lib.categories():
        for name in lib.names_in_category(cat["id"], scan_names):
            if name in wanted and name not in seen:
                seen.add(name)
                out.append(name)

    for name in names:
        if name not in seen:
            seen.add(name)
            out.append(name)
    return out


def picks_from_combos(lib, kwargs) -> List[Pick]:
    """降级通路：读每个类别下拉框的当前值。"""
    out: List[Pick] = []
    seen = set()
    for cat in lib.categories():
        value = kwargs.get(WIDGET_PREFIX + cat["id"])
        if not isinstance(value, str) or not value or value == NONE:
            continue
        name = norm(value)
        if name in seen:
            continue
        seen.add(name)
        out.append((name, None, None))
    return out


def _safe_float(value, fallback: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _maybe_float(value) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
