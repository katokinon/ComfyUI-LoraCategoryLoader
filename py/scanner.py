"""扫描 LoRA 目录，并读取 LoRA Manager 的元数据与预览图。"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Dict, List, Optional

from .util import data_dir, display_name, log, norm, read_json, strip_ext

_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif")

_cache: Dict[str, object] = {"key": None, "data": []}


def _folder_paths():
    import folder_paths

    return folder_paths


def _full_path(name: str) -> Optional[str]:
    """兼容不同版本的 ComfyUI（get_full_path / get_full_path_or_raise）。"""
    fp = _folder_paths()
    for fn in ("get_full_path", "get_full_path_or_raise"):
        func = getattr(fp, fn, None)
        if func is None:
            continue
        try:
            return func("loras", name)
        except Exception:
            continue
    return None


def lora_names() -> List[str]:
    """ComfyUI 原始名称列表（可直接喂给 get_full_path）。"""
    try:
        return list(_folder_paths().get_filename_list("loras"))
    except Exception as exc:
        log("枚举 LoRA 失败：", repr(exc))
        return []


def invalidate() -> None:
    """强制下次 scan() 重建索引。"""
    _cache["key"] = None


# --------------------------------------------------------------------------- #
# 预览图
# --------------------------------------------------------------------------- #

def _lm_sidecar(path: Path):
    """LoRA Manager 生成的 <模型名>.metadata.json。"""
    candidates = [
        path.with_name(path.name + ".metadata.json"),
        path.with_name(path.stem + ".metadata.json"),
        path.with_suffix(".metadata.json"),
    ]
    for cand in candidates:
        if cand.is_file():
            data = read_json(cand, None)
            if isinstance(data, dict):
                return data
    return None


def _extract_url(meta: dict) -> Optional[str]:
    for key in ("preview_url", "preview", "thumbnail", "image"):
        val = meta.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()

    civ = meta.get("civitai")
    if isinstance(civ, dict):
        url = civ.get("preview_url")
        if isinstance(url, str) and url.strip():
            return url.strip()
        images = civ.get("images")
        if isinstance(images, list):
            for img in images:
                if isinstance(img, dict):
                    u = img.get("url")
                    if isinstance(u, str) and u.strip():
                        return u.strip()

    images = meta.get("images")
    if isinstance(images, list):
        for img in images:
            if isinstance(img, dict):
                u = img.get("url")
                if isinstance(u, str) and u.strip():
                    return u.strip()
    return None


def _extra_preview_dirs() -> List[Path]:
    dirs: List[Path] = []
    try:
        import folder_paths

        base = Path(folder_paths.base_path)
    except Exception:
        return dirs
    for rel in (
        "models/lora_previews",
        "models/lora_preview",
        "models/previews",
        "models/LoraManager/previews",
        "user/default/lora_previews",
    ):
        d = base / rel
        if d.is_dir():
            dirs.append(d)
    return dirs


# --------------------------------------------------------------------------- #
# 本插件自己管理的预览图（管理面板里上传的）
# --------------------------------------------------------------------------- #

def preview_dir() -> Path:
    d = data_dir() / "previews"
    d.mkdir(parents=True, exist_ok=True)
    return d


def preview_key(name: str) -> str:
    """用 LoRA 名算一个稳定的文件名，这样不用额外记录映射关系。"""
    return hashlib.sha1(norm(name).encode("utf-8")).hexdigest()[:16]


def _by_key(key: str) -> Optional[Path]:
    d = preview_dir()
    for ext in _IMAGE_EXTS:
        p = d / (key + ext)
        if p.is_file():
            return p
    return None


def own_preview(name: str) -> Optional[Path]:
    """按名字找自己上传的预览图。

    相对路径变了（LoRA 被挪进子文件夹）时，预览图的哈希键也就跟着变。
    所以再按**文件名**兜一次底 —— 只在「同名的 LoRA 全库只有一个」时才用，
    免得两个文件夹里的同名文件互相串图。
    """
    p = _by_key(preview_key(name))
    if p is not None:
        return p

    n = norm(name)
    base = n.rsplit("/", 1)[-1]
    if not base or base == n:
        return None
    # 注意：这里绝对不能用 index()/scan() —— 本函数是在 scan() 内部被调的，
    # 那会绕回 scan 造成无限递归（scan 的缓存要到函数末尾才写入）。
    same = [x for x in lora_names() if norm(x).rsplit("/", 1)[-1].lower() == base.lower()]
    if len(same) != 1:
        return None
    return _by_key(preview_key(base))


def save_preview(name: str, data: bytes, ext: str) -> Path:
    ext = ext.lower()
    if ext not in _IMAGE_EXTS:
        ext = ".png"
    delete_preview(name)
    p = preview_dir() / (preview_key(name) + ext)
    p.write_bytes(data)
    return p


def delete_preview(name: str) -> bool:
    p = own_preview(name)
    if p is None:
        return False
    try:
        p.unlink()
        return True
    except OSError as exc:
        log("删除预览图失败：", repr(exc))
        return False


def rename_preview(old_name: str, new_name: str) -> bool:
    """LoRA 换了相对路径（挪进子文件夹/改名）时，把自有预览图跟着搬过去。

    预览图文件名是用相对路径算的哈希，路径一变就找不到；这里按新名字重算一次键名搬过去。
    """
    old_key = preview_key(old_name)
    new_key = preview_key(new_name)
    if old_key == new_key:
        return False
    d = preview_dir()
    for ext in _IMAGE_EXTS:
        src = d / (old_key + ext)
        if not src.is_file():
            continue
        try:
            src.replace(d / (new_key + ext))
            return True
        except OSError as exc:
            log("迁移预览图失败：", repr(exc))
            return False
    return False


def sniff_image_ext(data: bytes) -> Optional[str]:
    """只认真正的图片魔数 —— 顺便挡掉 SVG/HTML 这类可执行内容。"""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if data[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif"
    if data[:12].endswith(b"ftypavif"):
        return ".avif"
    return None


def preview_version(info: Optional[dict]) -> int:
    """给前端做缓存失效用。"""
    if not info:
        return 0
    if info.get("type") == "local":
        try:
            return int(os.path.getmtime(info["path"]))
        except OSError:
            return 0
    url = info.get("url") or ""
    return abs(hash(url)) % 1_000_000_000


# --------------------------------------------------------------------------- #
# 预览图
# --------------------------------------------------------------------------- #

def find_preview(name: str, abs_path: Optional[str] = None) -> Optional[dict]:
    """返回 {"type": "local", "path": ...} 或 {"type": "remote", "url": ...}。

    查找顺序：本插件上传的 -> LoRA Manager sidecar -> 模型旁的同名图 -> 预览图目录。
    abs_path 由调用方传入，避免在 scan() 内部又走一遍 resolve → index → scan 的回路。
    """
    own = own_preview(name)
    if own is not None:
        return {"type": "local", "path": str(own)}

    path = abs_path or resolve(name)
    if not path:
        return None
    p = Path(path)

    # 1) LoRA Manager 的 sidecar：优先用远端 URL（Civitai 图），其次看它记的本地路径
    meta = _lm_sidecar(p)
    if meta:
        local = meta.get("preview_path") or meta.get("local_preview")
        if isinstance(local, str) and local.strip() and Path(local).is_file():
            return {"type": "local", "path": str(Path(local))}
        url = _extract_url(meta)
        if url:
            return {"type": "remote", "url": url}

    # 2) 模型文件旁边的同名图片
    for stem in (p.stem + ".preview", p.stem):
        for ext in _IMAGE_EXTS:
            cand = p.with_name(stem + ext)
            if cand.is_file():
                return {"type": "local", "path": str(cand)}

    # 3) 常见的预览图目录
    rel = Path(strip_ext(norm(name)))
    for base_dir in _extra_preview_dirs():
        target_dir = base_dir / rel.parent if str(rel.parent) != "." else base_dir
        for stem in (rel.name, rel.name + ".preview"):
            for ext in _IMAGE_EXTS:
                cand = target_dir / (stem + ext)
                if cand.is_file():
                    return {"type": "local", "path": str(cand)}
    return None


# --------------------------------------------------------------------------- #
# 索引
# --------------------------------------------------------------------------- #

def scan() -> List[dict]:
    raw_names = lora_names()
    key = tuple(raw_names)
    if _cache["key"] == key:
        return list(_cache["data"])  # type: ignore[arg-type]

    out: List[dict] = []
    for raw in raw_names:
        n = norm(raw)
        abs_path = _full_path(raw)
        is_file = bool(abs_path and os.path.isfile(abs_path))
        parent = str(Path(strip_ext(n)).parent).replace("\\", "/")
        folder = "" if parent in (".", "") else parent
        info = find_preview(n, abs_path)
        out.append(
            {
                "name": n,
                "raw": raw,
                "display": display_name(n),
                "folder": folder,
                "path": abs_path,
                "exists": is_file,
                "size": os.path.getsize(abs_path) if is_file else 0,
                "preview": info,
                "preview_ver": preview_version(info),
            }
        )

    out.sort(key=lambda e: e["name"].lower())
    _cache["key"] = key
    _cache["data"] = out
    return list(out)


def index() -> Dict[str, dict]:
    return {e["name"]: e for e in scan()}


def resolve(name: str) -> Optional[str]:
    """把相对名解析成绝对路径。

    直接问 ComfyUI，不经过 index —— index 内部会调 scan()，而 scan() 又要解析
    路径来找预览图，绕回去就是无限递归。
    """
    return _full_path(norm(name))
