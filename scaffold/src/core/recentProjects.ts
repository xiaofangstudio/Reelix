/**
 * 最近打开的工程。
 *
 * 只存在本机 localStorage 里：不联网、不上报、不写后端——Reelix 没有账号体系。
 * 开场界面的「打开最近工程」据此列出来，最常用的一条排在最前。
 */

/** 一条最近工程的记录 */
export interface RecentProject {
  /** 工程文件的绝对路径 */
  path: string;
  /** 工程名，用于列表显示 */
  name: string;
  /** 最近一次打开或保存的毫秒时间戳 */
  at: number;
}

const STORAGE_KEY = "reelix.recentProjects";
/** 最多记这么多条，再多就顶掉最旧的 */
const MAX_RECENT = 8;

/** 读最近工程列表；localStorage 不可用或内容损坏时给空数组，不抛错。 */
export function loadRecentProjects(): RecentProject[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is RecentProject => {
        const record = item as Partial<RecentProject>;
        return (
          typeof record.path === "string" &&
          typeof record.name === "string" &&
          typeof record.at === "number"
        );
      })
      .sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

/** 记一条最近工程：同路径去重后置顶，最多留 MAX_RECENT 条。 */
export function rememberRecentProject(path: string, name: string): void {
  const rest = loadRecentProjects().filter((record) => record.path !== path);
  const next = [{ path, name, at: Date.now() }, ...rest].slice(0, MAX_RECENT);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 存不下就算了，不影响打开工程这件正事
  }
}
