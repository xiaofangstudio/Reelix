#!/usr/bin/env bash
# ============================================================================
# Reelix 自带 FFmpeg 的裁剪构建脚本（Windows）
#
# 目标：把 app 用不到的编解码 / 封装 / 滤镜全部关掉，整目录压到 35MB 以内，
# 从而守住安装包 ≤150MB 的红线（见 docs/07-安装与打包.md）。
#
# 用法（在 MSYS2 的「MINGW64」或「UCRT64」终端里）：
#   pacman -S --needed base-devel mingw-w64-x86_64-toolchain \
#     mingw-w64-x86_64-cmake mingw-w64-x86_64-nasm \
#     mingw-w64-x86_64-libass mingw-w64-x86_64-freetype \
#     mingw-w64-x86_64-fribidi mingw-w64-x86_64-harfbuzz \
#     mingw-w64-x86_64-fontconfig mingw-w64-x86_64-lame \
#     mingw-w64-x86_64-zlib
#   ./build-windows.sh
#
# 只看看 configure 会怎么跑、不真编译：
#   ./build-windows.sh --dry-run
#
# 也可以把源码包放到同目录，脚本会优先用本地包：
#   ./build-windows.sh --source ./ffmpeg-8.1.tar.xz
#
# 脚本只开 LGPL 组件（不含 libx264 / libx265），产物仍是 LGPL 2.1+。
# 编码走 Windows 原生 Media Foundation（h264_mf / hevc_mf），
# 不依赖任何 GPL 库；这与 src/commands/export.rs 的编码器候选列表一致。
# ============================================================================

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FFMPEG_VERSION="${FFMPEG_VERSION:-8.1}"
WORK_DIR="${WORK_DIR:-$HERE/.build}"
PREFIX="${PREFIX:-$WORK_DIR/prefix}"
BUDGET_MB=35
DRY_RUN=0
SOURCE_PKG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --source) SOURCE_PKG="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# 0. 环境检查
# ---------------------------------------------------------------------------
if [[ "${MSYSTEM:-}" != "MINGW64" && "${MSYSTEM:-}" != "UCRT64" ]]; then
  echo "?? 建议在 MSYS2 的 MINGW64 / UCRT64 终端里运行（当前 MSYSTEM=${MSYSTEM:-未设置}）。"
  echo "   若确实要交叉编译，请设置 CROSS_PREFIX=x86_64-w64-mingw32- 并保证工具链在 PATH 里。"
fi

for tool in make gcc pkg-config; do
  command -v "$tool" >/dev/null 2>&1 || { echo "缺少 $tool，请先装 MSYS2 工具链" >&2; exit 1; }
done

mkdir -p "$WORK_DIR"

# ---------------------------------------------------------------------------
# 1. 取源码
# ---------------------------------------------------------------------------
SRC_DIR="$WORK_DIR/ffmpeg-$FFMPEG_VERSION"
if [[ ! -d "$SRC_DIR" ]]; then
  if [[ -n "$SOURCE_PKG" ]]; then
    echo "==> 解压本地源码：$SOURCE_PKG"
    case "$SOURCE_PKG" in
      *.tar.xz) tar -xJf "$SOURCE_PKG" -C "$WORK_DIR" ;;
      *.tar.gz|*.tgz) tar -xzf "$SOURCE_PKG" -C "$WORK_DIR" ;;
      *) echo "只认 .tar.xz / .tar.gz" >&2; exit 1 ;;
    esac
  else
    echo "==> 下载 FFmpeg $FFMPEG_VERSION 源码"
    curl -fL --retry 3 -o "$WORK_DIR/ffmpeg-$FFMPEG_VERSION.tar.xz" \
      "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
    tar -xJf "$WORK_DIR/ffmpeg-$FFMPEG_VERSION.tar.xz" -C "$WORK_DIR"
  fi
fi

# ---------------------------------------------------------------------------
# 2. configure 参数
#
# 这里的每一项都对应 Reelix 实际会走到的路径：
#   - 解码：时间线预览 / 导出前的源素材（h264 / hevc / prores / 手机常见的
#     hevc 10bit? 10bit 交给 yuv420p 转换，转不了会明确报错，不静默）；
#   - 编码：export.rs 的候选顺序 h264_mf → libopenh264 → h264_nvenc → libx264，
#     以及 hevc_mf → hevc_nvenc → libx265。本构建只提供 Media Foundation 两檔；
#   - 封装：导出 mp4（mov muxer）与音频 m4a，代理/缓存用 matroska；
#   - 滤镜：缩放 / 补边 / 帧率 / 裁剪 / 拼接 / 音量 / 重采样 / 字幕烧录。
# 关掉 avdevice（采集设备）可以少一个 4.7MB 的 DLL。
# ---------------------------------------------------------------------------
CONFIGURE_FLAGS=(
  --prefix="$PREFIX"
  --enable-shared
  --disable-static
  --disable-doc
  --disable-ffplay
  --disable-avdevice
  --disable-autodetect
  --enable-zlib

  --disable-everything
  --enable-avcodec
  --enable-avformat
  --enable-avfilter
  --enable-swscale
  --enable-swresample
  --enable-ffmpeg
  --enable-ffprobe

  # 本地文件 + 管道（export.rs 用 pipe:0 喂 rawvideo / pcm）
  --enable-protocol=file,pipe

  # 解封装
  --enable-demuxer=rawvideo,image2,mov,matroska,wav,mp3,flac,ogg,concat

  # 封装
  --enable-muxer=mp4,mov,matroska,webm,wav,mp3,flac,ogg,image2,rawvideo,null

  # 解码
  --enable-decoder=h264,hevc,prores,mjpeg,png,bmp,webp,vp8,vp9,av1,mp3,aac,flac,vorbis,opus,pcm_s16le,pcm_s24le,pcm_f32le,rawvideo

  # 编码（h264_mf / hevc_mf 由 Media Foundation 提供）
  --enable-encoder=h264_mf,hevc_mf,aac,pcm_s16le,pcm_s24le,pcm_f32le,png,mjpeg,rawvideo,prores_ks,flac,wrapped_avframe

  # 解析器 / 码流过滤器（mp4 重封装与字幕轨需要）
  --enable-parser=h264,hevc,mpegaudio,aac,flac,vorbis,opus,vp8,vp9,png
  --enable-bsf=aac_adtstoasc,h264_mp4toannexb,hevc_mp4toannexb,extract_extradata,vp9_superframe

  # 滤镜
  --enable-filter=scale,pad,format,fps,trim,atrim,concat,amix,volume,aresample,anull,null,subtitles,overlay,crop,transpose,split,setpts,asetpts,apad,afade,color

  # 字幕烧录（subtitle.rs → libass；字体走 fontconfig）
  --enable-libass
  --enable-libfreetype
  --enable-libfribidi
  --enable-libharfbuzz
  --enable-libfontconfig

  # 音频导出兜底
  --enable-libmp3lame

  # Windows 原生硬件编码
  --enable-mediafoundation
)

if [[ "${MSYSTEM:-}" != "MINGW64" && "${MSYSTEM:-}" != "UCRT64" ]]; then
  CONFIGURE_FLAGS+=(
    --target-os=mingw32
    --arch=x86_64
    --cross-prefix="${CROSS_PREFIX:-x86_64-w64-mingw32-}"
  )
fi

cd "$SRC_DIR"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "==> configure 预览（不执行）："
  printf '    ./configure %q\n' "${CONFIGURE_FLAGS[@]}"
  exit 0
fi

echo "==> configure"
./configure "${CONFIGURE_FLAGS[@]}"

echo "==> make（-j$(nproc)）"
make -j"$(nproc)"
make install

# ---------------------------------------------------------------------------
# 3. 收集产物到本目录
# ---------------------------------------------------------------------------
echo "==> 复制 exe + DLL 到 $HERE"
rm -f "$HERE"/ffmpeg.exe "$HERE"/ffprobe.exe "$HERE"/*.dll
cp "$PREFIX/bin/ffmpeg.exe" "$PREFIX/bin/ffprobe.exe" "$HERE/"
# 共享构建的依赖 DLL 都在 prefix/bin 下
find "$PREFIX/bin" -maxdepth 1 -name '*.dll' -exec cp {} "$HERE/" \;

# ---------------------------------------------------------------------------
# 4. 体积核对
# ---------------------------------------------------------------------------
TOTAL_KB=$(du -sk "$HERE" --exclude=.build | awk '{print $1}')
TOTAL_MB=$(awk -v kb="$TOTAL_KB" 'BEGIN { printf "%.1f", kb/1024 }')
echo
echo "================ FFmpeg 产物体积 ================"
du -h "$HERE"/*.exe "$HERE"/*.dll | sort -h
echo "-------------------------------------------------"
echo "合计：${TOTAL_MB} MB / 预算 ${BUDGET_MB} MB"
if awk -v mb="$TOTAL_MB" -v budget="$BUDGET_MB" 'BEGIN { exit !(mb > budget) }'; then
  echo "!! 超出预算：请再核对是否误开了编解码器（avcodec 通常是大头）"
  exit 2
fi
echo "OK：在预算内。"
echo
echo "下一步："
echo "  1) 抽查编码器：./ffmpeg.exe -hide_banner -encoders | grep -E 'h264_mf|hevc_mf'"
echo "  2) 抽查字幕：  ./ffmpeg.exe -hide_banner -filters | grep subtitles"
echo "  3) 回填 BUILD-INFO.txt 的版本与体积，再跑 npx tauri build --no-bundle"
