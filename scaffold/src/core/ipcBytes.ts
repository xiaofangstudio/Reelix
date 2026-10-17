/**
 * IPC 字节防御层。
 *
 * 后端用 `tauri::ipc::Response` 回 PNG 原始字节，前端 `invoke<ArrayBuffer>`
 * 拿到的正常情况就是 ArrayBuffer。但 IPC 层升级 / 序列化形态变化时，
 * 可能拿到 Uint8View、普通数组甚至 `{0:137,1:80,…}` 这种 JSON 形态——
 * 直接 `new Blob([奇怪形态])` 会得到一张「加载失败」的破图，
 * 监视器黑屏、缩略图显示 alt 文字，都是这么来的。
 *
 * 这里把所有形态规范化成 ArrayBuffer，图形消费点（监视器、缩略图缓存）
 * 一律先过这一道，杜绝「破图」这类不可理解的表现。
 */

/** 把 invoke 拿到的二进制载荷规范成 ArrayBuffer；认不出时抛中文错误 */
export function toBytes(data: unknown): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    const view = data as Uint8Array;
    const copy = new Uint8Array(view.byteLength);
    copy.set(view);
    return copy.buffer;
  }
  if (Array.isArray(data)) return new Uint8Array(data).buffer;
  if (data !== null && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const keys = Object.keys(record);
    // JSON 形态的稀疏字节数组：键是数字下标
    if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
      const len = Math.max(...keys.map(Number)) + 1;
      const arr = new Uint8Array(len);
      for (const k of keys) arr[Number(k)] = Number(record[k]) & 0xff;
      return arr.buffer;
    }
  }
  throw new Error("渲染服务返回的数据格式不对，无法显示画面");
}

/** 字节 → PNG 的 objectURL。给监视器与缩略图共用 */
export function bytesToObjectUrl(data: unknown): string {
  return URL.createObjectURL(new Blob([toBytes(data)], { type: "image/png" }));
}

/**
 * 诊断用：描述一笔 IPC 载荷的形态、字节数与前 8 字节十六进制。
 * 监视器把它画在角落——「黑屏/破图」时一眼看出是没收到数据还是收到了坏数据。
 */
export function describeBytes(data: unknown): string {
  try {
    const bytes = new Uint8Array(toBytes(data));
    const head = Array.from(bytes.slice(0, 8))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
    return `${data instanceof ArrayBuffer ? "ArrayBuffer" : data instanceof Uint8Array ? "Uint8Array" : Array.isArray(data) ? "Array" : typeof data} · ${bytes.length}B · [${head}]`;
  } catch (err) {
    return `无法解析载荷：${err instanceof Error ? err.message : String(err)}`;
  }
}
