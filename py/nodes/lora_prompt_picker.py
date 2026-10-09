"""节点 B：LoRA提示词选择

从节点 A 接过来的「已启用 LoRA 名称」出发，把每个 LoRA 名下的提示词预设
以复选框形式列出来。勾选哪些，就把哪些的文本按 LoRA 加载顺序拼成一段字符串。

顺序规则：
  1. LoRA 之间 —— 按节点 A 的加载顺序（即类别顺序）；
  2. 同一个 LoRA 内部 —— 按管理面板里预设的排列顺序；
  3. 整体用换行（可改）分隔。
"""

from __future__ import annotations

import json
from typing import List, Optional

from ..store import get_library
from ..util import log, norm

_SEPARATORS = {
    "换行": "\n",
    "双换行": "\n\n",
    "逗号+空格": ", ",
    "空格": " ",
}
_SEPARATOR_OPTIONS = list(_SEPARATORS.keys())


class LoraPromptPicker:
    CATEGORY = "LoRA分类加载"
    FUNCTION = "pick"

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("PROMPT", "REPORT")
    RETURN_TOOLTIPS = (
        "勾选的提示词拼接结果，直接接到文本编码节点",
        "本次实际采用了哪些 LoRA 的哪些预设，便于排查",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "lora_names": (
                    "STRING",
                    {"forceInput": True, "tooltip": "接到「LoRA分类加载」的 LORA_NAMES 输出"},
                ),
                "selection": (
                    "STRING",
                    {
                        "default": "{}",
                        "multiline": False,
                        "tooltip": "由节点界面上的复选框自动写入，一般不用手改",
                    },
                ),
            },
            "optional": {
                "separator": (_SEPARATOR_OPTIONS, {"default": "换行"}),
                "prefix": (
                    "STRING",
                    {"default": "", "multiline": False, "tooltip": "拼在最前面的独立一段（与正文之间也用同一个分隔符）"},
                ),
                "suffix": (
                    "STRING",
                    {"default": "", "multiline": False, "tooltip": "拼在最后面的独立一段（与正文之间也用同一个分隔符）"},
                ),
                "dedupe": ("BOOLEAN", {"default": True, "tooltip": "去掉完全重复的提示词片段"}),
            },
        }

    def pick(
        self,
        lora_names: str,
        selection: str = "{}",
        separator: str = "换行",
        prefix: str = "",
        suffix: str = "",
        dedupe: bool = True,
    ):
        sep = _SEPARATORS.get(separator, "\n")
        enabled = [norm(n) for n in (lora_names or "").splitlines() if n.strip()]

        chosen = _parse_selection(selection)
        if chosen is None:
            log("selection 不是合法 JSON，按「全部未勾选」处理。")
            chosen = {}

        lib = get_library()
        pieces: List[str] = []
        report: List[str] = []
        seen = set()

        for name in enabled:
            ids = chosen.get(name) or []
            if not ids:
                continue
            wanted = set(ids)
            used_here = []
            # 按库内预设顺序输出，保证结果稳定可复现
            for preset in lib.presets_of(name):
                if preset.get("id") not in wanted:
                    continue
                text = (preset.get("text") or "").strip()
                if not text:
                    continue
                if dedupe and text in seen:
                    continue
                seen.add(text)
                pieces.append(text)
                used_here.append(preset.get("name") or preset.get("id"))
            if used_here:
                report.append(f"{name} → {', '.join(used_here)}")

        # prefix / suffix 各算独立一段，跟正文用同一个分隔符隔开。
        # 之前是直接首尾黏合（prefix + body + suffix），配上「换行」分隔会得到
        # 「00-0011false」这种糊成一行的结果，看不出边界。
        segments: List[str] = []
        lead = (prefix or "").strip()
        if lead:
            segments.append(lead)
        segments.extend(pieces)
        tail = (suffix or "").strip()
        if tail:
            segments.append(tail)

        return (sep.join(segments), "\n".join(report))


def _parse_selection(raw: str) -> Optional[dict]:
    if not raw:
        return {}
    if isinstance(raw, dict):
        return raw
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    out = {}
    for key, value in data.items():
        if isinstance(value, list):
            out[norm(key)] = [str(v) for v in value]
    return out
