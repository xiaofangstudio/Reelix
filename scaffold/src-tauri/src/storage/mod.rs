//! 存储领域：本机设置与（后续的）缓存目录管理。
//!
//! 没有云同步、没有账号，配置只落本机，见 `src/services/settings.ts` 的说明。

pub mod settings;

pub use settings::Settings;
