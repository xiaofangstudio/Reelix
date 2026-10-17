/**
 * 空间视图：COLMAP 稀疏点云与相机轨迹的三维预览。
 *
 * 坐标系换算只在这一处做：
 * - COLMAP 是右手系、y 轴向下，three.js 是 y 轴向上，所以显示时把 y 取反；
 * - 位姿是世界 → 相机（`X_cam = R · X_world + t`），相机中心 `C = -Rᵀ · t`；
 *   相机视锥的角点先按机体系算，再用 `Rᵀ · v + C` 搬回世界；
 * - 整场景按点云包围盒中心平移，绕原点转，OrbitControls 才不会把镜头甩飞。
 *
 * 颜色只用 Reelix 的浅绿系：点云保留素材原色，相机线框用灰绿，当前帧用主绿。
 */

import { useEffect, useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { CameraIntrinsics, CameraPose, SceneCamera } from "../types/camera";

/** 视锥线框的颜色，与 tokens.css 的浅绿系对齐 */
const FRAME_COLOR = "#8aa79a";
const ACTIVE_COLOR = "#26734f";
const GRID_CENTER = "#c6d3cc";
const GRID_LINE = "#e8efeb";

/** 场景级几何：整段点云与全部相机线框，只在解算结果变化时重建 */
interface SceneBase {
  points: Float32Array;
  pointColors: Float32Array;
  frustums: Float32Array;
  path: Float32Array;
  centerPoints: Float32Array;
  radius: number;
  pointSize: number;
  depth: number;
  /** 平移量：显示坐标减它即围绕原点 */
  origin: [number, number, number];
  intrinsics: Map<number, CameraIntrinsics>;
}

/** 两台相机之间连一条线，把轨迹画出来 */
function buildPath(centers: Array<[number, number, number]>, origin: [number, number, number]): Float32Array {
  if (centers.length < 2) return new Float32Array(0);
  const out = new Float32Array((centers.length - 1) * 6);
  for (let i = 0; i < centers.length - 1; i += 1) {
    const a = centers[i];
    const b = centers[i + 1];
    out[i * 6] = a[0] - origin[0];
    out[i * 6 + 1] = a[1] - origin[1];
    out[i * 6 + 2] = a[2] - origin[2];
    out[i * 6 + 3] = b[0] - origin[0];
    out[i * 6 + 4] = b[1] - origin[1];
    out[i * 6 + 5] = b[2] - origin[2];
  }
  return out;
}

/** 单帧视锥：顶点到四角 4 条 + 矩形 4 条，共 8 段 16 个点 */
function buildFrustum(
  pose: CameraPose,
  origin: [number, number, number],
  depth: number,
  intrinsics: Map<number, CameraIntrinsics>
): { positions: Float32Array; center: [number, number, number] } {
  const intr = intrinsics.get(pose.cameraId);
  // 视锥半宽 / 半高按内参算；内参缺失就退回一个常见画幅比例
  const halfW =
    intr && intr.fx > 1e-6 ? (depth * (intr.width / 2)) / intr.fx : depth * 0.62;
  const halfH =
    intr && intr.fy > 1e-6 ? (depth * (intr.height / 2)) / intr.fy : depth * 0.45;
  // 超广角可能算出比深度还宽的视锥，收一收免得挡住点云
  const w = Math.min(halfW, depth * 1.4);
  const h = Math.min(halfH, depth * 1.2);

  const [qw, qx, qy, qz] = pose.quaternion;
  const norm = Math.hypot(qw, qx, qy, qz) || 1;
  const nw = qw / norm;
  const nx = qx / norm;
  const ny = qy / norm;
  const nz = qz / norm;

  // 世界 → 相机的旋转矩阵（与后端 quat_to_rot 同一套公式）
  const r00 = 1 - 2 * (ny * ny + nz * nz);
  const r01 = 2 * (nx * ny - nw * nz);
  const r02 = 2 * (nx * nz + nw * ny);
  const r10 = 2 * (nx * ny + nw * nz);
  const r11 = 1 - 2 * (nx * nx + nz * nz);
  const r12 = 2 * (ny * nz - nw * nx);
  const r20 = 2 * (nx * nz - nw * ny);
  const r21 = 2 * (ny * nz + nw * nx);
  const r22 = 1 - 2 * (nx * nx + ny * ny);

  const [cx, cy, cz] = pose.center;
  // `Rᵀ · v + C`，再把 y 翻成向上、减去场景原点
  const toLocal = (vx: number, vy: number, vz: number): [number, number, number] => [
    r00 * vx + r10 * vy + r20 * vz + cx - origin[0],
    -(r01 * vx + r11 * vy + r21 * vz + cy) - origin[1],
    r02 * vx + r12 * vy + r22 * vz + cz - origin[2],
  ];

  const apex = toLocal(0, 0, 0);
  const corners = [
    toLocal(-w, -h, depth),
    toLocal(w, -h, depth),
    toLocal(w, h, depth),
    toLocal(-w, h, depth),
  ];

  const segments: Array<[number, number, number]> = [
    apex,
    corners[0],
    apex,
    corners[1],
    apex,
    corners[2],
    apex,
    corners[3],
    corners[0],
    corners[1],
    corners[1],
    corners[2],
    corners[2],
    corners[3],
    corners[3],
    corners[0],
  ];
  const positions = new Float32Array(segments.length * 3);
  segments.forEach((p, i) => {
    positions[i * 3] = p[0];
    positions[i * 3 + 1] = p[1];
    positions[i * 3 + 2] = p[2];
  });
  return { positions, center: apex };
}

/** 把一次解算结果摊平成渲染用的缓冲，顺序与包围盒只算一遍 */
function prepareScene(scene: SceneCamera): SceneBase {
  const intrinsics = new Map<number, CameraIntrinsics>();
  for (const camera of scene.cameras) intrinsics.set(camera.cameraId, camera);

  const count = scene.points.length;
  const raw = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  const grow = (x: number, y: number, z: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  };

  for (let i = 0; i < count; i += 1) {
    const p = scene.points[i];
    // COLMAP 的 y 向下，显示时取反
    const x = p.x;
    const y = -p.y;
    const z = p.z;
    raw[i * 3] = x;
    raw[i * 3 + 1] = y;
    raw[i * 3 + 2] = z;
    colors[i * 3] = p.r / 255;
    colors[i * 3 + 1] = p.g / 255;
    colors[i * 3 + 2] = p.b / 255;
    grow(x, y, z);
  }

  // 相机中心也要纳入包围盒：点云稀疏时，轨迹可能比点更靠外
  const centers: Array<[number, number, number]> = scene.poses.map((pose) => {
    const p: [number, number, number] = [pose.center[0], -pose.center[1], pose.center[2]];
    grow(p[0], p[1], p[2]);
    return p;
  });

  // 全空场景给一个单位尺度，免得相机与网格算出 NaN
  if (!Number.isFinite(minX)) {
    minX = -1;
    maxX = 1;
    minY = -1;
    maxY = 1;
    minZ = -1;
    maxZ = 1;
  }

  const origin: [number, number, number] = [
    (minX + maxX) / 2,
    (minY + maxY) / 2,
    (minZ + maxZ) / 2,
  ];
  const radius = Math.max(
    0.001,
    Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2
  );

  for (let i = 0; i < count; i += 1) {
    raw[i * 3] -= origin[0];
    raw[i * 3 + 1] -= origin[1];
    raw[i * 3 + 2] -= origin[2];
  }

  const depth = radius * 0.16;
  const frustums = new Float32Array(scene.poses.length * 48);
  scene.poses.forEach((pose, index) => {
    const { positions } = buildFrustum(pose, origin, depth, intrinsics);
    frustums.set(positions, index * 48);
  });

  const centerPoints = new Float32Array(centers.length * 3);
  centers.forEach((p, i) => {
    centerPoints[i * 3] = p[0] - origin[0];
    centerPoints[i * 3 + 1] = p[1] - origin[1];
    centerPoints[i * 3 + 2] = p[2] - origin[2];
  });

  return {
    points: raw,
    pointColors: colors,
    frustums,
    path: buildPath(centers, origin),
    centerPoints,
    radius,
    pointSize: Math.max(radius * 0.0035, 0.001),
    depth,
    origin,
    intrinsics,
  };
}

/** 点云 + 全部视锥 + 轨迹：几何只在解算结果变化时重建，拖动相机时不动 */
function SceneContent({ base }: { base: SceneBase }) {
  const pointGeom = useMemo(() => {
    if (base.points.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(base.points, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(base.pointColors, 3));
    geometry.computeBoundingSphere();
    return geometry;
  }, [base]);

  const frustumGeom = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(base.frustums, 3));
    return geometry;
  }, [base]);

  const pathGeom = useMemo(() => {
    if (base.path.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(base.path, 3));
    return geometry;
  }, [base]);

  const centerGeom = useMemo(() => {
    if (base.centerPoints.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(base.centerPoints, 3));
    return geometry;
  }, [base]);

  useEffect(
    () => () => {
      pointGeom?.dispose();
      frustumGeom.dispose();
      pathGeom?.dispose();
      centerGeom?.dispose();
    },
    [pointGeom, frustumGeom, pathGeom, centerGeom]
  );

  return (
    <>
      {pointGeom && (
        <points geometry={pointGeom} frustumCulled={false}>
          <pointsMaterial
            vertexColors
            size={base.pointSize}
            sizeAttenuation
            depthWrite={false}
          />
        </points>
      )}

      <lineSegments geometry={frustumGeom}>
        <lineBasicMaterial color={FRAME_COLOR} transparent opacity={0.55} />
      </lineSegments>

      {pathGeom && (
        <lineSegments geometry={pathGeom}>
          <lineBasicMaterial color={FRAME_COLOR} transparent opacity={0.9} />
        </lineSegments>
      )}

      {centerGeom && (
        <points geometry={centerGeom} frustumCulled={false}>
          <pointsMaterial color={ACTIVE_COLOR} size={3.5} sizeAttenuation={false} />
        </points>
      )}

      <gridHelper
        args={[base.radius * 4, 24, GRID_CENTER, GRID_LINE]}
        position={[0, -base.radius * 0.9, 0]}
      />
      <axesHelper args={[base.radius * 0.45]} />
    </>
  );
}

/** 当前帧的视锥单独一层，播放头动的时候只换这一组线 */
function ActivePose({
  scene,
  base,
  index,
}: {
  scene: SceneCamera;
  base: SceneBase;
  index: number;
}) {
  const pose = scene.poses[index] ?? null;

  const geometry = useMemo(() => {
    if (!pose) return null;
    const { positions } = buildFrustum(pose, base.origin, base.depth, base.intrinsics);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return g;
  }, [pose, base]);

  useEffect(() => () => geometry?.dispose(), [geometry]);

  if (!pose || !geometry) return null;
  const [x, y, z] = pose.center;
  const position: [number, number, number] = [
    x - base.origin[0],
    -y - base.origin[1],
    z - base.origin[2],
  ];

  return (
    <>
      <lineSegments geometry={geometry}>
        <lineBasicMaterial color={ACTIVE_COLOR} />
      </lineSegments>
      <mesh position={position}>
        <sphereGeometry args={[Math.max(base.radius * 0.012, 0.004), 16, 16]} />
        <meshBasicMaterial color={ACTIVE_COLOR} />
      </mesh>
    </>
  );
}

interface SpaceViewProps {
  scene: SceneCamera;
  /** 当前高亮的相机帧下标 */
  activePose: number;
}

/** 三维视图本体：r3f 画布 + 轨道控制，尺寸交给外层容器 */
export function SpaceView({ scene, activePose }: SpaceViewProps) {
  const base = useMemo(() => prepareScene(scene), [scene]);
  // 换一次解算结果就重建相机，视角按新场景的尺度从头摆
  const viewKey = `${scene.workspace}:${scene.createdAt}`;

  return (
    <Canvas
      key={viewKey}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true }}
      camera={{
        position: [base.radius * 1.5, base.radius * 1.15, base.radius * 1.5],
        fov: 45,
        near: Math.max(base.radius * 0.002, 0.0001),
        far: base.radius * 80,
      }}
    >
      <SceneContent base={base} />
      <ActivePose scene={scene} base={base} index={activePose} />
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.1}
        minDistance={base.radius * 0.05}
        maxDistance={base.radius * 30}
      />
    </Canvas>
  );
}
