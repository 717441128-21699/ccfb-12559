import type { MaterialDef, SimObject, Vec3 } from '../core/types';
import { MATERIALS } from './materials';
import { v3 } from '../core/math';

/**
 * 交叉存储的静态网格：pos(3) + normal(3) + uv(2) + materialSlot(1) = 9 float/顶点
 * 所有位置在生成时烘焙进世界坐标，渲染时直接用 VP 矩阵，避免逐物体 uniform 管理。
 */
export interface Mesh {
  vertices: Float32Array;
  indices: Uint32Array;
  materialSlot: number; // 单一材料物体的槽位（人形等复合网格忽略，用顶点内槽位）
  objectId: number;     // 对应 world.objects 下标
  isWall: boolean;
}

export const STRIDE = 9;

interface BoxFace {
  normal: Vec3;
  corners: [Vec3, Vec3, Vec3, Vec3]; // 逆时针（朝外）
}

function boxFaces(hs: Vec3): BoxFace[] {
  const [hx, hy, hz] = hs;
  return [
    { normal: [1, 0, 0], corners: [[hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz]] },
    { normal: [-1, 0, 0], corners: [[-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz], [-hx, -hy, -hz]] },
    { normal: [0, 1, 0], corners: [[-hx, hy, -hz], [-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz]] },
    { normal: [0, -1, 0], corners: [[-hx, -hy, hz], [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz]] },
    { normal: [0, 0, 1], corners: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
    { normal: [0, 0, -1], corners: [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]] },
  ];
}

function rotateY(p: Vec3, yaw: number): Vec3 {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
}

/** 生成单个盒子/圆柱网格（人形在 buildHumanoid 中复合） */
export function buildMesh(obj: SimObject, objectId: number, materialSlot: number): Mesh {
  const verts: number[] = [];
  const idx: number[] = [];
  const push = (p: Vec3, n: Vec3, uv: [number, number], slot = materialSlot) => {
    const wp = v3.add(rotateY(p, obj.yaw), obj.position);
    const wn = rotateY(n, obj.yaw);
    verts.push(wp[0], wp[1], wp[2], wn[0], wn[1], wn[2], uv[0], uv[1], slot);
  };
  if (obj.kind === 'box') {
    for (const face of boxFaces(v3.scale(obj.size, 0.5))) {
      const base = verts.length / STRIDE;
      const uvs: [number, number][] = [[0, 0], [0, 1], [1, 1], [1, 0]];
      face.corners.forEach((c, i) => push(c, face.normal, uvs[i]));
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  } else {
    // cylinder：obj.size = [直径, 高, 直径]
    const r = obj.size[0] / 2, h = obj.size[1] / 2, seg = 18;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const n0: Vec3 = [Math.cos(a0), 0, Math.sin(a0)];
      const n1: Vec3 = [Math.cos(a1), 0, Math.sin(a1)];
      const base = verts.length / STRIDE;
      push([r * n0[0], -h, r * n0[2]], n0, [i / seg, 0]);
      push([r * n0[0], h, r * n0[2]], n0, [i / seg, 1]);
      push([r * n1[0], h, r * n1[2]], n1, [(i + 1) / seg, 1]);
      push([r * n1[0], -h, r * n1[2]], n1, [(i + 1) / seg, 0]);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    // 顶盖/底盖
    for (const [top, nn] of [[true, [0, 1, 0]], [false, [0, -1, 0]]] as [boolean, Vec3][]) {
      const center = verts.length / STRIDE;
      push([0, top ? h : -h, 0], nn, [0.5, 0.5]);
      const ring: number[] = [];
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        ring.push(verts.length / STRIDE);
        push([r * Math.cos(a), top ? h : -h, r * Math.sin(a)], nn,
          [0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)]);
      }
      for (let i = 0; i < seg; i++) {
        if (top) idx.push(center, ring[i + 1], ring[i]);
        else idx.push(center, ring[i], ring[i + 1]);
      }
    }
  }
  return {
    vertices: new Float32Array(verts),
    indices: new Uint32Array(idx),
    materialSlot,
    objectId,
    isWall: obj.isWall,
  };
}

/** 人形：多盒子复合，逐顶点写入皮肤/衣物两个材料槽 */
export function buildHumanoid(
  obj: SimObject, objectId: number,
  skinSlot: number, clothSlot: number,
  exposedSkin: number,
): Mesh {
  const parts: { center: Vec3; size: Vec3; slot: number }[] = [];
  const lying = obj.size[1] < 1.2; // 简化：由包围盒高度判断姿态
  const add = (center: Vec3, size: Vec3, slot: number) => parts.push({ center, size, slot });
  if (lying) {
    // 躺姿：沿 z 轴铺开
    add([0, 0.15, -0.55], [0.45, 0.3, 0.75], clothSlot);      // 躯干
    add([0, 0.18, 0.02], [0.22, 0.24, 0.26], skinSlot);       // 头（暴露）
    add([0, 0.12, -1.15], [0.4, 0.24, 0.55], clothSlot);      // 腿
    add([0.28, 0.12, -0.5], [0.12, 0.12, 0.6], exposedSkin > 0.2 ? skinSlot : clothSlot); // 手臂
  } else {
    add([0, 1.05, 0], [0.42, 0.6, 0.26], clothSlot);          // 躯干
    add([0, 1.52, 0], [0.22, 0.24, 0.22], skinSlot);          // 头
    add([0, 0.42, 0], [0.36, 0.68, 0.26], clothSlot);         // 腿
    add([0.3, 1.05, 0], [0.12, 0.55, 0.12], exposedSkin > 0.25 ? skinSlot : clothSlot);  // 手臂
  }
  const verts: number[] = [];
  const indices: number[] = [];
  for (const part of parts) {
    const localObj: SimObject = {
      ...obj,
      kind: 'box',
      position: v3.add(obj.position, rotateY(part.center, obj.yaw)),
      size: part.size,
    };
    const m = buildMesh(localObj, objectId, part.slot);
    const base = verts.length / STRIDE;
    verts.push(...m.vertices);
    for (const i of m.indices) indices.push(i + base);
  }
  return {
    vertices: new Float32Array(verts),
    indices: new Uint32Array(indices),
    materialSlot: clothSlot,
    objectId,
    isWall: false,
  };
}

/** 收集场景中用到的材料，建立槽位表（顶点 attribute 只传整数槽位） */
export function buildMaterialTable(materialIds: string[]): { table: MaterialDef[]; slotOf: Map<string, number> } {
  const ordered = Array.from(new Set(materialIds));
  const table = ordered.map((id) => MATERIALS[id]);
  const slotOf = new Map(ordered.map((id, i) => [id, i]));
  return { table, slotOf };
}
