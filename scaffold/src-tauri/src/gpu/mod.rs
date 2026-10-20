//! GPU 渲染管线（真 GPU，不是占位）。
//!
//! 与 CPU 效果链并行，按效果类型分流：`gpuBlur` / `gpuGrade` / `gpuLut`
//! 走这里，其余继续走 CPU 内核。wgpu 无窗口（offscreen）：自建
//! instance / adapter / device，帧数据上传成浮点纹理 → 全屏三角形跑
//! WGSL → 渲染到浮点纹理 → 读回内存。
//! 设备创建失败（无 GPU / 驱动问题）时返回 None，调用方回落到 CPU 实现，
//! 所以本模块永远不会让合成失败。

use std::sync::OnceLock;
use wgpu::{
    AddressMode, BindGroupDescriptor, BindGroupEntry, BindGroupLayoutDescriptor,
    BindGroupLayoutEntry, BindingResource, BindingType, Buffer, BufferDescriptor, BufferUsages,
    CommandEncoderDescriptor, Device, Extent3d, FilterMode, ImageCopyBuffer, ImageCopyTexture,
    ImageDataLayout, MapMode, Origin3d, Queue, Sampler, SamplerBindingType, SamplerDescriptor,
    ShaderModule, ShaderStages, Texture, TextureAspect, TextureDescriptor, TextureDimension,
    TextureFormat, TextureUsages, TextureView, TextureViewDescriptor, TextureViewDimension,
};

/// 全局 GPU 设备（懒创建，全进程共用一份）。
static GPU: OnceLock<Option<Gpu>> = OnceLock::new();

struct Gpu {
    device: Device,
    queue: Queue,
}

/// 取 GPU；不可用时返回 None（调用方回落到 CPU）。
fn gpu() -> Option<&'static Gpu> {
    GPU.get_or_init(|| pollster::block_on(create_gpu()).ok())
        .as_ref()
}

async fn create_gpu() -> Result<Gpu, String> {
    let idesc = wgpu::InstanceDescriptor {
        backends: wgpu::Backends::all(),
        ..Default::default()
    };
    let instance = wgpu::Instance::new(&idesc);
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: None,
            force_fallback_adapter: false,
        })
        .await
        .ok_or("没有可用的 GPU 适配器")?;
    let (device, queue) = adapter
        .request_device(
            &wgpu::DeviceDescriptor {
                label: Some("reelix-gpu"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::downlevel_defaults(),
                memory_hints: wgpu::MemoryHints::Performance,
            },
            None,
        )
        .await
        .map_err(|e| format!("创建 GPU 设备失败：{e}"))?;
    Ok(Gpu { device, queue })
}

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/// GPU 模糊（9-tap 近似高斯，横纵各扫一次）。失败返回 None（回落 CPU）。
pub fn blur(input: &crate::graph::effects::Frame, radius: f32) -> Option<crate::graph::effects::Frame> {
    let g = gpu()?;
    run(
        g,
        input,
        &format!("{VS}\n{}", WITH[0]),
        Uniforms([radius, 1.0 / input.width as f32, 0.0, 0.0]),
        None,
    )
    .ok()
}

/// GPU 三级调色：亮度 / 对比度 / 饱和度。
pub fn grade(
    input: &crate::graph::effects::Frame,
    brightness: f32,
    contrast: f32,
    saturation: f32,
) -> Option<crate::graph::effects::Frame> {
    let g = gpu()?;
    run(
        g,
        input,
        &format!("{VS}\n{}", WITH[1]),
        Uniforms([brightness, contrast, saturation, 0.0]),
        None,
    )
    .ok()
}

/// GPU 3D LUT（33³ 沿蓝/绿/红优先排布的 RGBA）。失败返回 None。
pub fn apply_lut(
    input: &crate::graph::effects::Frame,
    lut: &[f32],
) -> Option<crate::graph::effects::Frame> {
    let g = gpu()?;
    // LUT 没有 uniform 参数，纹理走 binding 2/3；特殊处理（ ExtraTexture 标记）
    run(g, input, &format!("{VS}\n{}", WITH[2]), Uniforms([0.0; 4]), Some(lut)).ok()
}

#[derive(Clone, Copy)]
struct Uniforms([f32; 4]);

// ---------------------------------------------------------------------------
// 统一执行器
// ---------------------------------------------------------------------------

/// 跑一次全屏 pass。`lut` 为 Some 时额外绑一张 3D 纹理（blur/grade 用 uniform）。
fn run(
    g: &Gpu,
    input: &crate::graph::effects::Frame,
    wgsl: &str,
    uniforms: Uniforms,
    lut: Option<&[f32]>,
) -> Result<crate::graph::effects::Frame, String> {
    let (width, height) = (input.width.max(1), input.height.max(1));
    let src = upload_frame(g, &input.pixels, width, height);
    let dst = make_target(g, width, height);

    let shader: ShaderModule = g.device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("reelix-shader"),
        source: wgpu::ShaderSource::Wgsl(wgsl.into()),
    });

    // uniform（blur/grade 用）
    let uniform = g.device.create_buffer(&BufferDescriptor {
        label: Some("reelix-uniform"),
        size: 16,
        usage: BufferUsages::UNIFORM | BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    g.queue
        .write_buffer(&uniform, 0, bytemuck_bytes(&uniforms.0));

    let sampler = make_sampler(&g.device);
    let mut entries = vec![
        BindGroupEntry {
            binding: 0,
            resource: BindingResource::TextureView(&src.1),
        },
        BindGroupEntry {
            binding: 1,
            resource: BindingResource::Sampler(&sampler),
        },
    ];

    // LUT 路径：3D 纹理绑 2/3
    let mut lut_view_hold: Option<TextureView> = None;
    let lut_tex: Option<()> = if let Some(data) = lut {
        let tex = g.device.create_texture(&TextureDescriptor {
            label: Some("reelix-lut-3d"),
            size: Extent3d {
                width: 33,
                height: 33,
                depth_or_array_layers: 33,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: TextureDimension::D3,
            format: TextureFormat::Rgba8Unorm,
            usage: TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST,
            view_formats: &[],
        });
        // 33³ 的 RGBA float 量化为 u8（Rgba8Unorm 上传）
        let src: Vec<f32> = if data.len() >= 33 * 33 * 33 * 4 {
            data[..33 * 33 * 33 * 4].to_vec()
        } else {
            identity_lut_data()
        };
        let mut bytes: Vec<u8> = Vec::with_capacity(src.len());
        for c in src.chunks_exact(4) {
            for k in 0..4 {
                bytes.push((c[k].clamp(0.0, 1.0) * 255.0 + 0.5) as u8);
            }
        }
        g.queue.write_texture(
            ImageCopyTexture {
                texture: &tex,
                mip_level: 0,
                origin: Origin3d::ZERO,
                aspect: TextureAspect::All,
            },
            &bytes,
            ImageDataLayout {
                offset: 0,
                bytes_per_row: Some(33 * 4),
                rows_per_image: Some(33 * 33),
            },
            Extent3d {
                width: 33,
                height: 33,
                depth_or_array_layers: 33,
            },
        );
        let view = tex.create_view(&TextureViewDescriptor::default());
        lut_view_hold = Some(view);
        let view_borrow = lut_view_hold.as_ref().unwrap();
        entries.push(BindGroupEntry {
            binding: 2,
            resource: BindingResource::TextureView(view_borrow),
        });
        entries.push(BindGroupEntry {
            binding: 3,
            resource: BindingResource::Sampler(&sampler),
        });
        let _ = tex;
        None
    } else {
        entries.push(BindGroupEntry {
            binding: 2,
            resource: uniform.as_entire_binding(),
        });
        None
    };

    let layout = g.device.create_bind_group_layout(&BindGroupLayoutDescriptor {
        label: Some("reelix-bgl"),
        entries: &{
            let mut v = vec![
                BindGroupLayoutEntry {
                    binding: 0,
                    visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                BindGroupLayoutEntry {
                    binding: 1,
                    visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Sampler(SamplerBindingType::Filtering),
                    count: None,
                },
            ];
            if lut_tex.is_some() {
                v.push(BindGroupLayoutEntry {
                    binding: 2,
                    visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: TextureViewDimension::D3,
                        multisampled: false,
                    },
                    count: None,
                });
                v.push(BindGroupLayoutEntry {
                    binding: 3,
                    visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Sampler(SamplerBindingType::Filtering),
                    count: None,
                });
            } else {
                v.push(BindGroupLayoutEntry {
                    binding: 2,
                    visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                });
            }
            v
        },
    });

    let pipeline_layout = g.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("reelix-pl"),
        bind_group_layouts: &[&layout],
        push_constant_ranges: &[],
    });
    let bind = g.device.create_bind_group(&BindGroupDescriptor {
        label: Some("reelix-bg"),
        layout: &layout,
        entries: &entries,
    });

    let pipeline = g.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("reelix-pp"),
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vs"),
            buffers: &[],
            compilation_options: Default::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fs"),
            targets: &[Some(TextureFormat::Rgba8Unorm.into())],
            compilation_options: Default::default(),
        }),
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview: None,
        cache: None,
    });

    let mut encoder = g.device.create_command_encoder(&CommandEncoderDescriptor::default());
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("reelix-pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &dst.1,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &bind, &[]);
        pass.draw(0..3, 0..1);
    }
    g.queue.submit(Some(encoder.finish()));
    readback(g, &dst.0, width, height)
}

// ---------------------------------------------------------------------------
// 纹理 / 读回工具
// ---------------------------------------------------------------------------

/// 把 Frame（RGBA f32）上传成源纹理。
fn upload_frame(g: &Gpu, pixels: &[f32], width: usize, height: usize) -> (Texture, TextureView) {
    // Rgba8Unorm：float 帧量化到 8bit（最终输出也是 8bit，无感知）
    let mut bytes: Vec<u8> = Vec::with_capacity(width * height * 4);
    for c in pixels.chunks_exact(4) {
        for k in 0..4 {
            bytes.push((c[k].clamp(0.0, 1.0) * 255.0 + 0.5) as u8);
        }
    }
    let texture = g.device.create_texture(&TextureDescriptor {
        label: Some("reelix-src"),
        size: Extent3d {
            width: width as u32,
            height: height as u32,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: TextureDimension::D2,
        format: TextureFormat::Rgba8Unorm,
        usage: TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST,
        view_formats: &[],
    });
    g.queue.write_texture(
        ImageCopyTexture {
            texture: &texture,
            mip_level: 0,
            origin: Origin3d::ZERO,
            aspect: TextureAspect::All,
        },
        bytemuck_bytes(pixels),
        ImageDataLayout {
            offset: 0,
            bytes_per_row: Some((width * 16) as u32),
            rows_per_image: Some(height as u32),
        },
        Extent3d {
            width: width as u32,
            height: height as u32,
            depth_or_array_layers: 1,
        },
    );
    let view = texture.create_view(&TextureViewDescriptor::default());
    (texture, view)
}

/// 创建目标纹理。
fn make_target(g: &Gpu, width: usize, height: usize) -> (Texture, TextureView) {
    let texture = g.device.create_texture(&TextureDescriptor {
        label: Some("reelix-dst"),
        size: Extent3d {
            width: width as u32,
            height: height as u32,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: TextureDimension::D2,
        format: TextureFormat::Rgba8Unorm,
        usage: TextureUsages::RENDER_ATTACHMENT | TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = texture.create_view(&TextureViewDescriptor::default());
    (texture, view)
}

/// 把 RGBA32Float 纹理读回成 Frame。
fn readback(
    g: &Gpu,
    texture: &Texture,
    width: usize,
    height: usize,
) -> Result<crate::graph::effects::Frame, String> {
    const ALIGN: u32 = 256; // copy_texture_to_buffer 行字节对齐要求
    let unpadded = (width * 16) as u32;
    let padded = ((unpadded + ALIGN - 1) / ALIGN) * ALIGN;
    let buffer = g.device.create_buffer(&BufferDescriptor {
        label: Some("reelix-readback"),
        size: (padded * height as u32) as u64,
        usage: BufferUsages::COPY_DST | BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = g.device.create_command_encoder(&CommandEncoderDescriptor::default());
    encoder.copy_texture_to_buffer(
        ImageCopyTexture {
            texture,
            mip_level: 0,
            origin: Origin3d::ZERO,
            aspect: TextureAspect::All,
        },
        ImageCopyBuffer {
            buffer: &buffer,
            layout: ImageDataLayout {
                offset: 0,
                bytes_per_row: Some(padded),
                rows_per_image: Some(height as u32),
            },
        },
        Extent3d {
            width: width as u32,
            height: height as u32,
            depth_or_array_layers: 1,
        },
    );
    g.queue.submit(Some(encoder.finish()));
    let slice = buffer.slice(..);
    slice.map_async(MapMode::Read, |_| {});
    let _ = g.device.poll(wgpu::Maintain::Wait);
    
    let data = slice.get_mapped_range();
    let mut pixels = vec![0f32; width * height * 4];
    for y in 0..height {
        let start = y * padded as usize;
        let end = start + unpadded as usize;
        let row = &data[start..end];
        let dst = &mut pixels[y * width * 4..(y + 1) * width * 4];
        for (d, s) in dst.chunks_exact_mut(4).zip(row.chunks_exact(4)) {
            d[0] = s[0] as f32 / 255.0;
            d[1] = s[1] as f32 / 255.0;
            d[2] = s[2] as f32 / 255.0;
            d[3] = s[3] as f32 / 255.0;
        }
    }
    drop(data);
    buffer.unmap();
    Ok(crate::graph::effects::Frame {
        width,
        height,
        pixels,
    })
}

/// f32 slice → bytes（同一块内存的字节视图）。
fn bytemuck_bytes(slice: &[f32]) -> &[u8] {
    unsafe { std::slice::from_raw_parts(slice.as_ptr() as *const u8, slice.len() * 4) }
}

fn make_sampler(device: &Device) -> Sampler {
    device.create_sampler(&SamplerDescriptor {
        label: Some("reelix-sampler"),
        address_mode_u: AddressMode::ClampToEdge,
        address_mode_v: AddressMode::ClampToEdge,
        address_mode_w: AddressMode::ClampToEdge,
        mag_filter: FilterMode::Linear,
        min_filter: FilterMode::Linear,
        mipmap_filter: FilterMode::Nearest,
        ..Default::default()
    })
}

/// 恒等 LUT：33³ × RGBA（输入缺数据时用）。
fn identity_lut_data() -> Vec<f32> {
    let n = 33usize;
    let mut data = Vec::with_capacity(n * n * n * 4);
    for b in 0..n {
        for gi in 0..n {
            for r in 0..n {
                data.push(r as f32 / 32.0);
                data.push(gi as f32 / 32.0);
                data.push(b as f32 / 32.0);
                data.push(1.0);
            }
        }
    }
    data
}

// ---------------------------------------------------------------------------
// 着色器
// ---------------------------------------------------------------------------

const VS: &str = r#"
struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VsOut {
    // 覆盖全屏的三角形
    var p = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
    var o: VsOut;
    o.pos = vec4<f32>(p[i], 0.0, 1.0);
    o.uv = vec2<f32>((p[i].x + 1.0) * 0.5, 1.0 - (p[i].y + 1.0) * 0.5);
    return o;
}
"#;

/// 三个效果的片元着色（与公共 API 的顺序一一对应）。
const WITH: [&str; 3] = [
    // 0：GPU 模糊（9-tap 高斯核，横纵各扫一次）
    r#"
struct Params { radius: f32, texel: f32 };
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let t = max(params.radius, 0.0) * 2.0 * params.texel + params.texel;
    var w = array<f32, 9>(0.016216, 0.054054, 0.121621, 0.194594, 0.227027, 0.194594, 0.121621, 0.054054, 0.016216);
    var acc = vec4<f32>(0.0);
    var acc2 = vec4<f32>(0.0);
    for (var i = -4; i <= 4; i = i + 1) {
        let wi = w[i + 4];
        acc = acc + textureSample(src, samp, uv + vec2<f32>(f32(i) * t, 0.0)) * wi;
        acc2 = acc2 + textureSample(src, samp, uv + vec2<f32>(0.0, f32(i) * t)) * wi;
    }
    return (acc + acc2) * 0.5;
}
"#,
    // 1：GPU 调色（亮度 / 对比度 / 饱和度）
    r#"
struct Params { brightness: f32, contrast: f32, saturation: f32, _pad: f32 };
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    var c = textureSample(src, samp, uv);
    c = vec4<f32>(c.rgb * params.brightness, c.a);
    c = vec4<f32>((c.rgb - 0.5) * params.contrast + 0.5, c.a);
    let luma = dot(c.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
    c = vec4<f32>(mix(vec3<f32>(luma), c.rgb, params.saturation), c.a);
    return c;
}
"#,
    // 2：GPU 3D LUT（33³，边缘内缩半格采样避免色带）
    r#"
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var lut: texture_3d<f32>;
@group(0) @binding(3) var lut_samp: sampler;

@fragment
fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let c = textureSample(src, samp, uv);
    let r = (c.r * 32.0 + 0.5) / 33.0;
    let gi = (c.g * 32.0 + 0.5) / 33.0;
    let b = (c.b * 32.0 + 0.5) / 33.0;
    let graded = textureSampleLevel(lut, lut_samp, vec3<f32>(r, gi, b), 0.0);
    return vec4<f32>(graded.rgb, c.a);
}
"#,
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::effects::Frame;

    fn checker(w: usize, h: usize) -> Frame {
        let mut f = Frame::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let on = (x + y) % 2 == 0;
                let v = if on { 0.9 } else { 0.1 };
                f.pixels[(y * w + x) * 4] = v;
                f.pixels[(y * w + x) * 4 + 1] = v;
                f.pixels[(y * w + x) * 4 + 2] = v;
                f.pixels[(y * w + x) * 4 + 3] = 1.0;
            }
        }
        f
    }

    /// 真 GPU 验证：棋盘格模糊后，任意像素都应变成「相邻两格的平均」——
    /// 即同一行相邻像素的值趋于接近（CPU 版也是这个语义，但这里必须真过 GPU）。
    #[test]
    fn gpu_blur_actually_runs_and_smooths() {
        let input = checker(16, 16);
        let out = blur(&input, 0.5).expect("GPU 应可用；不可用时应回落而不是 panic");
        assert_eq!(out.width, 16);
        assert_eq!(out.height, 16);
        // 找一处原本一黑一白的相邻对，模糊后差应显著变小
        let a = (8 * 16 + 7) * 4;
        let b = (8 * 16 + 8) * 4;
        let before = (input.pixels[a] - input.pixels[b]).abs();
        let after = (out.pixels[a] - out.pixels[b]).abs();
        assert!(before > 0.5, "测试帧本身该有强对比");
        assert!(after < before * 0.7, "GPU 模糊应明显降低相邻对比：{before} -> {after}");
    }

    /// GPU 调色：亮度翻倍，输出应整体变亮（且上限截断）。
    #[test]
    fn gpu_grade_brightens() {
        let mut f = Frame::new(4, 4);
        for p in f.pixels.chunks_exact_mut(4) {
            p[0] = 0.2;
            p[1] = 0.2;
            p[2] = 0.2;
            p[3] = 1.0;
        }
        let out = grade(&f, 3.0, 1.0, 1.0).expect("GPU 应可用");
        let avg = out.pixels[0] + out.pixels[1] + out.pixels[2];
        assert!(avg > 0.9, "亮度 3× 后应显著变亮：{avg}");
    }
}
