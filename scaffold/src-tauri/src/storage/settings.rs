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
    /// 界面主题：light / dark（旧设置缺省时按浅色，兼容老配置）
    #[serde(default = "default_theme")]
    pub theme: String,
    /// 静止图片上轨的默认时长（毫秒）。旧配置缺省时 5 秒。
    #[serde(default = "default_image_ms")]
    pub image_default_ms: u64,
    /// 新建项目管理窗口 / 新工程用的默认转场时长（毫秒）。旧配置缺省时 500ms。
    #[serde(default = "default_transition_ms")]
    pub transition_default_ms: u64,
    /// 手动新建字幕 / 文字的默认时长（毫秒）。旧配置缺省时 3 秒。
    #[serde(default = "default_subtitle_ms")]
    pub subtitle_default_ms: u64,
    /// 新建工程默认画幅宽。缺省 1920。
    #[serde(default = "default_width")]
    pub default_width: u32,
    /// 新建工程默认画幅高。缺省 1080。
    #[serde(default = "default_height")]
    pub default_height: u32,
    /// 新建工程默认帧率。缺省 25。
    #[serde(default = "default_frame_rate")]
    pub default_frame_rate: f64,
    /// 时间线自动吸附总开关。缺省开。
    #[serde(default = "default_true")]
    pub snap_enabled: bool,
}

/// 默认主题：浅色（绿雾林浅色主题）。
fn default_theme() -> String {
    "light".to_string()
}

fn default_true() -> bool {
    true
}

/// 静止图片默认 5 秒——剪映/PR 都是这个值，放上来不至于一闪而过。
fn default_image_ms() -> u64 {
    5000
}

/// 转场默认 0.5 秒，足够看清又不拖沓。
fn default_transition_ms() -> u64 {
    500
}

/// 字幕默认 3 秒，一句话读得完。
fn default_subtitle_ms() -> u64 {
    3000
}

fn default_width() -> u32 {
    1920
}

fn default_height() -> u32 {
    1080
}

fn default_frame_rate() -> f64 {
    25.0
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            cache_dir: default_cache_dir(),
            cache_limit_bytes: DEFAULT_CACHE_LIMIT,
            preview_scale: 1.0,
            auto_save_interval_ms: DEFAULT_AUTO_SAVE_MS,
            language: "zh-CN".into(),
            theme: default_theme(),
            image_default_ms: default_image_ms(),
            transition_default_ms: default_transition_ms(),
            subtitle_default_ms: default_subtitle_ms(),
            default_width: default_width(),
            default_height: default_height(),
            default_frame_rate: default_frame_rate(),
            snap_enabled: true,
        }
    }
}

impl Settings {
    /// 把预览缩放夹到合法区间。
    pub fn clamp_preview_scale(&mut self) {
        self.preview_scale = self.preview_scale.clamp(0.25, 1.0);
    }

    /// 把所有数值字段夹到合法区间。
    ///
    /// 手改坏了 settings.json 也不会让软件变得莫名其妙：
    /// 时长类最少 1 帧（按当前帧率算 40ms）、最多 10 分钟。
    pub fn clamp_all(&mut self) {
        self.clamp_preview_scale();
        self.image_default_ms = self.image_default_ms.clamp(200, 600_000);
        self.transition_default_ms = self.transition_default_ms.clamp(0, 10_000);
        self.subtitle_default_ms = self.subtitle_default_ms.clamp(200, 600_000);
        self.default_width = self.default_width.clamp(16, 16_384);
        self.default_height = self.default_height.clamp(16, 16_384);
        self.default_frame_rate = self.default_frame_rate.clamp(1.0, 240.0);
        if !self.default_frame_rate.is_finite() {
            self.default_frame_rate = default_frame_rate();
        }
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
        settings.clamp_all();
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
