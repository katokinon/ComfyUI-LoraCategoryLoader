"""离线自检：用桩件模拟 ComfyUI 环境，验证不依赖 torch / comfy 的那部分逻辑。

    python tests/selftest.py

覆盖：扫描索引、LoRA Manager 预览图读取、类别/预设持久化、
节点 A 的动态下拉生成、节点 B 的提示词拼接顺序与分隔符。
"""

from __future__ import annotations

import json
import sys
import tempfile
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

TMP = Path(tempfile.mkdtemp(prefix="lora_cat_selftest_"))
LORA_DIR = TMP / "models" / "loras"
USER_DIR = TMP / "user"

PNG_1PX = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06"
    b"\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05"
    b"\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)

FAILED: list[str] = []


def check(label: str, cond: bool, extra: str = "") -> None:
    mark = "  ok  " if cond else " FAIL "
    print(f"[{mark}] {label}" + (f"  ({extra})" if extra else ""))
    if not cond:
        FAILED.append(label)


def build_fake_tree() -> None:
    for rel in ("角色/miku_v3.safetensors", "角色/rem_v2.safetensors", "画风/film.safetensors", "plain.safetensors"):
        p = LORA_DIR / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"fake-lora")

    # 模型旁边的本地预览图
    (LORA_DIR / "角色" / "miku_v3.preview.png").write_bytes(PNG_1PX)

    # LoRA Manager 风格的 sidecar（真实数据里 preview_url 一般就指向 Civitai 的图）
    (LORA_DIR / "画风" / "film.safetensors.metadata.json").write_text(
        json.dumps(
            {
                "file_name": "film.safetensors",
                "preview_url": "https://example.invalid/civitai/film.png",
                "civitai": {"images": [{"url": "https://example.invalid/civitai/film.png"}]},
            }
        ),
        encoding="utf-8",
    )


def install_stub_folder_paths() -> None:
    mod = types.ModuleType("folder_paths")
    mod.base_path = str(TMP)
    mod.models_dir = str(TMP / "models")

    def get_user_directory():
        return str(USER_DIR)

    def get_filename_list(kind):
        if kind != "loras":
            return []
        return sorted(
            p.relative_to(LORA_DIR).as_posix() for p in LORA_DIR.rglob("*.safetensors")
        )

    def get_full_path(kind, name):
        p = LORA_DIR / name
        return str(p) if p.is_file() else None

    mod.get_user_directory = get_user_directory
    mod.get_filename_list = get_filename_list
    mod.get_full_path = get_full_path
    sys.modules["folder_paths"] = mod


def main() -> int:
    build_fake_tree()
    install_stub_folder_paths()

    from py import scanner
    from py.scanner import _extract_url
    from py.store import DEFAULT_CATEGORY_ID, get_library
    from py.nodes.lora_category_loader import NONE, WIDGET_PREFIX, LoraCategoryLoader
    from py.nodes.lora_prompt_picker import LoraPromptPicker

    print("\n=== 1. 扫描索引 ===")
    entries = scanner.scan()
    names = [e["name"] for e in entries]
    check("扫到 4 个 LoRA", len(entries) == 4, ", ".join(names))
    check("路径统一成正斜杠", "角色/miku_v3.safetensors" in names)
    by_name = {e["name"]: e for e in entries}
    check(
        "子目录识别为文件夹名",
        by_name["角色/miku_v3.safetensors"]["folder"] == "角色",
        by_name["角色/miku_v3.safetensors"]["folder"],
    )
    check("根目录 LoRA 的 folder 为空", by_name["plain.safetensors"]["folder"] == "")
    check("display 去掉了目录与扩展名", by_name["角色/miku_v3.safetensors"]["display"] == "miku_v3")

    print("\n=== 2. 预览图 ===")
    p1 = by_name["角色/miku_v3.safetensors"]["preview"]
    check("读到模型旁的本地预览图", p1 and p1["type"] == "local", str(p1 and p1["type"]))
    p2 = by_name["画风/film.safetensors"]["preview"]
    check(
        "读到 LoRA Manager sidecar 的远端预览图",
        p2 and p2["type"] == "remote" and "civitai" in p2["url"],
        str(p2 and p2.get("url")),
    )
    check("没有预览图的 LoRA 返回 None", by_name["plain.safetensors"]["preview"] is None)
    check(
        "sidecar 只带 civitai 图时也能取到 URL",
        _extract_url({"civitai": {"images": [{"url": "https://a/1.png"}]}}) == "https://a/1.png",
    )
    check(
        "preview_url 优先于 civitai 图",
        _extract_url({"preview_url": "https://a/p.png", "civitai": {"images": [{"url": "https://a/c.png"}]}})
        == "https://a/p.png",
    )
    check("sidecar 里没有可用字段时返回 None", _extract_url({"foo": "bar"}) is None)

    print("\n=== 3. 类别与预设持久化 ===")
    lib = get_library()
    lib_path = lib.path
    check("库文件落在 user 目录下", "lora_category_loader" in str(lib_path), str(lib_path))
    check("默认类别已自动创建", any(c["id"] == DEFAULT_CATEGORY_ID for c in lib.categories()))
    check(
        "未打标签的 LoRA 归入默认类别",
        lib.effective_category("plain.safetensors") == DEFAULT_CATEGORY_ID,
    )

    cat_char = lib.add_category("角色", "exclusive")
    cat_style = lib.add_category("画风", "exclusive")
    lib.set_lora(
        "角色/miku_v3.safetensors",
        category=cat_char["id"],
        model_strength=0.85,
        clip_strength=0.7,
        presets=[
            {"id": "p1", "name": "日常", "text": "1girl, hatsune miku, twin tails"},
            {"id": "p2", "name": "赛博", "text": "cyberpunk miku, neon lights"},
        ],
    )
    lib.set_lora(
        "画风/film.safetensors",
        category=cat_style["id"],
        presets=[{"id": "p3", "name": "胶片", "text": "film grain, muted colors"}],
    )
    lib.set_lora("角色/rem_v2.safetensors", category=cat_char["id"])
    # plain.safetensors 故意不打标签，用来验证「未分类」兜底

    reloaded = type(lib)(lib_path)
    check("重新读取后类别还在", len(reloaded.categories()) == 3, str([c["name"] for c in reloaded.categories()]))
    check("重新读取后预设还在", len(reloaded.presets_of("角色/miku_v3.safetensors")) == 2)
    check("重新读取后强度还在", reloaded.entry("角色/miku_v3.safetensors")["model_strength"] == 0.85)

    print("\n=== 3b. 类别多标签（一个 LoRA 挂多个类别） ===")
    target_multi = "画风/film.safetensors"
    check(
        "初始只有一个标签",
        lib.effective_categories(target_multi) == [cat_style["id"]],
        str(lib.effective_categories(target_multi)),
    )
    lib.set_lora(target_multi, categories=[cat_style["id"], cat_char["id"]])
    check(
        "设成两个标签后按给定顺序记下来",
        lib.effective_categories(target_multi) == [cat_style["id"], cat_char["id"]],
        str(lib.effective_categories(target_multi)),
    )
    scan_names_now = [e["name"] for e in scanner.scan()]
    check(
        "两个类别的成员列表里都能看到它",
        target_multi in lib.names_in_category(cat_style["id"], scan_names_now)
        and target_multi in lib.names_in_category(cat_char["id"], scan_names_now),
    )
    lib.tag_lora(target_multi, add=DEFAULT_CATEGORY_ID)
    check(
        "tag_lora 是追加，不覆盖原有标签",
        lib.effective_categories(target_multi) == [cat_style["id"], cat_char["id"], DEFAULT_CATEGORY_ID],
        str(lib.effective_categories(target_multi)),
    )
    lib.tag_lora(target_multi, remove=cat_char["id"])
    check(
        "tag_lora 只摘掉指定的那一个",
        lib.effective_categories(target_multi) == [cat_style["id"], DEFAULT_CATEGORY_ID],
        str(lib.effective_categories(target_multi)),
    )
    lib.tag_lora(target_multi, remove=DEFAULT_CATEGORY_ID)
    check(
        "还剩下原来那个标签",
        lib.effective_categories(target_multi) == [cat_style["id"]],
        str(lib.effective_categories(target_multi)),
    )
    lib.tag_lora(target_multi, remove=cat_style["id"])
    check(
        "标签减到零之后自动回到「未分类」",
        lib.effective_categories(target_multi) == [DEFAULT_CATEGORY_ID],
        str(lib.effective_categories(target_multi)),
    )
    check(
        "不存在的类别 id 会被丢掉",
        lib.set_lora(target_multi, categories=["早就没有的类别", cat_style["id"]])["categories"]
        == [cat_style["id"]],
    )
    check(
        "同一个标签写两次只留一个",
        lib.set_lora(target_multi, categories=[cat_style["id"], cat_style["id"]])["categories"]
        == [cat_style["id"]],
    )

    view = lib.view(scanner.scan())
    one = next(l for l in view["loras"] if l["name"] == target_multi)
    check("view 里给的是 categories 列表", one["categories"] == [cat_style["id"]], str(one["categories"]))
    check("view 里带了 top_folder（给文件夹过滤用）", one["top_folder"] == "画风", one["top_folder"])
    check("view 里列出了所有一级子文件夹", {"角色", "画风"} <= set(view["folders"]), str(view["folders"]))
    root_lora = next(l for l in view["loras"] if l["name"] == "plain.safetensors")
    check("根目录 LoRA 的 top_folder 是空串", root_lora["top_folder"] == "", repr(root_lora["top_folder"]))

    print("\n=== 4. 节点 A 的动态下拉 ===")
    inputs = LoraCategoryLoader.INPUT_TYPES()
    required = inputs["required"]
    optional = inputs["optional"]
    check(
        "MODEL / CLIP 是可选输入（不接线也能跑，只输出名称与语法）",
        "model" in optional and "clip" in optional and "model" not in required and "clip" not in required,
    )
    widget_names = [k for k in required if k.startswith(WIDGET_PREFIX)]
    check("每个类别生成一个下拉", len(widget_names) == 3, ", ".join(widget_names))
    char_widget = required[WIDGET_PREFIX + cat_char["id"]][0]
    check("下拉第一项是「不使用」", char_widget[0] == NONE, char_widget[0])
    check(
        "下拉里是该类别名下的 LoRA（单选=同类互斥）",
        sorted(char_widget[1:]) == ["角色/miku_v3.safetensors", "角色/rem_v2.safetensors"],
        str(char_widget[1:]),
    )
    style_widget = required[WIDGET_PREFIX + cat_style["id"]][0]
    check("另一个类别只列出自己的 LoRA", style_widget[1:] == ["画风/film.safetensors"], str(style_widget[1:]))
    default_widget = required[WIDGET_PREFIX + DEFAULT_CATEGORY_ID][0]
    check(
        "未打标签的 LoRA 落在「未分类」下拉里",
        default_widget[1:] == ["plain.safetensors"],
        str(default_widget[1:]),
    )
    check("下拉顺序跟随类别顺序", widget_names[0] == WIDGET_PREFIX + DEFAULT_CATEGORY_ID)

    print("\n=== 5. 节点 B 的提示词拼接 ===")
    picker = LoraPromptPicker()
    upstream = "角色/miku_v3.safetensors\n画风/film.safetensors"
    selection = json.dumps({"角色/miku_v3.safetensors": ["p2", "p1"], "画风/film.safetensors": ["p3"]})

    prompt, report = picker.pick(upstream, selection, "换行")
    expected = "1girl, hatsune miku, twin tails\ncyberpunk miku, neon lights\nfilm grain, muted colors"
    check("按 LoRA 加载顺序 + 库内预设顺序拼接", prompt == expected, repr(prompt))
    check("换行分隔", prompt.count("\n") == 2)
    check("REPORT 记录了来源", report.splitlines()[0].startswith("角色/miku_v3.safetensors →") , repr(report))

    prompt2, _ = picker.pick(upstream, selection, "逗号+空格")
    check("换成逗号分隔", prompt2 == expected.replace("\n", ", "), repr(prompt2))

    prompt3, _ = picker.pick(
        upstream, json.dumps({"角色/miku_v3.safetensors": ["p1"], "画风/film.safetensors": []}), "换行"
    )
    check("未勾选的 LoRA 不输出", prompt3 == "1girl, hatsune miku, twin tails", repr(prompt3))

    prompt4, _ = picker.pick(upstream, "{}", "换行")
    check("全不勾选时输出空串", prompt4 == "")

    prompt5, _ = picker.pick(upstream, "不是json", "换行")
    check("非法 selection 不会崩，按空处理", prompt5 == "")

    prompt6, _ = picker.pick(upstream, selection, "换行", prefix="[前缀]", suffix="[后缀]")
    check(
        "前缀后缀各占独立一段，跟正文用同一个分隔符隔开",
        prompt6 == "[前缀]\n" + expected + "\n[后缀]",
        repr(prompt6),
    )
    prompt6b, _ = picker.pick(upstream, selection, "逗号+空格", prefix="[前缀]", suffix="[后缀]")
    check(
        "换成逗号时前后缀也跟着换",
        prompt6b == "[前缀], " + expected.replace("\n", ", ") + ", [后缀]",
        repr(prompt6b),
    )
    prompt6c, _ = picker.pick(upstream, selection, "换行", prefix="  ", suffix="")
    check("空白的前后缀不产生多余分隔符", prompt6c == expected, repr(prompt6c))
    prompt6d, _ = picker.pick(upstream, "{}", "换行", prefix="[前缀]", suffix="[后缀]")
    check(
        "一个都没勾时只剩前后缀（且不糊成一行）",
        prompt6d == "[前缀]\n[后缀]",
        repr(prompt6d),
    )
    prompt6e, _ = picker.pick(upstream, "{}", "换行", prefix="", suffix="")
    check("什么都没勾、也没前后缀 -> 空串", prompt6e == "", repr(prompt6e))

    prompt7, _ = picker.pick(
        upstream + "\n角色/miku_v3.safetensors", selection, "换行"
    )
    check("上游若重复同一个 LoRA，不会重复输出", prompt7 == expected, repr(prompt7))

    print("\n=== 6. 折叠面板状态解析（与下拉框降级的边界） ===")
    from py.nodes.lora_category_loader import parse_selection, picks_from_combos

    check("空字符串 -> 回退下拉框", parse_selection("") is None)
    check("'{}' -> 回退下拉框", parse_selection("{}") is None)
    check("非法 JSON -> 回退下拉框", parse_selection("{oops") is None)
    check("列表不是对象 -> 回退下拉框", parse_selection("[1,2]") is None)
    check("没有 ui 标记 -> 回退下拉框", parse_selection('{"cats":{"x":["y"]}}') is None)
    check(
        "界面在用但什么都没选 -> 空列表，不回退",
        parse_selection(json.dumps({"ui": True, "cats": {}, "temps": []})) == [],
    )

    panel_state = {
        "ui": True,
        "cats": {
            # 故意把「画风」写在前面，验证顺序跟的是库里的类别顺序而不是 JSON 键顺序
            cat_style["id"]: ["画风/film.safetensors"],
            cat_char["id"]: ["角色/rem_v2.safetensors", "角色/miku_v3.safetensors"],
        },
        "temps": [{"id": "t1", "name": "临时", "loras": ["plain.safetensors"]}],
        "strength": {"角色/miku_v3.safetensors": {"model": 1.2, "clip": 0.3}},
    }
    picks = parse_selection(json.dumps(panel_state))
    order = [p[0] for p in picks]
    expect_order = [
        "角色/rem_v2.safetensors",
        "角色/miku_v3.safetensors",
        "画风/film.safetensors",
        "plain.safetensors",
    ]
    check("顺序 = 类别顺序 -> 类别内数组顺序 -> 临时分类", order == expect_order, str(order))
    by_pick = {p[0]: p for p in picks}
    check("工作流内的强度覆盖被读出来", by_pick["角色/miku_v3.safetensors"][1:] == (1.2, 0.3))
    check("没覆盖的 LoRA 强度留空（用库里的）", by_pick["角色/rem_v2.safetensors"][1:] == (None, None))

    ghost = dict(panel_state)
    ghost["cats"] = {"已删除的类别id": ["plain.safetensors"]}
    ghost["temps"] = []
    check(
        "库里已不存在的类别 id 里的选择也不丢",
        [p[0] for p in parse_selection(json.dumps(ghost))] == ["plain.safetensors"],
    )

    dup = dict(panel_state)
    dup["cats"] = {cat_char["id"]: ["角色/miku_v3.safetensors"], cat_style["id"]: ["角色/miku_v3.safetensors"]}
    dup["temps"] = []
    check(
        "同一个 LoRA 被两个类别同时选中时只加载一次",
        [p[0] for p in parse_selection(json.dumps(dup))] == ["角色/miku_v3.safetensors"],
    )

    combos = {
        "loracat_" + DEFAULT_CATEGORY_ID: "plain.safetensors",
        "loracat_" + cat_char["id"]: "角色/miku_v3.safetensors",
        "loracat_" + cat_style["id"]: NONE,
    }
    fc = picks_from_combos(lib, combos)
    check(
        "降级通路：下拉框按类别顺序读出",
        [p[0] for p in fc] == ["plain.safetensors", "角色/miku_v3.safetensors"],
        str([p[0] for p in fc]),
    )
    check("降级通路不返回强度覆盖", all(p[1] is None and p[2] is None for p in fc))

    print("\n=== 6c. v2 状态格式（全局启用列表 on） ===")
    v2_state = {
        "ui": True,
        "v": 2,
        "on": ["角色/miku_v3.safetensors", "plain.safetensors", "画风/film.safetensors"],
        "temps": [{"id": "t1", "name": "临时", "loras": []}],
        "strength": {"角色/miku_v3.safetensors": {"model": 1.2, "clip": 0.3}},
        "folder": "角色",
    }
    picks_v2 = parse_selection(json.dumps(v2_state, ensure_ascii=False))
    check(
        "v2：按库里的类别顺序重排，不跟勾选顺序",
        [p[0] for p in picks_v2]
        == ["plain.safetensors", "角色/miku_v3.safetensors", "画风/film.safetensors"],
        str([p[0] for p in picks_v2]),
    )
    check(
        "v2：工作流内的强度覆盖照旧读出来",
        {p[0]: p[1:] for p in picks_v2}["角色/miku_v3.safetensors"] == (1.2, 0.3),
    )
    check("v2：没写强度覆盖的留空", {p[0]: p[1:] for p in picks_v2}["plain.safetensors"] == (None, None))
    check(
        "v2：同一个 LoRA 写两次只算一次",
        len(parse_selection(json.dumps({"ui": True, "v": 2, "on": ["plain.safetensors", "plain.safetensors"]}))) == 1,
    )
    check("v2：空列表是有效状态（不回退下拉框）", parse_selection(json.dumps({"ui": True, "v": 2, "on": []})) == [])
    check(
        "v2：folder 字段不影响加载结果（只影响界面）",
        [p[0] for p in parse_selection(json.dumps({**v2_state, "folder": "画风"}, ensure_ascii=False))]
        == [p[0] for p in picks_v2],
    )

    # 一个 LoRA 挂两个类别时，只在「第一个类别」的位置出现一次
    lib.set_lora("画风/film.safetensors", categories=[cat_style["id"], cat_char["id"]])
    picks_multi = parse_selection(
        json.dumps({"ui": True, "v": 2, "on": ["角色/miku_v3.safetensors", "画风/film.safetensors"]})
    )
    check(
        "v2：多标签的 LoRA 按第一个类别定位、且只出现一次",
        [p[0] for p in picks_multi] == ["画风/film.safetensors", "角色/miku_v3.safetensors"],
        str([p[0] for p in picks_multi]),
    )
    lib.set_lora("画风/film.safetensors", categories=[cat_style["id"]])

    print("\n=== 6b. 不接 model / clip 的裸跑（为了单独看提示词） ===")
    bare = json.dumps(
        {
            "ui": True,
            "cats": {
                cat_char["id"]: ["角色/miku_v3.safetensors"],
                cat_style["id"]: ["画风/film.safetensors"],
            },
            "temps": [{"id": "t1", "name": "临时", "loras": ["plain.safetensors"]}],
        }
    )
    m, c, bare_names, bare_syntax = LoraCategoryLoader().load(model=None, clip=None, selection=bare)
    check(
        "裸跑照样输出 LoRA 名称（顺序 = 类别顺序 -> 临时分类）",
        bare_names.split("\n") == ["角色/miku_v3.safetensors", "画风/film.safetensors", "plain.safetensors"],
        repr(bare_names),
    )
    check(
        "裸跑照样输出语法串，强度取库里的值",
        bare_syntax.split("\n")[0] == "<lora:角色/miku_v3.safetensors:0.85>",
        repr(bare_syntax),
    )
    check("裸跑不返回 model / clip", m is None and c is None)
    check("裸跑不会去 import comfy.sd（懒加载生效）", "comfy.sd" not in sys.modules)

    # 桩掉 comfy.sd，验证「接了 model/clip 就真的会去加载」以及传进去的强度
    calls = []

    def _fake_load(model, clip, path, ms, cs):
        calls.append((path, round(float(ms), 4), round(float(cs), 4)))
        return (model, clip)

    fake_sd = types.ModuleType("comfy.sd")
    fake_sd.load_lora_for_models = _fake_load
    fake_comfy = types.ModuleType("comfy")
    fake_comfy.sd = fake_sd
    sys.modules["comfy"] = fake_comfy
    sys.modules["comfy.sd"] = fake_sd

    got_m, got_c = object(), object()
    m2, c2, names2, syntax2 = LoraCategoryLoader().load(model=got_m, clip=got_c, selection=bare)
    check("接了 model / clip 时真的会去加载", len(calls) == 3, f"{len(calls)} 次")
    check(
        "加载顺序 = 名称输出顺序",
        [Path(c[0]).name for c in calls] == [Path(n).name for n in names2.split("\n")],
        str([Path(c[0]).name for c in calls]),
    )
    check("传进加载器的强度 = 库里的值（0.85 / 0.7）", calls[0][1:] == (0.85, 0.7), str(calls[0][1:]))
    check("model / clip 原样透传（桩件不改变对象）", m2 is got_m and c2 is got_c)
    check(
        "接了线路时同样输出名称与语法",
        names2.split("\n") == ["角色/miku_v3.safetensors", "画风/film.safetensors", "plain.safetensors"],
        repr(names2),
    )

    calls.clear()
    LoraCategoryLoader().load(model=got_m, clip=got_c, global_strength=2.0, selection=bare)
    check("global_strength 会乘到每个 LoRA 上", calls[0][1:] == (1.7, 1.4), str(calls[0][1:]))

    del sys.modules["comfy"], sys.modules["comfy.sd"]

    print("\n=== 7. 预览图上传 / 删除 ===")
    check(
        "「未分类」默认是多选（不再互斥）",
        lib.category(DEFAULT_CATEGORY_ID)["mode"] == "multi",
        lib.category(DEFAULT_CATEGORY_ID)["mode"],
    )

    png_magic = b"\x89PNG\r\n\x1a\n" + b"\x00" * 40
    check("PNG 魔数被识别", scanner.sniff_image_ext(png_magic) == ".png")
    check("JPEG 魔数被识别", scanner.sniff_image_ext(b"\xff\xd8\xff\xe0" + b"\x00" * 16) == ".jpg")
    check("WEBP 魔数被识别", scanner.sniff_image_ext(b"RIFF\x00\x00\x00\x00WEBPVP8 ") == ".webp")
    check("GIF 魔数被识别", scanner.sniff_image_ext(b"GIF89a" + b"\x00" * 16) == ".gif")
    check("SVG 被拒绝（防止存进可执行内容）", scanner.sniff_image_ext(b"<svg xmlns=\"http://www.w3.org/2000/svg\">") is None)
    check("HTML 被拒绝", scanner.sniff_image_ext(b"<html><script>alert(1)</script>") is None)

    target = "角色/miku_v3.safetensors"
    check("上传前没有自有预览图", scanner.own_preview(target) is None)

    saved = scanner.save_preview(target, png_magic, ".png")
    check("上传后能定位到文件", scanner.own_preview(target) is not None, saved.name)
    check("顺手把扫描缓存清了（新图立刻可见）", True)
    scanner.invalidate()
    info = scanner.find_preview(target)
    check(
        "自有上传图优先级最高（排在 LoRA Manager sidecar 之前）",
        bool(info) and info["type"] == "local" and info["path"] == str(saved),
        str(info),
    )
    check(
        "scan() 会带上预览图版本号（供前端破缓存）",
        any(e["name"] == target and e["preview_ver"] > 0 for e in scanner.scan()),
    )

    jpg_magic = b"\xff\xd8\xff\xe0" + b"\x00" * 16
    scanner.save_preview(target, jpg_magic, ".jpg")
    leftovers = list(scanner.preview_dir().glob(scanner.preview_key(target) + ".*"))
    check("重新上传会替换旧文件、不残留", len(leftovers) == 1, f"{len(leftovers)} 个")
    check("扩展名跟着新图走", scanner.own_preview(target).suffix == ".jpg")

    check("删除成功", scanner.delete_preview(target) is True)
    check("删除后不再有自有预览图", scanner.own_preview(target) is None)
    check("重复删除返回 False", scanner.delete_preview(target) is False)

    print("\n=== 8. 数据文件 ===")
    raw = json.loads(lib_path.read_text(encoding="utf-8"))
    check("JSON 可读且是 UTF-8 中文", raw["categories"][1]["name"] == "角色")
    check("数据文件里没有任何绝对路径以外的隐私信息（仅配置）", "loras" in raw)
    check("schema 版本是 v3", raw["version"] == 3, str(raw.get("version")))
    check(
        "LoRA 条目用 categories 列表存类别",
        isinstance(raw["loras"]["画风/film.safetensors"]["categories"], list),
        str(raw["loras"]["画风/film.safetensors"].get("categories")),
    )

    print("\n=== 9. v2 -> v3 迁移（旧文件是单类别） ===")
    from py.store import Library

    legacy_path = TMP / "legacy_v2.json"
    legacy_path.write_text(
        json.dumps(
            {
                "version": 2,
                "categories": [
                    {"id": DEFAULT_CATEGORY_ID, "name": "未分类", "mode": "multi", "order": 0},
                    {"id": "catX", "name": "角色", "mode": "exclusive", "order": 1},
                ],
                "loras": {
                    "角色/miku_v3.safetensors": {
                        "category": "catX",
                        "model_strength": 0.9,
                        "clip_strength": 0.6,
                        "presets": [{"id": "pA", "name": "旧预设", "text": "aaa"}],
                    },
                    "plain.safetensors": {"category": DEFAULT_CATEGORY_ID},
                },
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    legacy = Library(legacy_path)
    check(
        "迁移：旧的单个 category 变成 categories 列表",
        legacy.effective_categories("角色/miku_v3.safetensors") == ["catX"],
        str(legacy.effective_categories("角色/miku_v3.safetensors")),
    )
    check(
        "迁移：强度和预设都没丢",
        legacy.entry("角色/miku_v3.safetensors")["model_strength"] == 0.9
        and len(legacy.presets_of("角色/miku_v3.safetensors")) == 1,
    )
    check("迁移：文件被就地升到 v3", json.loads(legacy_path.read_text(encoding="utf-8"))["version"] == 3)

    broken_path = TMP / "legacy_broken.json"
    broken_path.write_text(
        json.dumps(
            {
                "version": 2,
                "categories": [{"id": DEFAULT_CATEGORY_ID, "name": "未分类", "mode": "multi", "order": 0}],
                "loras": {"x.safetensors": {"category": "早就删掉的类别"}},
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    broken = Library(broken_path)
    check(
        "迁移：指向已删除类别的条目回到「未分类」",
        broken.effective_categories("x.safetensors") == [DEFAULT_CATEGORY_ID],
        str(broken.effective_categories("x.safetensors")),
    )

    print("\n=== 10. LoRA 挪进子文件夹后自动认领 ===")
    adopt_path = TMP / "adopt.json"
    adopt_path.write_text(
        json.dumps(
            {
                "version": 3,
                "categories": [{"id": DEFAULT_CATEGORY_ID, "name": "未分类", "mode": "multi", "order": 0}],
                "loras": {
                    "miku_v3.safetensors": {
                        "categories": [],
                        "presets": [{"id": "pz", "name": "老预设", "text": "zzz"}],
                    },
                    "same.safetensors": {"categories": [], "presets": []},
                },
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    alib = Library(adopt_path)
    moved = alib.adopt_renamed(
        ["子目录/miku_v3.safetensors", "a/same.safetensors", "b/same.safetensors", "new.safetensors"]
    )
    check("挪进子文件夹后按文件名认领回来", moved == 1, f"认领 {moved} 条")
    check(
        "认领后预设跟着走",
        alib.presets_of("子目录/miku_v3.safetensors")[0]["text"] == "zzz",
        str(alib.presets_of("子目录/miku_v3.safetensors")),
    )
    check("库里不再留下旧名字", alib.entry("miku_v3.safetensors", create=False) is None)
    check(
        "同名歧义（两个文件夹里都有 same.safetensors）时不动手，避免张冠李戴",
        alib.entry("a/same.safetensors", create=False) is None
        and alib.entry("b/same.safetensors", create=False) is None
        and alib.entry("same.safetensors", create=False) is not None,
    )

    print("\n" + "=" * 52)
    if FAILED:
        print(f"失败 {len(FAILED)} 项：" + "; ".join(FAILED))
        return 1
    print("全部通过。")
    print("临时目录（可删）：", TMP)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
