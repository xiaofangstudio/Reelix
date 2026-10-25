/**
 * 内置入门教程（模态）。
 *
 * 之前开场界面的「入门教程」是个外链 `<a target="_blank">`，
 * 指向一个根本不通的域名，Tauri 的 WebView 也不会开系统浏览器——
 * 点了毫无反应，用户原话「入门教程还是打不开」。
 * 现在改成完全内置：不联网、不依赖任何外部站点，点开就能读。
 *
 * 内容按「真正剪一条片子」的顺序排，几乎覆盖 Reelix 的全部功能：
 * 新建 → 导入 → 上轨 → 修剪切割 → 变速 → 字幕 → 转场淡出 →
 * 效果 → 3D 与摄像机 → 编组 → 导出。
 */

import { useEffect } from "react";

/** 一步教程：标题 + 要点 + 可选快捷键 */
interface Step {
  title: string;
  body: string;
  keys?: string[];
}

const STEPS: Step[] = [
  {
    title: "1 · 新建工程",
    body: "开场界面选好画幅与帧率（默认 1920×1080 / 25fps）再点「创建」。不确定就按素材来——导入第一段视频时，序列画幅会自动适配素材规格。",
    keys: ["Ctrl+N"],
  },
  {
    title: "2 · 导入素材",
    body: "把视频、照片、音乐拖进左上角素材箱，或按导入键选文件。导入只是「收料」，不会自动上轨——上哪条轨由你决定。",
    keys: ["Ctrl+I"],
  },
  {
    title: "3 · 拖到轨道上",
    body: "从素材箱把素材拖到时间线。视频落 V 轨、声音自动拆到 A 轨并默认和画面粘在一起；拖到空白处会自动建轨，不用先手动加轨。",
  },
  {
    title: "4 · 修剪与切割",
    body: "拖片段两端改入出点。播放头停在要切的地方按 Ctrl+K 一刀两断。右键还能「波纹删除」——删掉后后面的片段自动前移补位。",
    keys: ["Ctrl+K", "Delete"],
  },
  {
    title: "5 · 变速",
    body: "右键片段选 0.5× / 1× / 2×，或到右侧属性面板精细调速。曲线变速能画出「子弹时间 / 英雄时刻」那种忽快忽慢的折线；旁边的「声音变调」开关决定变速时音高跟不跟。",
  },
  {
    title: "6 · 字幕与文字",
    body: "文字预设点一下就落在播放头处，独占一条字幕轨。字幕片段的起点就是它出现的秒数，拖一下就能精确控制从第几秒开始显示；内容在右侧属性里改。",
    keys: ["Ctrl+T"],
  },
  {
    title: "7 · 转场与淡出",
    body: "转场和淡出是「片段的属性」，不是单独的效果项：右键片段设入场转场（叠化 / 黑场 / 白场），也能设尾部「淡出」，在属性面板里调时长。",
  },
  {
    title: "8 · 加效果",
    body: "右上特效面板双击即可挂到选中片段上：模糊、调色、发光、变换、不透明度、色调分离等。挂过效果的片段在时间线上会带一枚 FX 徽标，参数在右侧实时可调。",
  },
  {
    title: "9 · 3D 图层与摄像机",
    body: "在属性面板勾「启用 3D」，片段就变成三维空间里的一块平面；再往图里加一个「摄像机」节点，给它机位打关键帧，就能让镜头绕着这段片子拍——近大远小是真的透视，不是把图平移。",
  },
  {
    title: "10 · 编组（嵌套）",
    body: "多选片段后点工具栏「编组」，能把它们折叠成一个复合片段，整体移动、整体开 3D，时间线不再乱。想拆开就进复合里编辑。",
  },
  {
    title: "11 · 导出成片",
    body: "导出页选预设（分辨率 / 编码 / 码率）后开始，后台真编码，进度在顶栏胶囊里，切页面也不丢。字幕会烧进画面，音频会混好。",
    keys: ["Ctrl+M"],
  },
];

/** 常用快捷键速查（教程末尾） */
const SHORTCUTS: Array<[string, string]> = [
  ["Ctrl+K", "在播放头处切割"],
  ["Ctrl+Z / Ctrl+Shift+Z", "撤销 / 重做"],
  ["Ctrl+S", "保存工程"],
  ["Ctrl+,", "偏好设置"],
  ["Ctrl+滚轮", "以鼠标为锚缩放时间线"],
  ["空格", "播放 / 暂停"],
  ["M", "在播放头加标记"],
  ["← / →", "逐帧移动播放头"],
];

export function TutorialPanel({ onClose }: { onClose: () => void }) {
  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="settings-mask"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="settings-dialog tut-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <span className="settings-title">入门教程 · 30 秒认识 Reelix</span>
          <button type="button" className="ctl-btn" onClick={onClose} title="关闭（ESC）">
            关闭
          </button>
        </div>

        <div className="settings-body">
          <div className="tut-intro">
            从零剪出一条片子的完整流程。每一步都对应界面上的真实操作，
            照着做一遍，Reelix 的主要功能就都摸到了。
          </div>

          {STEPS.map((s) => (
            <section className="settings-group" key={s.title}>
              <div className="group-title">{s.title}</div>
              <div className="tut-body">{s.body}</div>
              {s.keys && s.keys.length > 0 && (
                <div className="tut-keys">
                  {s.keys.map((k) => (
                    <span className="tut-key" key={k}>
                      {k}
                    </span>
                  ))}
                </div>
              )}
            </section>
          ))}

          <section className="settings-group">
            <div className="group-title">快捷键速查</div>
            <div className="tut-shortcuts">
              {SHORTCUTS.map(([k, d]) => (
                <div className="tut-shortcut-row" key={k}>
                  <span className="tut-key">{k}</span>
                  <span className="tut-shortcut-desc">{d}</span>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="settings-foot">
          <span>教程已内置，不联网也能看 · 关掉后随时可从「帮助 ▸ 内置教程」或开场界面重新打开</span>
        </div>
      </div>
    </div>
  );
}
