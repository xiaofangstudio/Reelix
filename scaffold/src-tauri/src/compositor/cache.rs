//! 帧缓存：内存 + 磁盘两级，容量都有上限。
//!
//! 监视器拖动播放头时会高频请求帧，同一时间点往往被反复要到：
//! - **内存级**：最近若干张已编码的 PNG 留在内存里，回拖时零磁盘 I/O；
//! - **磁盘级**：写进 `缓存目录/frames/<序列>/<宽>x<高>/`，进程重启后仍能命中。
//!
//! 两级都必须有上限，否则长时间剪辑会把内存和磁盘吃满：
//! 内存按字节预算（[`MEMORY_BUDGET`]）逐出最旧，磁盘按文件条数（[`DISK_MAX_FILES`]）淘汰最旧。

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// 内存里最多留多少字节的已编码帧。
const MEMORY_BUDGET: u64 = 192 * 1024 * 1024;
/// 磁盘上最多留多少个帧文件，超出按修改时间淘汰最旧的。
const DISK_MAX_FILES: usize = 400;

/// 两级帧缓存。键就是帧图片的绝对路径——同一时间点必然同一路径。
#[derive(Debug, Default)]
pub struct FrameCache {
    /// 按最近使用顺序排列的键，队首最旧。
    order: VecDeque<String>,
    frames: HashMap<String, Vec<u8>>,
    bytes: u64,
}

impl FrameCache {
    /// 命中内存缓存。
    pub fn get(&self, key: &str) -> Option<&[u8]> {
        self.frames.get(key).map(|v| v.as_slice())
    }

    /// 放进内存缓存；超出字节预算时从最旧的开始逐出。
    pub fn put(&mut self, key: String, bytes: Vec<u8>) {
        if self.frames.contains_key(&key) {
            self.order.retain(|k| k != &key);
            if let Some(old) = self.frames.remove(&key) {
                self.bytes = self.bytes.saturating_sub(old.len() as u64);
            }
        }
        self.bytes = self.bytes.saturating_add(bytes.len() as u64);
        self.order.push_back(key.clone());
        self.frames.insert(key, bytes);

        // 一张帧就可能超过预算（超大画幅），先兜住「至少留一张」，再按预算逐出。
        while self.bytes > MEMORY_BUDGET && self.order.len() > 1 {
            if let Some(oldest) = self.order.pop_front() {
                if let Some(dropped) = self.frames.remove(&oldest) {
                    self.bytes = self.bytes.saturating_sub(dropped.len() as u64);
                }
            }
        }
    }

    /// 清空内存缓存。
    pub fn clear(&mut self) {
        self.order.clear();
        self.frames.clear();
        self.bytes = 0;
    }

    /// 内存缓存占用字节数。
    pub fn memory_bytes(&self) -> u64 {
        self.bytes
    }

    /// 内存里存了几张。
    pub fn len(&self) -> usize {
        self.frames.len()
    }

    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }
}

/// 帧缓存根目录：`<缓存目录>/frames`。
pub fn frames_root(cache_dir: &Path) -> PathBuf {
    cache_dir.join("frames")
}

/// 某个序列在某个画幅下的帧目录。
///
/// 序列 id 只保留字母数字与短横线，避免它带出路径分隔符把文件写错地方。
pub fn frame_dir(cache_dir: &Path, sequence_id: &str, width: usize, height: usize) -> PathBuf {
    let safe: String = sequence_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let safe = if safe.is_empty() {
        "sequence".to_string()
    } else {
        safe
    };
    frames_root(cache_dir)
        .join(safe)
        .join(format!("{width}x{height}"))
}

/// 一帧的缓存文件路径。`time_ms` 已按序列帧率吸附过，这里只负责取名。
///
/// 负时刻（理论上不该出现）写成 `f-n<毫秒>`，避免文件名里出现连续的减号。
pub fn frame_file(
    cache_dir: &Path,
    sequence_id: &str,
    width: usize,
    height: usize,
    time_ms: f64,
) -> PathBuf {
    let ms = time_ms.round() as i64;
    let name = if ms < 0 {
        format!("f-n{}.png", ms.unsigned_abs())
    } else {
        format!("f-{ms}.png")
    };
    frame_dir(cache_dir, sequence_id, width, height).join(name)
}

/// 统计一个目录（含子目录）里的文件数与总字节数。
pub fn dir_stats(dir: &Path) -> (usize, u64) {
    let mut files = 0usize;
    let mut bytes = 0u64;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (0, 0);
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            let (sub_files, sub_bytes) = dir_stats(&entry.path());
            files += sub_files;
            bytes += sub_bytes;
        } else {
            files += 1;
            bytes += meta.len();
        }
    }
    (files, bytes)
}

/// 删除整个帧缓存目录，返回删掉的文件数与字节数。
pub fn clear_disk(cache_dir: &Path) -> (usize, u64) {
    let root = frames_root(cache_dir);
    let (files, bytes) = dir_stats(&root);
    if root.exists() {
        let _ = std::fs::remove_dir_all(&root);
    }
    (files, bytes)
}

/// 帧文件超量时淘汰最旧的，返回淘汰后剩余文件数与总字节数。
///
/// 按修改时间排序而不是文件名：同名规则下文件名的字典序并不等于时间序，
/// 而且用户可能改过画幅，跨目录比较只能靠修改时间。
pub fn prune_disk(cache_dir: &Path, max_files: usize) -> (usize, u64) {
    let root = frames_root(cache_dir);
    let mut files: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
    collect_files(&root, &mut files);

    if files.len() <= max_files {
        let bytes = files.iter().map(|(_, len, _)| *len).sum();
        return (files.len(), bytes);
    }

    files.sort_by_key(|(modified, _, _)| *modified);
    let drop_count = files.len() - max_files;
    for (_, len, path) in files.iter().take(drop_count) {
        let _ = std::fs::remove_file(path);
        let _ = len;
    }
    let remaining: u64 = files.iter().skip(drop_count).map(|(_, len, _)| *len).sum();
    (max_files, remaining)
}

/// 递归收集一个目录下的全部文件，带上修改时间与长度。
fn collect_files(dir: &Path, out: &mut Vec<(SystemTime, u64, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            collect_files(&entry.path(), out);
        } else {
            let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            out.push((modified, meta.len(), entry.path()));
        }
    }
}

/// 做一次磁盘缓存整理：先按条数淘汰，再回报现状。
pub fn tidy_disk(cache_dir: &Path) -> (usize, u64) {
    prune_disk(cache_dir, DISK_MAX_FILES)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(n: usize) -> String {
        format!("C:/cache/frames/seq/64x64/f-{n}.png")
    }

    #[test]
    fn put_then_get_round_trips() {
        let mut cache = FrameCache::default();
        assert!(cache.get(&key(1)).is_none());
        cache.put(key(1), vec![1, 2, 3, 4]);
        assert_eq!(cache.get(&key(1)), Some(&[1u8, 2, 3, 4][..]));
        assert_eq!(cache.memory_bytes(), 4);
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn re_putting_same_key_does_not_double_count() {
        let mut cache = FrameCache::default();
        cache.put(key(1), vec![0u8; 10]);
        cache.put(key(1), vec![0u8; 4]);
        assert_eq!(cache.len(), 1, "同一时间点只该留一份");
        assert_eq!(cache.memory_bytes(), 4, "旧的一份要从字节数里扣掉");
    }

    #[test]
    fn clear_releases_everything() {
        let mut cache = FrameCache::default();
        cache.put(key(1), vec![0u8; 8]);
        cache.put(key(2), vec![0u8; 8]);
        cache.clear();
        assert!(cache.is_empty());
        assert_eq!(cache.memory_bytes(), 0);
    }

    #[test]
    fn oversized_frame_is_still_kept_once() {
        let mut cache = FrameCache::default();
        // 超过预算的一张：不能因为逐出把自己也删掉，否则刚存的帧立刻取不到。
        cache.put(key(1), vec![0u8; (MEMORY_BUDGET + 1024) as usize]);
        assert_eq!(cache.len(), 1);
        assert!(cache.get(&key(1)).is_some());
    }

    #[test]
    fn frame_dir_sanitizes_sequence_id() {
        let dir = frame_dir(Path::new("C:/cache"), "../evil/seq", 64, 64);
        let text = dir.to_string_lossy();
        assert!(!text.contains(".."), "序列 id 里的路径片段必须被滤掉：{text}");
        assert!(text.ends_with("64x64"));
    }

    #[test]
    fn frame_file_names_negative_time_without_double_dash() {
        let path = frame_file(Path::new("C:/cache"), "seq-1", 32, 32, -250.0);
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(name, "f-n250.png");
    }

    #[test]
    fn prune_keeps_newest_files_only() {
        let dir = std::env::temp_dir().join(format!("reelix-cache-{}", std::process::id()));
        let frames = frames_root(&dir).join("seq").join("8x8");
        std::fs::create_dir_all(&frames).unwrap();

        for i in 0..5 {
            let path = frames.join(format!("f-{i}.png"));
            std::fs::write(&path, vec![0u8; 10]).unwrap();
            // 明确拉开修改时间，避免同一毫秒内写入导致排序不稳。
            std::thread::sleep(std::time::Duration::from_millis(12));
        }

        let (files, bytes) = prune_disk(&dir, 2);
        assert_eq!(files, 2, "只该留最新的两张");
        assert_eq!(bytes, 20);
        assert!(frames.join("f-4.png").exists(), "最新的必须留下");

        clear_disk(&dir);
        assert_eq!(dir_stats(&frames_root(&dir)), (0, 0));
    }
}
