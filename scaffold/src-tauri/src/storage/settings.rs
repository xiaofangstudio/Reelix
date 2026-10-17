//! 应用设置。写在 `%APPDATA%\Reelix\settings.json`，与 `src/services/settings.ts` 对齐。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// 默认缓存上限：20 GB。
const DEFAULT_CACHE_LIMIT: u64 = 20 * 1024 * 1024 * 1024;
/// 默认自动保存间隔：5 分钟。
const DEFAULT_AUTO_SAVE_MS: u64 = 5 * 60 * 1000;

/// 应用设置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// 缓存目录，可改
    pub cache_dir: String,
    /// 缓存上限，默认 20GB
    pub cache_limit_bytes: u64,
    /// 预览缩放，0.25 ~ 1.0
    pub preview_scale: f64,
    /// 自动保存间隔，毫秒；0 表示关闭
    pub auto_save_interval_ms: u64,
    /// 界面语言，全中文界面固定 zh-CN
    pub language: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            cache_dir: default_cache_dir(),
            cache_limit_bytes: DEFAULT_CACHE_LIMIT,
            preview_scale: 1.0,
            auto_save_interval_ms: DEFAULT_AUTO_SAVE_MS,
            language: "zh-CN".into(),
        }
    }
}

impl Settings {
    /// 把预览缩放夹到合法区间。
    pub fn clamp_preview_scale(&mut self) {
        self.preview_scale = self.preview_scale.clamp(0.25, 1.0);
    }

    /// 配置文件路径：`%APPDATA%\Reelix\settings.json`。
    pub fn config_path() -> PathBuf {
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        base.join("Reelix").join("settings.json")
    }

    /// 从磁盘读取；文件不存在或解析失败时回落到默认值。
    pub fn load() -> Self {
        let path = Self::config_path();
        let mut settings = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
            .unwrap_or_default();
        settings.clamp_preview_scale();
        settings
    }

    /// 写回磁盘。
    pub fn save(&self) -> Result<(), String> {
        let path = Self::config_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("创建设置目录失败：{e}"))?;
        }
        let json = serde_json::to_vec_pretty(self).map_err(|e| format!("设置序列化失败：{e}"))?;
        std::fs::write(&path, json).map_err(|e| format!("写入设置失败：{e}"))
    }
}

/// 默认缓存目录：`%APPDATA%\Reelix\cache`。
fn default_cache_dir() -> String {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("Reelix").join("cache").to_string_lossy().into_owned()
}
