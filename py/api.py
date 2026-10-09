"""HTTP 路由：管理面板页面 + 数据读写 API。

面板地址：http://<你的 ComfyUI 地址>/lora_category_loader
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from .scanner import (
    delete_preview,
    find_preview,
    invalidate as invalidate_scan,
    save_preview,
    scan,
    sniff_image_ext,
)
from .store import get_library
from .util import log, norm

MAX_PREVIEW_BYTES = 8 * 1024 * 1024

# 面板是普通网页，故意放在 WEB_DIRECTORY（./js）之外 —— 否则 ComfyUI 会把
# panel.js 当成前端扩展模块自动 import 进主页面，直接报错。
PANEL_DIR = (Path(__file__).resolve().parents[1] / "panel").resolve()
BASE = "/lora_category_loader"

_registered = False


def register() -> None:
    global _registered
    if _registered:
        return

    from aiohttp import web
    from server import PromptServer

    routes = PromptServer.instance.routes

    # ------------------------------------------------------------------ #
    # 页面与静态资源
    # ------------------------------------------------------------------ #

    @routes.get(BASE)
    @routes.get(BASE + "/")
    async def _panel(_request):
        index = PANEL_DIR / "index.html"
        if not index.is_file():
            return web.Response(status=500, text="管理面板文件缺失：web/panel/index.html")
        return web.FileResponse(index)

    @routes.get(BASE + "/assets/{name}")
    async def _asset(request):
        name = request.match_info.get("name", "")
        target = (PANEL_DIR / name).resolve()
        if not str(target).startswith(str(PANEL_DIR)) or not target.is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(target)

    # ------------------------------------------------------------------ #
    # 数据
    # ------------------------------------------------------------------ #

    @routes.get(BASE + "/api/state")
    async def _state(_request):
        return web.json_response(_view())

    @routes.post(BASE + "/api/rescan")
    async def _rescan(_request):
        invalidate_scan()
        return web.json_response(_view())

    # ------------------------------------------------------------------ #
    # 类别
    # ------------------------------------------------------------------ #

    @routes.post(BASE + "/api/category")
    async def _category_save(request):
        body = await _body(request)
        lib = get_library()
        cid = body.get("id")
        if cid:
            cat = lib.update_category(
                str(cid), name=body.get("name"), mode=body.get("mode"), order=body.get("order")
            )
            if cat is None:
                return web.json_response({"ok": False, "error": "类别不存在"}, status=404)
        else:
            cat = lib.add_category(body.get("name", ""), body.get("mode", "exclusive"))
        return web.json_response({"ok": True, "category": cat, "categories": lib.categories()})

    @routes.post(BASE + "/api/category/delete")
    async def _category_delete(request):
        body = await _body(request)
        lib = get_library()
        ok = lib.delete_category(str(body.get("id") or ""))
        return web.json_response(
            {"ok": ok, "categories": lib.categories(), "reason": None if ok else "默认类别不可删除"}
        )

    @routes.post(BASE + "/api/category/reorder")
    async def _category_reorder(request):
        body = await _body(request)
        lib = get_library()
        ids = body.get("ids") or []
        for i, cid in enumerate(ids):
            lib.update_category(str(cid), save=False, order=i)
        lib.save()
        return web.json_response({"ok": True, "categories": lib.categories()})

    # ------------------------------------------------------------------ #
    # LoRA
    # ------------------------------------------------------------------ #

    @routes.post(BASE + "/api/lora")
    async def _lora_save(request):
        body = await _body(request)
        name = norm(body.get("name", ""))
        if not name:
            return web.json_response({"ok": False, "error": "缺少 name"}, status=400)
        lib = get_library()
        # 允许只更新单个字段，这里做整体替换（前端永远提交完整列表）
        entry = lib.set_lora(
            name,
            categories=body.get("categories"),
            category=body.get("category"),
            model_strength=body.get("model_strength"),
            clip_strength=body.get("clip_strength"),
            notes=body.get("notes"),
            presets=body.get("presets"),
        )
        return web.json_response(
            {"ok": True, "lora": entry, "categories": lib.effective_categories(name)}
        )

    @routes.post(BASE + "/api/lora/tag")
    async def _lora_tag(request):
        """加 / 减一个类别标签。一个 LoRA 可以有多个标签，所以这里不动别的标签。"""
        body = await _body(request)
        name = norm(body.get("name", ""))
        if not name:
            return web.json_response({"ok": False, "error": "缺少 name"}, status=400)
        add = body.get("add")
        remove = body.get("remove")
        if not add and not remove:
            return web.json_response({"ok": False, "error": "要给出 add 或 remove"}, status=400)
        lib = get_library()
        lib.tag_lora(name, add=str(add) if add else None, remove=str(remove) if remove else None)
        return web.json_response({"ok": True, "categories": lib.effective_categories(name)})

    @routes.post(BASE + "/api/lora/bulk")
    async def _lora_bulk(request):
        body = await _body(request)
        names = [norm(n) for n in (body.get("names") or []) if str(n).strip()]
        if not names:
            return web.json_response({"ok": False, "error": "没有传入 name"}, status=400)
        lib = get_library()
        add = body.get("add_category")
        remove = body.get("remove_category")
        for name in names:
            if add or remove:
                lib.tag_lora(name, add=str(add) if add else None, remove=str(remove) if remove else None)
                continue
            kwargs = {}
            if "categories" in body:
                kwargs["categories"] = body["categories"]
            if "category" in body:
                kwargs["category"] = body["category"]
            if "model_strength" in body:
                kwargs["model_strength"] = body["model_strength"]
            if "clip_strength" in body:
                kwargs["clip_strength"] = body["clip_strength"]
            lib.set_lora(name, save=False, **kwargs)
        # tag_lora 内部已经存过盘了，这里再存一次是幂等的
        lib.save()
        return web.json_response({"ok": True, "count": len(names)})

    @routes.post(BASE + "/api/autotag")
    async def _autotag(_request):
        count, categories = auto_tag_by_folder()
        lib = get_library()
        return web.json_response(
            {
                "ok": True,
                "assigned": count,
                "created_categories": categories,
                "state": _view(),
            }
        )

    # ------------------------------------------------------------------ #
    # 预览图
    # ------------------------------------------------------------------ #

    @routes.get(BASE + "/api/preview")
    async def _preview(request):
        name = norm(request.query.get("name", ""))
        if not name:
            raise web.HTTPNotFound()
        info = find_preview(name)
        if not info:
            raise web.HTTPNotFound()
        if info.get("type") == "local":
            return web.FileResponse(info["path"], headers={"Cache-Control": "public, max-age=300"})
        raise web.HTTPFound(info["url"])

    @routes.post(BASE + "/api/preview/upload")
    async def _preview_upload(request):
        """multipart/form-data：name = LoRA 名，file = 图片。"""
        try:
            reader = await request.multipart()
        except Exception:
            return web.json_response({"ok": False, "error": "需要 multipart/form-data"}, status=400)

        name = ""
        data = b""
        while True:
            part = await reader.next()
            if part is None:
                break
            if part.name == "name":
                name = norm(await part.text())
            elif part.name in ("file", "image"):
                chunks = []
                total = 0
                while True:
                    chunk = await part.read_chunk()
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_PREVIEW_BYTES:
                        return web.json_response(
                            {"ok": False, "error": "图片太大了，上限 8MB"}, status=413
                        )
                    chunks.append(chunk)
                data = b"".join(chunks)

        if not name:
            return web.json_response({"ok": False, "error": "缺少 name"}, status=400)
        if not data:
            return web.json_response({"ok": False, "error": "没有收到图片内容"}, status=400)

        ext = sniff_image_ext(data)
        if not ext:
            return web.json_response(
                {"ok": False, "error": "只支持 PNG / JPG / WEBP / GIF / AVIF 图片"}, status=415
            )

        try:
            saved = save_preview(name, data, ext)
        except Exception as exc:
            log("保存预览图失败：", repr(exc))
            return web.json_response({"ok": False, "error": "保存失败"}, status=500)

        invalidate_scan()
        lib = get_library()
        return web.json_response(
            {
                "ok": True,
                "path": str(saved),
                "size": len(data),
                "state": _view(),
            }
        )

    @routes.post(BASE + "/api/preview/delete")
    async def _preview_delete(request):
        body = await _body(request)
        name = norm(body.get("name", ""))
        if not name:
            return web.json_response({"ok": False, "error": "缺少 name"}, status=400)
        removed = delete_preview(name)
        invalidate_scan()
        lib = get_library()
        return web.json_response({"ok": True, "removed": removed, "state": _view()})

    _registered = True
    log(f"管理面板已挂载：{BASE}")


def _view() -> dict:
    """给面板/节点用的状态快照。

    顺手做一次「认领」：LoRA 被挪进子文件夹或改名后，库里的记录是按旧的相对路径存的，
    不认领的话用户会看到「标签和预设全没了」。
    """
    lib = get_library()
    entries = scan()
    lib.adopt_renamed([e["name"] for e in entries])
    return lib.view(entries)


async def _body(request) -> dict:
    try:
        data = await request.json()
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


# --------------------------------------------------------------------------- #
# 按文件夹自动归类
# --------------------------------------------------------------------------- #

def auto_tag_by_folder() -> tuple[int, list[str]]:
    """把 models/loras 下的子目录名当作类别，批量归类。

    只处理「还没有被手动改过类别」的 LoRA —— 也就是仍停留在默认类别里的那些，
    避免覆盖你已经手动整理过的结果。
    """
    from .store import DEFAULT_CATEGORY_ID

    lib = get_library()
    created: list[str] = []
    by_name = {c["name"]: c for c in lib.categories()}
    assigned = 0

    for entry in scan():
        folder = entry.get("folder") or ""
        if not folder:
            continue
        top = folder.split("/")[0].strip()
        if not top:
            continue
        if lib.effective_categories(entry["name"]) != [DEFAULT_CATEGORY_ID]:
            continue

        cat = by_name.get(top)
        if cat is None:
            cat = lib.add_category(top, "exclusive")
            by_name[top] = cat
            created.append(top)
        lib.tag_lora(entry["name"], add=cat["id"])
        assigned += 1

    lib.save()
    return assigned, created
