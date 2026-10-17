//! 最小 PNG 编码器（零依赖）。
//!
//! 为什么自己写：合成出来的帧要落成 PNG 给监视器显示与磁盘缓存复用，
//! 但为了守住 150MB 体积红线与「不引入多余依赖」的纪律，不引 `png`/`image`。
//! 这里只编码 8 位 RGBA、不滤波、deflate 用 stored（不压缩）块——
//! 结构完全符合 PNG 规范，任何解码器都能读，代价只是文件略大。
//!
//! 规范依据：PNG (W3C) 第二版 —— 签名、IHDR/IDAT/IEND 三类关键块、
//! 每块尾随 CRC32；zlib 流 = 2 字节头 + deflate 数据 + Adler32。

/// PNG 文件签名。
const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// 单个 stored 块最多承载 65535 字节（长度字段是 u16）。
const MAX_STORED_BLOCK: usize = 65535;

/// 把 8 位 RGBA 像素编码成一张 PNG。
///
/// `rgba` 长度应当为 `width * height * 4`；短了按黑补齐、长了忽略多余部分，
/// 无论如何都不会 panic。
pub fn encode_rgba8(width: usize, height: usize, rgba: &[u8]) -> Vec<u8> {
    let w = width.max(1);
    let h = height.max(1);
    let stride = w * 4;

    // 每条扫描线前面加一个滤波器字节（0 表示不滤波）。
    let mut raw = Vec::with_capacity(h * (1 + stride));
    for y in 0..h {
        raw.push(0u8);
        let start = y * stride;
        for i in 0..stride {
            let idx = start + i;
            raw.push(if idx < rgba.len() { rgba[idx] } else { 0 });
        }
    }

    let mut out = Vec::with_capacity(raw.len() + 128);
    out.extend_from_slice(&SIGNATURE);

    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&(w as u32).to_be_bytes());
    ihdr.extend_from_slice(&(h as u32).to_be_bytes());
    ihdr.push(8); // 位深：每通道 8 位
    ihdr.push(6); // 颜色类型：真彩 + Alpha
    ihdr.push(0); // 压缩方法：deflate
    ihdr.push(0); // 滤波方法：本编码器只用 0
    ihdr.push(0); // 不隔行
    write_chunk(&mut out, b"IHDR", &ihdr);

    write_chunk(&mut out, b"IDAT", &zlib_stream(&raw));
    write_chunk(&mut out, b"IEND", &[]);
    out
}

/// 写一个标准 PNG 块：长度 + 类型 + 数据 + CRC32（覆盖类型与数据）。
fn write_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);

    let mut crc_input = Vec::with_capacity(4 + data.len());
    crc_input.extend_from_slice(kind);
    crc_input.extend_from_slice(data);
    out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

/// 包一层 zlib 流。deflate 用 stored 块，不做熵编码。
fn zlib_stream(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len() + raw.len() / MAX_STORED_BLOCK * 5 + 8);
    // CMF = 0x78（deflate，32K 窗口）、FLG = 0x01，二者拼起来 % 31 == 0。
    out.push(0x78);
    out.push(0x01);
    out.extend_from_slice(&deflate_stored(raw));
    out.extend_from_slice(&adler32(raw).to_be_bytes());
    out
}

/// 用若干 stored（BTYPE=00）块承载数据。空输入也要吐一个结束块。
fn deflate_stored(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    if raw.is_empty() {
        out.push(0x01); // BFINAL=1, BTYPE=00
        out.extend_from_slice(&[0x00, 0x00, 0xFF, 0xFF]);
        return out;
    }

    let chunks: Vec<&[u8]> = raw.chunks(MAX_STORED_BLOCK).collect();
    for (i, chunk) in chunks.iter().enumerate() {
        let last = i + 1 == chunks.len();
        out.push(if last { 0x01 } else { 0x00 });
        let len = chunk.len() as u16;
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes()); // 长度反码，校验用
        out.extend_from_slice(chunk);
    }
    out
}

/// 标准 CRC-32（反射多项式 0xEDB88320），PNG 与 zip 共用。
pub fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// zlib 的 Adler-32 校验。
pub fn adler32(data: &[u8]) -> u32 {
    const MOD: u32 = 65521;
    let mut a = 1u32;
    let mut b = 0u32;
    for &byte in data {
        a += byte as u32;
        // 逐字节取模：a、b 始终小于 2×MOD，绝不会溢出 u32。
        // 攒到上万字节再取模的写法看着快，但 b 会先撞上 u32 上限。
        if a >= MOD {
            a -= MOD;
        }
        b += a;
        if b >= MOD {
            b -= MOD;
        }
    }
    (b << 16) | a
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 按块切开 PNG，返回 (类型, 数据) 列表。CRC 顺手校验。
    fn parse_chunks(png: &[u8]) -> Vec<(String, Vec<u8>)> {
        assert_eq!(&png[..8], &SIGNATURE, "开头必须是 PNG 签名");
        let mut offset = 8;
        let mut chunks = Vec::new();
        while offset < png.len() {
            let len = u32::from_be_bytes(png[offset..offset + 4].try_into().unwrap()) as usize;
            let kind = String::from_utf8(png[offset + 4..offset + 8].to_vec()).unwrap();
            let data = png[offset + 8..offset + 8 + len].to_vec();
            let stored = u32::from_be_bytes(
                png[offset + 8 + len..offset + 12 + len].try_into().unwrap(),
            );
            let mut crc_input = kind.clone().into_bytes();
            crc_input.extend_from_slice(&data);
            assert_eq!(stored, crc32(&crc_input), "{kind} 块的 CRC 不对");
            chunks.push((kind, data));
            offset += 12 + len;
        }
        chunks
    }

    /// 把 zlib 流解回原始字节：只认本编码器写出的 stored 块。
    fn inflate_stored(zlib: &[u8]) -> Vec<u8> {
        assert_eq!(zlib[0], 0x78, "zlib CMF 不对");
        let mut offset = 2;
        let mut out = Vec::new();
        loop {
            let header = zlib[offset];
            let last = header & 1 == 1;
            assert_eq!(header & 0b0000_0110, 0, "本编码器只写 stored 块");
            let len = u16::from_le_bytes(zlib[offset + 1..offset + 3].try_into().unwrap()) as usize;
            let nlen = u16::from_le_bytes(zlib[offset + 3..offset + 5].try_into().unwrap());
            assert_eq!(nlen, !(len as u16), "stored 块长度反码不匹配");
            out.extend_from_slice(&zlib[offset + 5..offset + 5 + len]);
            offset += 5 + len;
            if last {
                break;
            }
        }
        let stored = u32::from_be_bytes(zlib[offset..offset + 4].try_into().unwrap());
        assert_eq!(stored, adler32(&out), "Adler32 不匹配");
        out
    }

    fn unfilter(raw: &[u8], width: usize, height: usize) -> Vec<u8> {
        let stride = width * 4;
        let mut out = Vec::with_capacity(stride * height);
        for y in 0..height {
            let start = y * (stride + 1);
            assert_eq!(raw[start], 0, "扫描线滤波器字节应当是 0");
            out.extend_from_slice(&raw[start + 1..start + 1 + stride]);
        }
        out
    }

    #[test]
    fn crc32_and_adler32_match_known_vectors() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926, "CRC-32 标准测试向量");
        assert_eq!(adler32(b""), 1, "空输入的 Adler32 应当是 1");
        assert_eq!(adler32(b"Wikipedia"), 0x11E6_0398, "Adler32 标准测试向量");
    }

    #[test]
    fn ihdr_carries_size_and_rgba_format() {
        let png = encode_rgba8(3, 2, &[0u8; 24]);
        let chunks = parse_chunks(&png);
        assert_eq!(chunks[0].0, "IHDR");
        let ihdr = &chunks[0].1;
        assert_eq!(u32::from_be_bytes(ihdr[0..4].try_into().unwrap()), 3);
        assert_eq!(u32::from_be_bytes(ihdr[4..8].try_into().unwrap()), 2);
        assert_eq!(ihdr[8], 8, "位深应为 8");
        assert_eq!(ihdr[9], 6, "颜色类型应为真彩 + Alpha");
        assert_eq!(ihdr[10], 0, "压缩方法应为 deflate");
        assert_eq!(ihdr[11], 0, "滤波方法应为 0");
        assert_eq!(ihdr[12], 0, "不应隔行");
        assert_eq!(chunks.last().unwrap().0, "IEND", "结尾必须是 IEND");
    }

    /// 编码 → 解回，像素必须逐字节一致。这是「显示器上看到的就是合成结果」的底线。
    #[test]
    fn pixels_round_trip_through_encoder() {
        let (w, h) = (5usize, 3usize);
        let pixels: Vec<u8> = (0..(w * h * 4)).map(|i| (i * 37 % 256) as u8).collect();
        let png = encode_rgba8(w, h, &pixels);
        let chunks = parse_chunks(&png);

        let idat: Vec<u8> = chunks
            .iter()
            .filter(|(kind, _)| kind == "IDAT")
            .flat_map(|(_, data)| data.clone())
            .collect();
        let raw = inflate_stored(&idat);
        assert_eq!(raw.len(), h * (w * 4 + 1), "解压后应当是「每行一个滤波器字节 + 像素」");
        assert_eq!(unfilter(&raw, w, h), pixels, "往返后像素必须一致");
    }

    /// 超过 65535 字节要自动切成多个 stored 块，否则长度字段会溢出。
    #[test]
    fn large_image_spans_multiple_stored_blocks() {
        let (w, h) = (200usize, 200usize); // 原始数据 160,200 字节
        let pixels: Vec<u8> = (0..(w * h * 4)).map(|i| (i % 251) as u8).collect();
        let png = encode_rgba8(w, h, &pixels);
        let chunks = parse_chunks(&png);
        let idat: Vec<u8> = chunks
            .iter()
            .filter(|(kind, _)| kind == "IDAT")
            .flat_map(|(_, data)| data.clone())
            .collect();
        let raw = inflate_stored(&idat);
        assert_eq!(unfilter(&raw, w, h), pixels);
    }

    /// 一像素的极端画幅也要能编码，且不因数据不足而 panic。
    #[test]
    fn single_pixel_and_short_input_are_safe() {
        let png = encode_rgba8(1, 1, &[255, 0, 0, 255]);
        let chunks = parse_chunks(&png);
        assert_eq!(chunks[0].0, "IHDR");
        let idat: Vec<u8> = chunks
            .iter()
            .filter(|(kind, _)| kind == "IDAT")
            .flat_map(|(_, data)| data.clone())
            .collect();
        assert_eq!(inflate_stored(&idat), vec![0, 255, 0, 0, 255]);

        // 数据短于 width*height*4 时按黑补齐，不该崩。
        let png = encode_rgba8(2, 2, &[1, 2, 3]);
        assert!(!png.is_empty());
    }

    /// 零尺寸画幅被夹到 1×1，避免除零与空缓冲。
    #[test]
    fn zero_size_is_clamped_to_one_pixel() {
        let png = encode_rgba8(0, 0, &[]);
        let chunks = parse_chunks(&png);
        assert_eq!(u32::from_be_bytes(chunks[0].1[0..4].try_into().unwrap()), 1);
        assert_eq!(u32::from_be_bytes(chunks[0].1[4..8].try_into().unwrap()), 1);
    }
}
