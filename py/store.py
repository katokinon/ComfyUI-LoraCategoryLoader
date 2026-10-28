"""类别 / LoRA 标签 / 提示词预设 的持久化。

数据文件：<ComfyUI user 目录>/lora_category_loader/library.json
放在 user 目录而不是插件目录，插件升级/重装不会丢配置。
"""

from __future__ import annotations

import threading
import uuid
from pathlib import Path
from typing import Dict, List, Optional

from .util import atomic_write_json, data_dir, display_name, file_lock, log, mtime_of, norm, read_json

LIBRARY_FILE = "library.json"
# v1 -> v2：默认类别从单选改多选
# v2 -> v3：LoRA 从「单类别」改成「多类别标签」
SCHEMA_VERSION = 3

DEFAULT_CATEGORY_ID = "default"
DEFAULT_CATEGORY_NAME = "未分类"
# 「未分类」是没归属的杂牌军，本来就不该互斥，默认可多选
DEFAULT_CATEGORY_MODE = "multi"
CATEGORY_MODES = ("exclusive", "multi")

# LoRA 强度的默认值。只作用于 UNET 侧，所以只有一个值。
# 下限是负的：Slider 类 LoRA（风格滑杆、细节增减）本来就是靠负值往反方向推。
DEFAULT_STRENGTH = 1.0
MIN_STRENGTH = -10.0
MAX_STRENGTH = 10.0


def new_id(prefix: str = "c") -> str:
    return f"{prefix}{uuid.uuid4().hex[:8]}"


def make_preset(name: str, text: str, pid: Optional[str] = None) -> dict:
    return {
        "id": pid or new_id("p"),
        "name": (name or "").strip() or "未命名预设",
        "text": text or "",
    }


class Library:
    def __init__(self, path: Optional[Path] = None):
        self.path = Path(path) if path else (data_dir() / LIBRARY_FILE)
        self._data: dict = {"version": SCHEMA_VERSION, "categories": [], "loras": {}}
        self._lock = threading.RLock()
        self.load()

    # ------------------------------------------------------------------ #
    # 读写
    # ------------------------------------------------------------------ #

    def load(self) -> None:
        with self._lock:
            raw = read_json(self.path, None)
            if not isinstance(raw, dict):
                self._data = {"version": SCHEMA_VERSION, "categories": [], "loras": {}}
                self._ensure_default_category()
                self.save()
                return

            categories = []
            for c in raw.get("categories") or []:
                if not isinstance(c, dict) or not c.get("id"):
                    continue
                mode = c.get("mode")
                categories.append(
                    {
                        "id": str(c["id"]),
                        "name": str(c.get("name") or "未命名类别"),
                        "mode": mode if mode in CATEGORY_MODES else "exclusive",
                        "order": int(c.get("order") or 0),
                    }
                )

            loras: Dict[str, dict] = {}
            for key, ent in (raw.get("loras") or {}).items():
                if not isinstance(ent, dict):
                    continue
                presets = []
                for p in ent.get("presets") or []:
                    if isinstance(p, dict) and (p.get("text") or p.get("name")):
                        presets.append(make_preset(p.get("name", ""), p.get("text", ""), p.get("id")))
                loras[norm(key)] = {
                    "categories": _as_list(ent.get("categories"), ent.get("category")),
                    "alias": str(ent.get("alias") or ""),
                    "model_strength": _clamp_strength(
                        ent.get("model_strength"), DEFAULT_STRENGTH
                    ),
                    "notes": str(ent.get("notes") or ""),
                    "presets": presets,
                }

            self._data = {"version": SCHEMA_VERSION, "categories": categories, "loras": loras}

            # v1 -> v2：默认类别从「单选」改成「多选」
            if int(raw.get("version") or 1) < 2:
                for c in self._data["categories"]:
                    if c["id"] == DEFAULT_CATEGORY_ID and c["mode"] != DEFAULT_CATEGORY_MODE:
                        log(f"迁移：把「{c['name']}」从 {c['mode']} 改为 {DEFAULT_CATEGORY_MODE}")
                        c["mode"] = DEFAULT_CATEGORY_MODE
                self._migrated = True

            # v2 -> v3：单类别 -> 多类别标签
            if int(raw.get("version") or 1) < 3:
                multi = sum(1 for ent in self._data["loras"].values() if len(ent["categories"]) > 1)
                log(f"迁移到 v3：LoRA 类别改为多标签（{len(self._data['loras'])} 条，其中 {multi} 条带多个标签）")
                self._migrated = True

            if self._ensure_default_category() or getattr(self, "_migrated", False):
                self._migrated = False
                self.save()

    def save(self) -> None:
        with self._lock:
            atomic_write_json(self.path, self._data)
            _sync_singleton_mtime(self.path)

    def reload(self) -> None:
        self.load()

    # ------------------------------------------------------------------ #
    # 类别
    # ------------------------------------------------------------------ #

    def _ensure_default_category(self) -> bool:
        if any(c["id"] == DEFAULT_CATEGORY_ID for c in self._data["categories"]):
            return False
        self._data["categories"].insert(
            0,
            {
                "id": DEFAULT_CATEGORY_ID,
                "name": DEFAULT_CATEGORY_NAME,
                "mode": DEFAULT_CATEGORY_MODE,
                "order": 0,
            },
        )
        self._reindex()
        return True

    def _reindex(self) -> None:
        ordered = sorted(self._data["categories"], key=lambda c: (c.get("order", 0), c.get("name", "")))
        for i, c in enumerate(ordered):
            c["order"] = i

    def categories(self) -> List[dict]:
        return sorted(self._data["categories"], key=lambda c: (c.get("order", 0), c.get("name", "")))

    def category(self, cid: str) -> Optional[dict]:
        for c in self._data["categories"]:
            if c["id"] == cid:
                return c
        return None

    def add_category(self, name: str, mode: str = "exclusive") -> dict:
        name = (name or "").strip() or "新类别"
        cat = {
            "id": new_id("cat"),
            "name": name,
            "mode": mode if mode in CATEGORY_MODES else "exclusive",
            "order": len(self._data["categories"]),
        }
        self._data["categories"].append(cat)
        self.save()
        return cat

    def update_category(self, cid: str, save: bool = True, **kw) -> Optional[dict]:
        cat = self.category(cid)
        if not cat:
            return None
        if kw.get("name"):
            cat["name"] = str(kw["name"]).strip() or cat["name"]
        if kw.get("mode") in CATEGORY_MODES:
            cat["mode"] = kw["mode"]
        if kw.get("order") is not None:
            cat["order"] = int(kw["order"])
        self._reindex()
        if save:
            self.save()
        return cat

    def delete_category(self, cid: str) -> bool:
        if cid == DEFAULT_CATEGORY_ID:
            return False
        if not self.category(cid):
            return False
        self._data["categories"] = [c for c in self._data["categories"] if c["id"] != cid]
        for ent in self._data["loras"].values():
            cats = [c for c in ent.get("categories") or [] if c != cid]
            ent["categories"] = cats
            ent["category"] = cats[0] if cats else DEFAULT_CATEGORY_ID
        self._reindex()
        self.save()
        return True

    def _clean_categories(self, value) -> List[str]:
        """过滤掉库里不存在的类别 id，去重，保持顺序。"""
        valid = {c["id"] for c in self._data["categories"]}
        out: List[str] = []
        for cid in value or []:
            cid = str(cid)
            if cid in valid and cid not in out:
                out.append(cid)
        return out

    # ------------------------------------------------------------------ #
    # LoRA
    # ------------------------------------------------------------------ #

    def entry(self, name: str, create: bool = True) -> Optional[dict]:
        n = norm(name)
        ent = self._data["loras"].get(n)
        if ent is None and create:
            ent = {
                "categories": [],
                "alias": "",
                "model_strength": DEFAULT_STRENGTH,
                "notes": "",
                "presets": [],
            }
            self._data["loras"][n] = ent
        return ent

    def effective_categories(self, name: str) -> List[str]:
        """LoRA 实际所属的类别列表；一个标签都没有时算作「未分类」。"""
        ent = self._data["loras"].get(norm(name)) or {}
        cats = self._clean_categories(ent.get("categories"))
        return cats or [DEFAULT_CATEGORY_ID]

    def effective_category(self, name: str) -> str:
        """兼容旧调用：只取第一个类别。"""
        return self.effective_categories(name)[0]

    def names_in_category(self, cid: str, scan_names: List[str]) -> List[str]:
        return sorted([n for n in scan_names if cid in self.effective_categories(n)], key=str.lower)

    def set_lora(self, name: str, save: bool = True, **kw) -> Optional[dict]:
        n = norm(name)
        if not n:
            return None
        ent = self.entry(n)
        assert ent is not None
        if kw.get("categories") is not None:
            ent["categories"] = self._clean_categories(kw["categories"])
        elif kw.get("category") is not None:  # 兼容旧的单值写法
            ent["categories"] = self._clean_categories([kw["category"]])
        if kw.get("model_strength") is not None:
            ent["model_strength"] = _clamp_strength(kw["model_strength"], DEFAULT_STRENGTH)
        if kw.get("alias") is not None:
            ent["alias"] = str(kw["alias"]).strip()[:60]
        if kw.get("notes") is not None:
            ent["notes"] = str(kw["notes"])
        if kw.get("presets") is not None:
            ent["presets"] = [
                make_preset(p.get("name", ""), p.get("text", ""), p.get("id"))
                for p in kw["presets"]
                if isinstance(p, dict) and (p.get("text") or p.get("name"))
            ]
        # 顺手写一份单值镜像，万一降级回旧版本也不会全乱
        ent["category"] = (ent.get("categories") or [DEFAULT_CATEGORY_ID])[0]
        if save:
            self.save()
        return ent

    def tag_lora(self, name: str, add: Optional[str] = None, remove: Optional[str] = None) -> Optional[dict]:
        """加/减一个类别标签，不碰其他字段。"""
        n = norm(name)
        if not n:
            return None
        ent = self.entry(n)
        assert ent is not None
        cats = self._clean_categories(ent.get("categories"))
        if remove:
            cid = str(remove)
            cats = [c for c in cats if c != cid]
        if add:
            cid = str(add)
            if cid in {c["id"] for c in self._data["categories"]} and cid not in cats:
                cats.append(cid)
        ent["categories"] = cats
        ent["category"] = cats[0] if cats else DEFAULT_CATEGORY_ID
        self.save()
        return ent

    def presets_of(self, name: str) -> List[dict]:
        ent = self._data["loras"].get(norm(name)) or {}
        return list(ent.get("presets") or [])

    def adopt_renamed(self, scan_names: List[str]) -> int:
        """把库里对不上号的条目，按「文件名唯一匹配」认领到新路径上。

        最常见的场景是把 LoRA 挪进子文件夹（`xxx.safetensors` → `子目录/xxx.safetensors`）：
        相对路径变了、文件名没变，但配置是按相对路径存的，于是类别标签和预设看起来「全丢了」。
        这里在 basename 唯一时才迁移，避免张冠李戴；预览图也一起搬过去。
        """
        from .scanner import invalidate as invalidate_scan
        from .scanner import rename_preview

        known = set(scan_names)
        by_base: Dict[str, List[str]] = {}
        for n in scan_names:
            by_base.setdefault(n.rsplit("/", 1)[-1].lower(), []).append(n)

        moved = 0
        for old in list(self._data["loras"].keys()):
            if old in known:
                continue
            cands = by_base.get(old.rsplit("/", 1)[-1].lower()) or []
            if len(cands) != 1 or cands[0] in self._data["loras"]:
                continue
            new = cands[0]
            self._data["loras"][new] = self._data["loras"].pop(old)
            rename_preview(old, new)
            log(f"认领：{old} → {new}（文件名没变，类别/强度/预设/预览图都跟过去了）")
            moved += 1

        if moved:
            self.save()
            # 预览图刚刚被改了文件名，扫描缓存里的信息已经过时，清掉让它重扫
            invalidate_scan()
        return moved

    def preset(self, name: str, pid: str) -> Optional[dict]:
        for p in self.presets_of(name):
            if p.get("id") == pid:
                return p
        return None

    # ------------------------------------------------------------------ #
    # 视图（合并扫描结果与库数据，给前端用）
    # ------------------------------------------------------------------ #

    def view(self, scan_entries: List[dict]) -> dict:
        loras = []
        for e in scan_entries:
            n = e["name"]
            ent = self._data["loras"].get(n) or {}
            loras.append(
                {
                    "name": n,
                    "display": e.get("display") or display_name(n),
                    "folder": e.get("folder") or "",
                    "top_folder": top_folder(n),
                    "exists": bool(e.get("exists")),
                    "size": e.get("size") or 0,
                    "has_preview": bool(e.get("preview")),
                    "preview": f"/lora_category_loader/api/preview?name={_q(n)}" if e.get("preview") else None,
                    "preview_ver": e.get("preview_ver") or 0,
                    "categories": self.effective_categories(n),
                    "alias": ent.get("alias", ""),
                    "model_strength": ent.get("model_strength", DEFAULT_STRENGTH),
                    "notes": ent.get("notes", ""),
                    "presets": ent.get("presets") or [],
                }
            )

        known = {e["name"] for e in scan_entries}
        missing = sorted([n for n in self._data["loras"] if n not in known])

        return {
            "categories": self.categories(),
            "loras": loras,
            "folders": sorted({top_folder(e["name"]) for e in scan_entries}, key=lambda s: (s == "", s.lower())),
            "missing": missing,
            "data_file": str(self.path),
            "default_category": DEFAULT_CATEGORY_ID,
        }


# --------------------------------------------------------------------------- #
# 单例 + 文件变动热重载
# --------------------------------------------------------------------------- #

_singleton: Optional[Library] = None
_singleton_mtime = 0.0


def _sync_singleton_mtime(path) -> None:
    global _singleton_mtime
    _singleton_mtime = mtime_of(path)


def get_library(reload_if_changed: bool = True) -> Library:
    """全局单例。文件被外部改动（手改 JSON、另一个页面）时自动重载。"""
    global _singleton, _singleton_mtime
    if _singleton is None:
        _singleton = Library()
        _singleton_mtime = mtime_of(_singleton.path)
        return _singleton
    if reload_if_changed:
        current = mtime_of(_singleton.path)
        if current != _singleton_mtime:
            log("检测到 library.json 变动，重新加载。")
            _singleton.load()
            _singleton_mtime = current
    return _singleton


def _clamp_strength(value, fallback: float) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return fallback
    return max(MIN_STRENGTH, min(MAX_STRENGTH, v))


def top_folder(name: str) -> str:
    """LoRA 相对路径的第一层目录，没有子目录时返回空串。

    常见做法是按基础模型建一级子目录（`sdxl/xxx.safetensors`），
    这个值就是节点上「只显示某个子文件夹」的过滤依据。
    """
    n = norm(name)
    return n.split("/")[0] if "/" in n else ""


def _as_list(categories, category) -> List[str]:
    """把「新多标签」和「旧单值」两种写法统一成列表。"""
    if isinstance(categories, list):
        return [str(c) for c in categories if str(c).strip()]
    if categories is not None:
        s = str(categories).strip()
        return [s] if s else []
    if category is not None:
        s = str(category).strip()
        return [s] if s else []
    return []


def _q(s: str) -> str:
    from urllib.parse import quote

    return quote(s, safe="")
