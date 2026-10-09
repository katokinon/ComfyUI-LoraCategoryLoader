"""通用工具：路径解析、原子 JSON 读写、日志。"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any, Dict

PREFIX = "[LoRA分类加载]"

_KNOWN_EXTS = (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".sft", ".gguf")


def log(*args: Any) -> None:
    """统一前缀输出，方便在 ComfyUI 控制台里过滤。"""
    print(PREFIX, *args, flush=True)


def norm(name: str) -> str:
    """统一成正斜杠的相对路径，去首尾空白。这是本插件的全局主键形式。"""
    return (name or "").replace("\\", "/").strip()


def strip_ext(name: str) -> str:
    n = norm(name)
    low = n.lower()
    for ext in _KNOWN_EXTS:
        if low.endswith(ext):
            return n[: -len(ext)]
    return n


def display_name(name: str) -> str:
    """去掉目录与扩展名，用于界面展示。"""
    return Path(strip_ext(name)).name


def comfy_user_dir() -> Path:
    """拿到 ComfyUI 的 user 目录；数据文件放这里，插件升级不会丢。"""
    try:
        import folder_paths

        try:
            return Path(folder_paths.get_user_directory())
        except Exception:
            return Path(folder_paths.base_path) / "user" / "default"
    except Exception:
        return Path(__file__).resolve().parents[2] / "user_data"


def data_dir() -> Path:
    d = comfy_user_dir() / "lora_category_loader"
    d.mkdir(parents=True, exist_ok=True)
    return d


_locks: Dict[str, threading.RLock] = {}
_locks_guard = threading.Lock()


def file_lock(path) -> threading.RLock:
    key = str(path)
    with _locks_guard:
        lock = _locks.get(key)
        if lock is None:
            lock = threading.RLock()
            _locks[key] = lock
        return lock


def read_json(path, default=None):
    p = Path(path)
    if not p.exists():
        return default
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:
        log(f"读取 {p.name} 失败：{exc!r}")
        return default


def atomic_write_json(path, data) -> None:
    """先写临时文件再 os.replace，避免写一半被读到。"""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(p.parent), prefix=p.name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, p)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def mtime_of(path) -> float:
    try:
        return os.path.getmtime(path)
    except OSError:
        return 0.0
