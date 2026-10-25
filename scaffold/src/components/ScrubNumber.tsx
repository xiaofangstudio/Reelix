import { useEffect, useRef, useState } from "react";

/**
 * 数值控件：左右拖动改值 + 滚轮微调 + 双击直接输入。
 *
 * 之前在属性面板里，位置/缩放/旋转用的都是 `<input type="range">`：
 * 原生滑块的绿色轨道既不能拖数值、也不能填数字，精细调整只能靠猜。
 * 这个是 PR / AE 那种「scrubbable field」：
 * - 按住左右拖：按位移改值（Shift 精细 0.1×，Alt 加速 10×）
 * - 滚轮：±1 步
 * - 双击：变成输入框，随便填，回车/失焦提交，Esc 取消
 */
type Props = {
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (v: number) => void;
};

export function ScrubNumber({ value, min, max, step = 1, suffix, onChange }: Props) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; base: number } | null>(null);

  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const quantize = (v: number) => Number((Math.round(v / step) * step).toFixed(3));

  // 滚轮必须用非 passive 监听，否则 preventDefault 无效、整页会跟着滚
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || editing) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dir = e.deltaY > 0 ? -1 : 1;
      const mult = e.shiftKey ? 0.1 : e.altKey ? 10 : 1;
      onChange(clamp(quantize(value + dir * step * mult)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [value, step, min, max, editing, onChange]);

  const commit = () => {
    const v = Number(text);
    if (!Number.isNaN(v)) onChange(clamp(quantize(v)));
    setEditing(false);
  };

  return (
    <div
      ref={wrapRef}
      className={`scrub-num${editing ? " editing" : ""}`}
      title="左右拖动改值 · 滚轮微调 · 双击直接填"
      onPointerDown={(e) => {
        if (editing) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        dragRef.current = { x: e.clientX, base: value };
      }}
      onPointerMove={(e) => {
        const d = dragRef.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        if (Math.abs(dx) < 1) return;
        const mult = e.shiftKey ? 0.1 : e.altKey ? 10 : 1;
        onChange(clamp(quantize(d.base + dx * step * mult)));
      }}
      onPointerUp={(e) => {
        dragRef.current = null;
        (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
      }}
      onDoubleClick={() => {
        setText(String(value));
        setEditing(true);
      }}
    >
      {editing ? (
        <input
          autoFocus
          className="scrub-num-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <span className="scrub-num-value">
          {value}
          {suffix ?? ""}
        </span>
      )}
    </div>
  );
}
