// 生成 src/core/menusFull.ts：把 EffectCraft 的 TREE（缩进文本）与 FilmCraft 的 84 项
// 命令表，转成 Reelix 的中文菜单树数据。
// 运行：node scripts/gen-menus.mjs
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = "D:/20533/deskbox/fangwork/Reelix";

/** 词块 → 中文。先查整句表，再按词块替换。 */
const EXACT = {
  File: "文件",
  Edit: "编辑",
  Composition: "合成",
  Layer: "图层",
  Effect: "效果",
  Animation: "动画",
  View: "视图",
  Window: "窗口",
  Help: "帮助",
  Project: "项目",
  New: "新建",
  "New Project": "新建项目",
  "Open Project...": "打开项目…",
  "Open Recent": "打开最近的文件",
  "Close": "关闭",
  "Close Project": "关闭项目",
  Save: "保存",
  "Save As": "另存为",
  "Save As...": "另存为…",
  "Save a Copy...": "保存副本…",
  "Save as Template...": "另存为模板…",
  "Increment and Save": "增量保存",
  Revert: "恢复",
  Import: "导入",
  Export: "导出",
  Find: "查找",
  Dependencies: "依赖项",
  Scripts: "脚本",
  "Create Proxy": "创建代理",
  "Set Proxy": "设置代理",
  "Interpret Footage": "解释素材",
  "Replace Footage": "替换素材",
  "Reload Footage": "重新加载素材",
  "Reveal in Finder": "在资源管理器中显示",
  "Project Settings...": "项目设置…",
  Exit: "退出",
  Quit: "退出",
  Undo: "撤销",
  Redo: "重做",
  History: "历史记录",
  Cut: "剪切",
  Copy: "复制",
  Paste: "粘贴",
  "Paste Insert": "粘贴插入",
  "Clear": "清除",
  "Ripple Delete": "波纹删除",
  "Select All": "全选",
  "Deselect All": "取消全选",
  Duplicate: "重复",
  "Split Layer": "拆分图层",
  "Open in Essential Graphics": "在基本图形中打开",
  "Open Composition": "打开合成",
  "Open Layer": "打开图层",
  "Open Source": "打开源",
  "Reveal in Composition": "在合成中显示",
  "Reveal in Project Panel": "在项目面板中显示",
  "Add Marker": "添加标记",
  Markers: "标记",
  "New": "新建",
  Group: "编组",
  Ungroup: "取消编组",
  Rename: "重命名",
  "Rename...": "重命名…",
  Nest: "嵌套",
  "Nest...": "嵌套…",
  Enable: "启用",
  "Enable Time Remapping": "启用时间重映射",
  "Audio Gain...": "音频增益…",
  "Speed/Duration...": "速度/持续时间…",
  "Group Shapes": "编组形状",
  "Ungroup Shapes": "取消编组形状",
  "Bring to Front": "置于顶层",
  "Bring Forward": "上移一层",
  "Send Backward": "下移一层",
  "Send to Back": "置于底层",
  "Select All Masks": "全选蒙版",
  "Lock Masks": "锁定蒙版",
  "Add Mask": "添加蒙版",
  "Add Ellipse Mask": "添加椭圆蒙版",
  "Add Rectangle Mask": "添加矩形蒙版",
  "Add Rounded Rectangle Mask": "添加圆角矩形蒙版",
  "Add Star Mask": "添加星形蒙版",
  "Add Freeform Mask": "添加自由蒙版",
  "Mesh Warp": "网格变形",
  "Puppet Pin": "木偶钉",
  "Add Camera": "添加摄像机",
  "Add Light": "添加灯光",
  "Add Null Object": "添加空对象",
  "Add Adjustment Layer": "添加调整图层",
  "Add Shape": "添加形状",
  "New Layer": "新建图层",
  "New Shape Layer": "新建形状图层",
  "New Text Layer": "新建文字图层",
  "New Solid...": "新建纯色…",
  "New Light": "新建灯光",
  "New Camera": "新建摄像机",
  "New Null Object": "新建空对象",
  "New Adjustment Layer": "新建调整图层",
  "Text": "文字",
  "Text Layer": "文字图层",
  "Animation Presets": "动画预设",
  "Transform": "变换",
  "Fit to Comp": "适配到合成",
  "Fit to Comp Width": "适配到合成宽度",
  "Scale to Comp Size": "缩放到合成大小",
  "Blending Mode": "混合模式",
  "Track Matte": "轨道遮罩",
  "Mask": "蒙版",
  "Camera Settings...": "摄像机设置…",
  "Reset 3D View": "重置 3D 视图",
  "Create Camera from 3D View": "从 3D 视图创建摄像机",
  "Switch View Layout": "切换视图布局",
  "Switch 3D View": "切换 3D 视图",
  "Assign Shortcut to 3D View": "为 3D 视图指定快捷键",
  "Switch to Last 3D View": "切换到上一个 3D 视图",
  "Look at Selected Layers": "朝向所选图层",
  "Look at All Layers": "朝向所有图层",
  "Go to Time...": "跳转到时间…",
  "Show Rulers": "显示标尺",
  "Panel Background Color": "面板背景色",
  "Show Guides": "显示参考线",
  "Snap to Guides": "对齐参考线",
  "Lock Guides": "锁定参考线",
  "Add Guide...": "添加参考线…",
  "Add Percentage Guide...": "添加百分比参考线…",
  "Convert Guides to Percentage": "参考线转为百分比",
  "Convert Guides to Pixels": "参考线转为像素",
  "Clear Guides": "清除参考线",
  "Import Guides...": "导入参考线…",
  "Export Guides...": "导出参考线…",
  "Show Grid": "显示网格",
  "Snap to Grid": "对齐网格",
  "Snapping": "吸附",
  "View Options...": "视图选项…",
  "Show Layer Controls": "显示图层控件",
  "Use Display Color Management": "使用显示色彩管理",
  "Simulate Output": "模拟输出",
  "Resolution": "分辨率",
  "Zoom In": "放大",
  "Zoom Out": "缩小",
  "Fit": "适配",
  "Fit Up To 100%": "适配到 100%",
  "Reset Zoom": "重置缩放",
  "Full": "完整",
  "Half": "一半",
  "Third": "三分之一",
  "Quarter": "四分之一",
  "Custom...": "自定义…",
  "Assign Shortcut": "指定快捷键",
  "Save as New Workspace": "另存为新工作区",
  "Reset Workspace": "重置工作区",
  "Close Panel": "关闭面板",
  "Workspace": "工作区",
  "Effect Controls": "效果控件",
  "Effects & Presets": "效果和预设",
  "Render Queue": "渲染队列",
  "Info": "信息",
  "Audio": "音频",
  "Preview": "预览",
  "Properties": "属性",
  "Align": "对齐",
  "Character": "字符",
  "Paragraph": "段落",
  "Tracker": "跟踪器",
  "Wiggler": "摇摆器",
  "Smoother": "平滑器",
  "Motion Sketch": "运动素描",
  "Paint": "绘画",
  "Brushes": "画笔",
  "Flowchart": "流程图",
  "Markers Panel": "标记",
  "Mask Interpolation": "蒙版插值",
  "Script Console": "脚本控制台",
  "Essential Graphics": "基本图形",
  "Lumetri Scopes": "示波器",
  "Footage": "素材",
  "Media Browser": "媒体浏览器",
  "Metadata": "元数据",
  "Progress": "进度",
  "Content-Aware Fill": "内容识别填充",
  "Create Nulls From Paths": "从路径创建空对象",
  "VR Comp Editor": "VR 合成编辑器",
  "Time": "时间",
  "Layer Panel": "图层面板",
  "Composition Panel": "合成面板",
  "Timeline": "时间轴",
  "Timeline Panel": "时间轴面板",
  "Project Panel": "项目面板",
  "About EffectCraft...": "关于 EffectCraft…",
  "Settings...": "设置…",
  "Hide EffectCraft": "隐藏 EffectCraft",
  "Hide Others": "隐藏其他",
  "Show All": "全部显示",
  "Quit EffectCraft": "退出 EffectCraft",
  "Exit EffectCraft": "退出 EffectCraft",
  "New Project from Template...": "从模板新建项目…",
  "New Folder": "新建文件夹",
  "Clear Recent Projects": "清除最近项目",
  "Save a Copy As XML...": "保存 XML 副本…",
  "File...": "文件…",
  "Multiple Files...": "多个文件…",
  "Adobe Premiere Pro Project...": "Adobe Premiere Pro 项目…",
  "EffectCraft Project...": "EffectCraft 项目…",
  "Placeholder...": "占位符…",
  "Solid...": "纯色…",
  "Lottie...": "Lottie…",
  "Vanishing Point (.vpe)...": "消失点（.vpe）…",
  "Essential Graphics Template...": "基本图形模板…",
  "Import Recent Footage": "导入最近的素材",
  "Clear Recent Footage": "清除最近素材",
  "Add to Render Queue": "添加到渲染队列",
  "Lottie JSON...": "Lottie JSON…",
  "Add Footage to Comp": "将素材添加到合成",
  "New Comp from Selection...": "基于所选新建合成…",
  "Collect Files...": "收集文件…",
  "Consolidate All Footage": "合并所有素材",
  "Remove Unused Footage": "移除未使用素材",
  "Reduce Project": "精简项目",
  "Find Missing Effects": "查找缺失效果",
  "Find Missing Fonts": "查找缺失字体",
  "Find Missing Footage": "查找缺失素材",
  "Relink Missing Footage...": "重新链接缺失素材…",
  "Watch Folder...": "监视文件夹…",
  "Install Script File...": "安装脚本文件…",
  "Install ScriptUI Panel...": "安装 ScriptUI 面板…",
  "Run Script File...": "运行脚本文件…",
  "Still...": "静帧…",
  "Movie...": "影片…",
  "None": "无",
  "Main...": "主要…",
  "Proxy...": "代理…",
  "Remember Interpretation": "记住解释",
  "Apply Interpretation": "应用解释",
  "With Layered Comp": "使用分层合成",
  "No Output Simulation": "无输出模拟",
  "My Custom RGB...": "自定义 RGB…",
  "Black": "黑",
  "Dark Gray": "深灰",
  "Medium Gray (Default)": "中灰（默认）",
  "Light Gray": "浅灰",
  "White": "白",
  "Custom": "自定义",
  "Select Custom Background Color...": "选择自定义背景色…",
  "1 View": "单视图",
  "2 Views": "双视图",
  "4 Views": "四视图",
  "Share View Options": "共享视图选项",
  "Active Camera": "活动摄像机",
  "Default": "默认",
  "Front": "前",
  "Left": "左",
  "Top": "上",
  "Back": "后",
  "Right": "右",
  "Bottom": "下",
  "Custom View 1": "自定义视图 1",
  "Custom View 2": "自定义视图 2",
  "Custom View 3": "自定义视图 3",
  "Effect Craft": "EffectCraft",
  // ---- 混合模式 ----
  "Normal": "正常", "Dissolve": "溶解", "Dancing Dissolve": "舞动溶解",
  "Darken": "变暗", "Multiply": "正片叠底", "Color Burn": "颜色加深",
  "Classic Color Burn": "经典颜色加深", "Darker Color": "变暗颜色",
  "Lighten": "变亮", "Screen": "滤色", "Color Dodge": "颜色减淡",
  "Classic Color Dodge": "经典颜色减淡", "Lighter Color": "变亮颜色",
  "Overlay": "叠加", "Soft Light": "柔光", "Hard Light": "强光",
  "Vivid Light": "亮光", "Linear Light": "线性光", "Pin Light": "点光",
  "Hard Mix": "实色混合", "Difference": "差值", "Classic Difference": "经典差值",
  "Exclusion": "排除", "Hue": "色相", "Saturation": "饱和度",
  "Color": "颜色", "Luminosity": "亮度", "Add": "相加", "Subtract": "相减",
  "Divide": "相除", "Alpha Add": "Alpha 相加", "Luminescent Premul": "发光预乘",
  "Stencil Alpha": "模板 Alpha", "Stencil Luma": "模板亮度",
  "Silhouette Alpha": "轮廓 Alpha", "Silhouette Luma": "轮廓亮度",
  "Alpha Matte": "Alpha 遮罩", "Alpha Inverted Matte": "Alpha 反转遮罩",
  "Luma Matte": "亮度遮罩", "Luma Inverted Matte": "亮度反转遮罩",
  "Preserve Transparency": "保留透明度",
  "Matte with Layer Above": "使用上层图层作为遮罩",
  "Matte with Layer Below": "使用下层图层作为遮罩",
  "Track Matte": "轨道遮罩", "Previous Blending Mode": "上一个混合模式",
  "Next Blending Mode": "下一个混合模式",
  // ---- 图层样式 ----
  "Drop Shadow": "投影", "Inner Shadow": "内阴影", "Outer Glow": "外发光",
  "Inner Glow": "内发光", "Bevel and Emboss": "斜面和浮雕", "Satin": "光泽",
  "Color Overlay": "颜色叠加", "Gradient Overlay": "渐变叠加",
  "Stroke": "描边", "Layer Styles": "图层样式",
  "Layer Style Options...": "图层样式选项…", "Convert to Editable Styles": "转换为可编辑样式",
  "Bevel": "斜面", "Blur": "模糊", "Stroke Color": "描边颜色", "Stroke Width": "描边宽度",
  "Fill Color": "填充颜色",
  // ---- 文字 ----
  "Animate Text": "动画文字", "Add Text Selector": "添加文字选择器",
  "Range": "范围", "Character Offset": "字符偏移", "Character Value": "字符值",
  "Line Anchor": "行锚点", "Line Spacing": "行间距",
  "Typewriter": "打字机", "Bounce In Words": "逐词弹入",
  "Fade Up Characters": "字符淡入上浮", "Drop In Lines": "逐行落入",
  "Scramble": "乱码显现", "Wiggly": "抖动显现",
  "Variable Font Axes": "可变字体轴",
  "Enable Per-character 3D": "启用逐字符 3D",
  "Convert to Editable Text": "转换为可编辑文字",
  "Create Shapes from Text": "从文字创建形状",
  "Create Masks from Text": "从文字创建蒙版",
  "Paste Text and Match Formatting": "粘贴文字并匹配格式",
  "Paste Text Formatting Only": "仅粘贴文字格式",
  "Remove All Text Animators": "移除所有文字动画器",
  "Text": "文字", "Photoshop Layer...": "Photoshop 图层…",
  // ---- 3D ----
  "Cube": "立方体", "Sphere": "球体", "Cone": "圆锥",
  "Cylinder": "圆柱", "Torus": "圆环", "Plane": "平面",
  "Environment Layer": "环境图层", "Hard Light Type": "硬光",
  "Soft Light Type": "柔光", "Vivid Light Type": "亮光",
  "Material": "材质", "Wireframe": "线框", "Skew": "斜切",
  "Extract Cubemap...": "提取立方体贴图…",
  "Create 3D Layer Instance": "创建 3D 图层实例",
  "Create Cameras from 3D Model": "从 3D 模型创建摄像机",
  "Create Lights from 3D Model": "从 3D 模型创建灯光",
  "Create Orbit Null": "创建环绕空对象",
  "Duplicate and Assign Material": "复制并分配材质",
  "Reset Material": "重置材质",
  "Reveal Material Source in Project": "在项目中显示材质源",
  "Create Stereo 3D Rig": "创建立体 3D 装配",
  "Create VR Environment...": "创建 VR 环境…",
  "Create Environment Light Background Layer": "创建环境光背景图层",
  "RPF Camera Import": "RPF 摄像机导入",
  "Control Lights with Camera": "用摄像机控制灯光",
  "Same As Layer": "与图层相同",
  "Guide Layer": "参考图层",
  // ---- 关键帧助手 ----
  "Keyframe Assistant": "关键帧助手", "Easy Ease": "缓动",
  "Easy Ease In": "缓入", "Easy Ease Out": "缓出",
  "Exponential Scale": "指数缩放",
  "Time-Reverse Keyframes": "时间反向关键帧",
  "Time-Reverse Layer": "时间反向图层",
  "Convert Audio to Keyframes": "将音频转换为关键帧",
  "Convert Expression to Keyframes": "将表达式转换为关键帧",
  "Create Keyframes from Data": "从数据创建关键帧",
  "Paste Reversed Keyframes": "粘贴反向关键帧",
  "Toggle Hold Keyframe": "切换定格关键帧",
  "Keyframe Interpolation...": "关键帧插值…",
  "Keyframe Velocity...": "关键帧速度…",
  "Select Keyframe Label Group": "选择关键帧标签组",
  "Track this Property": "跟踪此属性",
  "Reveal Properties with Keyframes": "显示含关键帧的属性",
  "Reveal Properties with Animation": "显示含动画的属性",
  "Reveal All Modified Properties": "显示所有已修改属性",
  "Visible Keyframes on All Layers": "所有图层的可见关键帧",
  "Visible Keyframes on Selected Layers": "所选图层的可见关键帧",
  "Add Expression": "添加表达式",
  "Enable Expressions": "启用表达式", "Disable Expressions": "禁用表达式",
  "Copy Expression Only": "仅复制表达式",
  "Reveal Expression Errors": "显示表达式错误",
  "Expression Reference...": "表达式参考…",
  // ---- 缓存 / 渲染 ----
  "Purge": "清除", "All Memory": "所有内存",
  "All Memory & Disk Cache...": "所有内存与磁盘缓存…",
  "Image Cache Memory": "图像缓存内存",
  "Cache Frames When Idle": "空闲时缓存帧",
  "All Cache...": "所有缓存…", "All Disk Cache...": "所有磁盘缓存…",
  "All 3D Cache...": "所有 3D 缓存…",
  "Pre-render...": "预渲染…",
  "Render Settings...": "渲染设置…", "Output Module...": "输出模块…",
  "Add Output Module": "添加输出模块",
  "Play Current Preview": "播放当前预览",
  "Save Current Preview...": "保存当前预览…",
  "Create Intro": "创建片头", "Create Outro": "创建片尾",
  // ---- 颜色 ----
  "Red": "红", "Orange": "橙", "Yellow": "黄", "Green": "绿",
  "Cyan": "青", "Blue": "蓝", "Purple": "紫", "Pink": "粉",
  "Brown": "褐", "Dark Green": "深绿", "Sea Foam": "海沫",
  "Aqua": "水蓝", "Lavender": "薰衣草", "Peach": "桃",
  "Sandstone": "砂岩", "Fuchsia": "品红",
  // ---- 设置页 ----
  "General...": "常规…", "Startup & Repair...": "启动与修复…",
  "Previews...": "预览…", "Appearance...": "外观…",
  "Grids & Guides...": "网格和参考线…", "Labels...": "标签…",
  "Type...": "文字…", "Disk...": "磁盘…",
  "Memory & CPU...": "内存与 CPU…", "Video...": "视频…",
  "3D...": "3D…", "Scripting & Expressions...": "脚本与表达式…",
  "Import...": "导入…", "Export...": "导出…", "Audio...": "音频…",
  // ---- 其他动作 ----
  "Reveal": "显示", "Reveal in Explorer": "在资源管理器中显示",
  "Reveal Logging File": "显示日志文件",
  "Show All Video": "显示所有视频", "Hide Other Video": "隐藏其他视频",
  "Solo": "独奏", "Shy": "隐藏切换", "Locked": "已锁定",
  "Switches": "开关", "Quality": "质量", "Best": "最佳", "Draft": "草图",
  "Frame Blending": "帧混合", "Frame Mix": "帧混合",
  "Pixel Motion": "像素运动", "Motion Blur": "运动模糊",
  "Collapse": "折叠", "Mode": "模式", "Templates": "模板",
  "Tools": "工具", "Arrange": "排列", "Create": "创建",
  "Trim Comp to Work Area": "裁剪合成到工作区",
  "Crop Comp to Region of Interest": "裁剪合成到关注区域",
  "Crop Comp to Selected Layer(s) Bounds": "裁剪合成到所选图层边界",
  "Close Gap": "消除间隙", "Match Frame": "匹配帧",
  "Snapshot": "快照", "Copy Frame to Clipboard": "复制帧到剪贴板",
  "Freeze Frame": "帧定格", "Freeze On Last Frame": "定格在最后一帧",
  "Set Poster Time": "设置海报时间",
  "Time Stretch...": "时间伸缩…",
  "Pre-compose...": "预合成…",
  "Split Layer": "拆分图层",
  "Split with New Locked Viewer": "拆分并新建锁定的查看器",
  "Trim Edit": "修剪编辑",
  "Ripple Delete Head Frame": "波纹删除首帧",
  "Lift": "提升", "Extract": "提取",
  "Lift Work Area": "提升工作区", "Extract Work Area": "提取工作区",
  "Create Protected Region from Work Area": "从工作区创建保护区域",
  "Add Edit": "添加编辑点", "Add Edit to All Tracks": "在所有轨道添加编辑点",
  "Snap in Timeline": "时间线吸附", "Linked Selection": "链接选择",
  "Bars and Tone…": "彩条与音调…",
  "Black Video…": "黑场…", "Color Matte…": "颜色遮罩…",
  "Universal Counting Leader…": "通用倒计时片头…",
  "Transparent Video…": "透明视频…", "Adjustment Layer…": "调整图层…",
  "Null Object": "空对象",
  "Create Shapes from Vector Layer": "从矢量图层创建形状",
  "Auto-trace...": "自动追踪…", "Auto-Orient...": "自动定向…",
  "Separate Dimensions": "分离维度",
  "Flip Horizontal": "水平翻转", "Flip Vertical": "垂直翻转",
  "Free Transform Points": "自由变换点",
  "Center Anchor Point in Layer Content": "锚点居中到图层内容",
  "Center in View": "在视图中居中",
  "Fit to Comp Height": "适配到合成高度",
  "Scale to Frame Size": "缩放为帧大小",
  "Set First Vertex": "设置第一个顶点",
  "Convert To Bezier Path": "转换为贝塞尔路径",
  "RotoBezier": "Roto 贝塞尔",
  "Motion Tracking": "运动跟踪", "Stabilize Motion": "稳定运动",
  "Track Motion": "跟踪运动", "Track Camera": "跟踪摄像机",
  "Track Mask": "跟踪蒙版", "Warp Stabilizer VFX": "变形稳定器 VFX",
  "Mask and Shape Path": "蒙版和形状路径",
  "Mask Expansion...": "蒙版扩展…", "Mask Feather...": "蒙版羽化…",
  "Feather Falloff": "羽化衰减", "Inverted": "反转",
  "Intersect": "相交", "Locked": "已锁定",
  "Reveal Composition in Project": "在项目中显示合成",
  "Reveal Layer in Project Flowchart": "在项目流程图中显示图层",
  "Reveal Layer Source in Project": "在项目中显示图层源",
  "Open in Essential Graphics": "在基本图形中打开",
  "Add Property to Essential Graphics": "将属性添加到基本图形",
  "Sequence Layers...": "序列图层…",
  "Add Tracks…": "添加轨道…", "Add Frame Hold": "添加帧定格",
  "Ripple Delete Head Frame": "波纹删除首帧",
  "Load Effect Plug-in...": "加载效果插件…",
  "Manage Effects...": "管理效果…",
  "Effect Reference...": "效果参考…",
  "Last Effect": "上一个效果",
  "Keyboard Shortcuts": "键盘快捷键",
  "Keyboard Shortcuts...": "键盘快捷键…",
  "Quick Apply...": "快速应用…",
  "In-App Tutorials...": "内置教程…",
  "Online Tutorials...": "在线教程…",
  "Provide Feedback...": "提供反馈…",
  "System Compatibility Report...": "系统兼容性报告…",
  "ArtCraft Website": "ArtCraft 官网",
  "Join the ArtCraft Discord...": "加入 ArtCraft Discord…",
  "Scripting Help...": "脚本帮助…",
  "Edit Workspaces...": "编辑工作区…",
  "Save Changes to this Workspace": "保存对此工作区的更改",
  "Reset to Saved Layout": "重置为已保存布局",
  "Enter Full Screen": "进入全屏",
  "New Viewer": "新建查看器",
  "Locked Viewer": "锁定查看器",
  "Trim Comp to Work Area": "裁剪合成到工作区",
  "Extract Cubemap...": "提取立方体贴图…",
  "Sequence…": "序列…", "Sequence Settings…": "序列设置…",
  "Demo Project": "演示项目", "Demo Footage": "演示素材",
  "Bin": "素材箱", "Import From": "从…导入",
  "Edit Original...": "编辑原始素材…",
  "Edit Label Colors...": "编辑标签颜色…",
  "Reveal All Modified Properties": "显示所有已修改属性",
  "Undocked Panels": "浮动面板", "All Panels": "所有面板",
  "Small Screen": "小屏幕", "Review": "审阅", "Learn": "学习",
  "Minimal": "极简", "Standard": "标准",
  "Save a Copy…": "保存副本…",
  "Export Markers as CSV…": "导出标记为 CSV…",
  "Clear Selected Marker": "清除所选标记",
  "Clear Markers": "清除标记", "Clear In": "清除入点",
  "Clear Out": "清除出点", "Clear In and Out": "清除入点和出点",
  "Mark Clip": "标记片段", "Mark Selection": "标记所选",
  "Mark In": "标记入点", "Mark Out": "标记出点",
  "Update Markers From Source": "从源更新标记",
  "Lock Markers": "锁定标记", "Delete All Markers": "删除所有标记",
  "Convert to Editable Text": "转换为可编辑文字",
  "Nest…": "嵌套…", "Rename…": "重命名…",
  "Audio Gain…": "音频增益…", "Speed/Duration…": "速度/持续时间…",
  "Recover Unsaved Changes…": "恢复未保存的更改…",
  "Reveal in Project": "在项目中显示",
  "Open Layer Source": "打开图层源",
  "Open Demo Project": "打开演示项目",
  "Reveal Comp in Project": "在项目中显示合成",
  "Composition Flowchart": "合成流程图",
  "Composition Mini-Flowchart": "合成迷你流程图",
  "Unlock All Layers": "解锁所有图层",
  "Unlock All Masks": "解锁所有蒙版",
  "Hide Locked Masks": "隐藏已锁定蒙版",
  "Remove All": "移除所有", "Remove All Masks": "移除所有蒙版",
  "Select Label Group": "选择标签组",
  "Browse Presets...": "浏览预设…",
  "Recent Animation Presets": "最近的动画预设",
  "Apply Animation Preset...": "应用动画预设…",
  "Save Animation Preset...": "保存动画预设…",
  "Clear Recent Presets": "清除最近预设",
  "Align Video to Data": "将视频对齐到数据",
  "Apply Default Transitions to Selection": "对所选应用默认转场",
  "Apply Video Transition": "应用视频转场",
  "Apply Audio Transition": "应用音频转场",
  "Assign Shortcut to Workspace": "为工作区指定快捷键",
  "Bring Layer Forward": "上移一层",
  "Bring Layer to Front": "置于顶层",
  "Send Layer Backward": "下移一层",
  "Send Layer to Back": "置于底层",
  "Center In View": "在视图中居中",
  "Content-Aware Fill Layer...": "内容识别填充图层…",
  "Control Lights with Camera": "用摄像机控制灯光",
  "Go to Out": "跳转到出点",
  "Link Focus Distance to Point of Interest": "焦距链接到目标点",
  "Link Focus Distance to Layer": "焦距链接到图层",
  "Set Focus Distance to Layer": "设置到图层的焦距",
  "No Track Matte": "无轨道遮罩",
  "Nulls Following Path Points": "跟随路径点的空对象",
  "Null Controllers for Positional Points": "定位点的空对象控制器",
  "Null Controllers for Path Points": "路径点的空对象控制器",
  "Null Tracing Along Path": "沿路径追踪的空对象",
  "Orientation...": "方向…",
  "Scene Edit Detection...": "场景编辑检测…",
  "Delete Render Files In to Out": "删除入点到出点的渲染文件",
  "Render In to Out": "渲染入点到出点",
  "Render Selection": "渲染所选",
  "Render Effects In to Out": "渲染入点到出点的效果",
  "All Transform Properties": "所有变换属性",
  "Hide Locked Masks": "隐藏已锁定蒙版",
  "Lock Other Masks": "锁定其他蒙版",
  "Copy with Property Links": "复制并保留属性链接",
  "Copy with Relative Property Links": "复制并保留相对属性链接",
  "Export Markers as CSV…": "导出标记为 CSV…",
  "Save XML Copy...": "保存 XML 副本…",
  "EffectCraft Help...": "EffectCraft 帮助…",
  "EffectCraft Home Page": "EffectCraft 官网",
  "EffectCraft on GitHub": "GitHub 上的 EffectCraft",
  "Join the ArtCraft Discord...": "加入 ArtCraft Discord…",
  "Install ScriptUI Panel...": "安装 ScriptUI 面板…",
  "Preferences": "首选项",
  "Closed": "闭合", "Off": "关闭", "Side": "侧",
  "Linear Burn": "线性加深", "Linear Dodge": "线性减淡",
  "Linear": "线性", "Brightness": "亮度", "Jitter": "抖动", "Smooth": "平滑",
  "Blur In": "模糊入", "Bicubic": "双三次", "Bilinear": "双线性",
  "Insert": "插入", "Overwrite": "覆盖", "Link": "链接", "Clip": "片段",
  "Media…": "媒体…", "Import…": "导入…",
  "Photoshop Layer...": "Photoshop 图层…",
  "RotoBezier": "Roto 贝塞尔",
  "RPF Camera Import": "RPF 摄像机导入",
  "Ripple Delete Head Frame": "波纹删除首帧",
};

/** 词块替换（整句没命中时用） */
const WORDS = [
  [/\bAdjustment Layer\b/g, "调整图层"],
  [/\bAll Layers\b/g, "所有图层"],
  [/\bSelected Layers?\b/g, "所选图层"],
  [/\bCurrent Preview\b/g, "当前预览"],
  [/\bWork Area\b/g, "工作区"],
  [/\bLabel Group\b/g, "标签组"],
  [/\bLayer Styles?\b/g, "图层样式"],
  [/\bEffects?\b/g, "效果"],
  [/\bExpressions?\b/g, "表达式"],
  [/\bKeyframes?\b/g, "关键帧"],
  [/\bMarkers?\b/g, "标记"],
  [/\bMasks?\b/g, "蒙版"],
  [/\bCameras?\b/g, "摄像机"],
  [/\bLights?\b/g, "灯光"],
  [/\bMaterial\b/g, "材质"],
  [/\bViewer\b/g, "查看器"],
  [/\bTracks?\b/g, "轨道"],
  [/\bRender Files\b/g, "渲染文件"],
  [/\bOutput Module\b/g, "输出模块"],
  [/\bRender Settings?\b/g, "渲染设置"],
  [/\bCompositions?\b/g, "合成"],
  [/\bProjects?\b/g, "项目"],
  [/\bFootage\b/g, "素材"],
  [/\bPresets?\b/g, "预设"],
  [/\bWorkspaces?\b/g, "工作区"],
  [/\bPanels?\b/g, "面板"],
  [/\bProperties\b/g, "属性"],
  [/\bProperty\b/g, "属性"],
  [/\bAnimation\b/g, "动画"],
  [/\bBlending Mode\b/g, "混合模式"],
  [/\bTrack Matte\b/g, "轨道遮罩"],
  [/\bPoint of Interest\b/g, "目标点"],
  [/\bFocus Distance\b/g, "焦距"],
  [/\bAnchor Point\b/g, "锚点"],
  [/\bPosition\b/g, "位置"],
  [/\bScale\b/g, "缩放"],
  [/\bRotation\b/g, "旋转"],
  [/\bOpacity\b/g, "不透明度"],
  [/\bSource\b/g, "源"],
  [/\bPath Points?\b/g, "路径点"],
  [/\bPositional Points?\b/g, "定位点"],
  [/\bBezier Path\b/g, "贝塞尔路径"],
  [/\bData\b/g, "数据"],
  [/\bClipboard\b/g, "剪贴板"],
  [/\bRelative Property Links\b/g, "相对属性链接"],
  [/\bProperty Links\b/g, "属性链接"],
  [/\bPlugin\b/g, "插件"],
  [/\bPlug-in\b/g, "插件"],
  [/\bLayout\b/g, "布局"],
  [/\bFormatting\b/g, "格式"],
  [/\bVideo\b/g, "视频"],
  [/\bAudio\b/g, "音频"],
  [/\bCache\b/g, "缓存"],
  [/\bMemory\b/g, "内存"],
  [/\bDisk\b/g, "磁盘"],
  [/\bModel\b/g, "模型"],
  [/\bRegion of Interest\b/g, "关注区域"],
  [/\bBounds\b/g, "边界"],
  [/\bRegion\b/g, "区域"],
  [/\bGap\b/g, "间隙"],
  [/\bPreview\b/g, "预览"],
  [/\bFrame\b/g, "帧"],
  [/\bFrames\b/g, "帧"],
  [/\bLayer\b/g, "图层"],
  [/\bLayers\b/g, "图层"],
  [/\bText\b/g, "文字"],
  [/\bShapes?\b/g, "形状"],
  [/\bSolid\b/g, "纯色"],
  [/\bNull Object\b/g, "空对象"],
  [/\bNull\b/g, "空对象"],
  [/\bTemplate\b/g, "模板"],
  [/\bStyle\b/g, "样式"],
  [/\bSwitches\b/g, "开关"],
  [/\bTools\b/g, "工具"],
  [/\bTracking\b/g, "跟踪"],
  [/\bPreview\b/g, "预览"],
  [/\bSettings?\b/g, "设置"],
  [/\bShortcuts?\b/g, "快捷键"],
  [/\bTutorials?\b/g, "教程"],
  [/\bFeedback\b/g, "反馈"],
  [/\bReport\b/g, "报告"],
  [/\bCompatibility\b/g, "兼容性"],
  [/\bLabel\b/g, "标签"],
  [/\bLabels\b/g, "标签"],
  [/\bColors?\b/g, "颜色"],
  [/\bColor\b/g, "颜色"],
  [/\bAdd\b/g, "添加"],
  [/\bRemove\b/g, "移除"],
  [/\bDelete\b/g, "删除"],
  [/\bClear\b/g, "清除"],
  [/\bNew\b/g, "新建"],
  [/\bOpen\b/g, "打开"],
  [/\bClose\b/g, "关闭"],
  [/\bSave\b/g, "保存"],
  [/\bLoad\b/g, "加载"],
  [/\bEnable\b/g, "启用"],
  [/\bDisable\b/g, "禁用"],
  [/\bLock\b/g, "锁定"],
  [/\bUnlock\b/g, "解锁"],
  [/\bShow\b/g, "显示"],
  [/\bHide\b/g, "隐藏"],
  [/\bReveal\b/g, "显示"],
  [/\bAll\b/g, "所有"],
  [/\bSelected\b/g, "所选"],
  [/\bCurrent\b/g, "当前"],
  [/\bPrevious\b/g, "上一个"],
  [/\bNext\b/g, "下一个"],
  [/\bLast\b/g, "上一个"],
  [/\bFirst\b/g, "第一个"],
  [/\bToggle\b/g, "切换"],
  [/\bConvert\b/g, "转换"],
  [/\bCreate\b/g, "创建"],
  [/\bPaste\b/g, "粘贴"],
  [/\bCopy\b/g, "复制"],
  [/\bSelect\b/g, "选择"],
  [/\bDeselect\b/g, "取消选择"],
  [/\bReset\b/g, "重置"],
  [/\bRestore\b/g, "恢复"],
  [/\bManage\b/g, "管理"],
  [/\bEdit\b/g, "编辑"],
  [/\bPurge\b/g, "清除"],
  [/\bRender\b/g, "渲染"],
  [/\bSequence\b/g, "序列"],
  [/\bComposition\b/g, "合成"],
  [/\bComp\b/g, "合成"],
  [/\bProject\b/g, "项目"],
  [/\bOptions?\b/g, "选项"],
  [/\bFit\b/g, "适配"],
  [/\bFreeze\b/g, "定格"],
  [/\bTime\b/g, "时间"],
  [/\bPoint\b/g, "点"],
  [/\bPoints\b/g, "点"],
  [/\bFrom\b/g, "从"],
  [/\bWith\b/g, "使用"],
  [/\bto\b/g, "到"],
  [/\bAll\b/g, "所有"],
];

/** 整句翻译 */
function translate(label) {
  const t = label.trim();
  if (EXACT[t]) return EXACT[t];
  // 去掉结尾省略号再试
  const noDots = t.replace(/\.\.\.$/, "");
  if (EXACT[noDots]) return EXACT[noDots] + (t.endsWith("...") ? "…" : "");
  let out = t;
  for (const [re, cn] of WORDS) out = out.replace(re, cn);
  return out;
}

// ---------------------------------------------------------------------------
// 解析 EffectCraft 的缩进 TREE
// ---------------------------------------------------------------------------
const treeText = readFileSync(`${ROOT}/scaffold/_ec_tree.txt`, "utf8")
  // Debug 出来的源文件里可能带 BOM（U+FEFF），它会粘进第一个命令 id，
  // 导致 id 永远匹配不上 ACTIONS（Ctrl+N 点不动的 bug）。
  .replace(/\uFEFF/g, "");
const lines = treeText.split(/\r?\n/);

/** 解析一行：返回 {level, label, command, shortcut, separator} */
function parseLine(line) {
  if (!line.trim()) return null;
  const m = line.match(/^(\s*)(.*)$/);
  const level = Math.floor(m[1].length / 2);
  let body = m[2].trim();
  // 平台标记：Windows 版跳过 [mac] 行及其整棵子树，保留 [!mac] 行
  if (body.startsWith("[mac]")) return { level, skipSubtree: true };
  if (/^\[!?mac\]\s/.test(body)) body = body.replace(/^\[!?mac\]\s*/, "");
  if (body === "---") return { level, separator: true };
  if (body.startsWith("@")) return null; // 动态项/效果分类：跳过（运行时生成或单独面板）
  const parts = body.split("|").map((s) => s.trim());
  const label = parts[0];
  const command = parts[1] ?? "";
  const shortcut = parts[2] ?? "";
  return { level, label, command, shortcut };
}

const ecRoot = { children: [] };
const stack = [ecRoot];
let skipAbove = -1;
for (const raw of lines) {
  const item = parseLine(raw);
  if (!item) continue;
  // mac 子树整体跳过
  if (item.skipSubtree) {
    skipAbove = item.level;
    continue;
  }
  if (skipAbove >= 0 && item.level > skipAbove) continue;
  if (skipAbove >= 0 && item.level <= skipAbove) skipAbove = -1;
  while (stack.length > item.level + 1) stack.pop();
  const parent = stack[stack.length - 1];
  if (item.separator) {
    parent.children.push({ separator: true });
    continue;
  }
  if (item.command) {
    // 叶子：有命令
    parent.children.push({
      label: translate(item.label),
      id: item.command,
      shortcut: item.shortcut || undefined,
    });
  } else {
    // 子菜单
    const node = { label: translate(item.label), children: [] };
    parent.children.push(node);
    stack.push(node);
  }
}
const EC_MENUS = ecRoot.children;

// ---------------------------------------------------------------------------
// FilmCraft 的 84 项 → 按菜单路径建树
// ---------------------------------------------------------------------------
const rows = readFileSync(`${ROOT}/scaffold/_fcmenu_rows.txt`, "utf8")
  // PowerShell 的 Out-File 会给第一行加 BOM，同理会粘进首个 id
  .replace(/\uFEFF/g, "")
  .split(/\r?\n/)
  .filter((l) => l.includes("|"));

const fcRoot = { children: [] };
const fcMenus = new Map(); // menuName -> node
for (const row of rows) {
  const [id, label, pathRaw, shortcut] = row.split("|");
  const path = pathRaw.split("/").filter(Boolean);
  if (path.length === 0) continue;
  const top = path[0];
  let node = fcMenus.get(top);
  if (!node) {
    node = { label: translate(top), children: [] };
    fcMenus.set(top, node);
    fcRoot.children.push(node);
  }
  // 逐级子菜单
  let cur = node;
  for (let i = 1; i < path.length; i++) {
    const sub = path[i];
    let child = (cur.children ?? []).find((c) => c.label === translate(sub) && c.children);
    if (!child) {
      child = { label: translate(sub), children: [] };
      cur.children.push(child);
    }
    cur = child;
  }
  cur.children.push({
    label: translate(label),
    id,
    shortcut: shortcut || undefined,
  });
}
const FC_MENUS = fcRoot.children;

// ---------------------------------------------------------------------------
// 输出 TS
// ---------------------------------------------------------------------------
function serialize(nodes, indent = "  ") {
  const out = [];
  for (const n of nodes) {
    if (n.separator) {
      out.push(`${indent}{ sep: true },`);
      continue;
    }
    if (n.children) {
      out.push(`${indent}{ label: ${JSON.stringify(n.label)}, children: [`);
      out.push(serialize(n.children, indent + "  "));
      out.push(`${indent}] },`);
      continue;
    }
    const parts = [`label: ${JSON.stringify(n.label)}`];
    if (n.id) parts.push(`id: ${JSON.stringify(n.id)}`);
    if (n.shortcut) parts.push(`shortcut: ${JSON.stringify(n.shortcut)}`);
    out.push(`${indent}{ ${parts.join(", ")} },`);
  }
  return out.join("\n");
}

const header = `/**
 * 全量菜单数据（机器生成，勿手改）。
 *
 * 来源：
 * - EC_MENUS：EffectCraft 的 \`crates/engine/src/menus.rs\` 里 TREE 常量（缩进文本菜单树，
 *   770 行），逐项抽取并按中文词表翻译；\`@dynamic\` 与效果分类项运行时生成，这里跳过。
 * - FC_MENUS：FilmCraft 的 \`crates/engine/src/commands.rs\` 里全部 cmd! 定义（84 个带菜单
 *   路径的命令），按菜单路径组装成树。
 *
 * 生成脚本：scripts/gen-menus.mjs
 * 用法：menuRegistry.ts 把这两棵树转成可执行菜单（id 命中真实动作就绑定，未命中则置灰）。
 */

export interface FullMenuNode {
  label?: string;
  id?: string;
  shortcut?: string;
  sep?: boolean;
  children?: FullMenuNode[];
}
`;

const body = `${header}
export const EC_MENUS: FullMenuNode[] = [
${serialize(EC_MENUS)}
];

export const FC_MENUS: FullMenuNode[] = [
${serialize(FC_MENUS)}
];
`;

writeFileSync(`${ROOT}/scaffold/src/core/menusFull.ts`, body, "utf8");
console.log("EC menus:", EC_MENUS.length, "FC menus:", FC_MENUS.length);
