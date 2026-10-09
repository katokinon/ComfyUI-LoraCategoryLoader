"""ComfyUI LoRA 分类加载

按类别开关 LoRA（同类互斥）+ 为每个 LoRA 挂载多套自定义提示词预设。
"""

from .py.util import log

# 注意：ComfyUI 会把 WEB_DIRECTORY 下的**所有** .js 当作前端扩展模块自动 import。
# 所以这里只能放插件的前端脚本，管理面板（普通网页）必须放在这个目录之外，
# 否则 panel.js 会被当成模块加载并在 ComfyUI 页面里报错。
# 另外，脚本里的 import 路径是相对这个目录算的：js/xxx.js 用 "../../scripts/app.js"。
WEB_DIRECTORY = "./js"

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

try:
    from .py.nodes.lora_category_loader import LoraCategoryLoader
    from .py.nodes.lora_prompt_picker import LoraPromptPicker

    NODE_CLASS_MAPPINGS = {
        "LoraCategoryLoader": LoraCategoryLoader,
        "LoraPromptPicker": LoraPromptPicker,
    }
    NODE_DISPLAY_NAME_MAPPINGS = {
        "LoraCategoryLoader": "LoRA分类加载",
        "LoraPromptPicker": "LoRA提示词选择",
    }
except Exception as exc:  # pragma: no cover
    log("节点注册失败：", repr(exc))

try:
    from .py import api as _api  # noqa: F401  导入即注册 HTTP 路由

    _api.register()
except Exception as exc:  # pragma: no cover
    log("HTTP 路由注册失败（管理面板将不可用）：", repr(exc))

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
