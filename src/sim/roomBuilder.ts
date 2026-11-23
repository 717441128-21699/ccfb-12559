import type { ScenarioDef, SimObject, ShellSurfaceId, Vec3 } from '../core/types';
import { KELVIN } from '../core/math';

let seq = 0;
const nid = (p: string) => `${p}-${(seq++).toString(36)}`;

interface WallSpec {
  center: Vec3;
  size: Vec3;
  yaw?: number;
  materialId?: string;
  shell: ShellSurfaceId;
  rect: [number, number, number, number];
}

/**
 * 生成房间外壳（四面墙 + 地板 + 天花板），并把每面墙在所属外壳热纹理上的
 * UV 矩形一并写入 shellRect，供 GPU 墙面热扩散寻址。
 */
export function buildRoomShell(room: Vec3, wallMat = 'concrete'): SimObject[] {
  seq = 0;
  const [W, H, D] = room;
  const t = 0.15;
  const specs: WallSpec[] = [
    { center: [0, -t / 2, 0], size: [W, t, D], shell: 'floor', rect: [0, 0, 1, 1] },
    { center: [0, H + t / 2, 0], size: [W, t, D], shell: 'ceiling', rect: [0, 0, 1, 1] },
    { center: [W / 2 + t / 2, H / 2, 0], size: [t, H, D], shell: 'wall0', rect: [0, 0, 1, 1] },
    { center: [-W / 2 - t / 2, H / 2, 0], size: [t, H, D], shell: 'wall1', rect: [0, 0, 1, 1] },
    { center: [0, H / 2, D / 2 + t / 2], size: [W, H, t], shell: 'wall2', rect: [0, 0, 1, 1] },
    { center: [0, H / 2, -D / 2 - t / 2], size: [W, H, t], shell: 'wall3', rect: [0, 0, 1, 1] },
  ];
  return specs.map((s) => ({
    id: nid('shell'),
    label: `围护结构-${s.shell}`,
    kind: 'box' as const,
    position: s.center,
    size: s.size,
    yaw: 0,
    materialId: wallMat,
    temperature: 20 + KELVIN,
    isWall: true,
    shellSurface: s.shell,
    shellRect: s.rect,
  }));
}

export function box(
  label: string, center: Vec3, size: Vec3, materialId: string, yaw = 0,
): SimObject {
  return {
    id: nid('obj'), label, kind: 'box', position: center, size, yaw,
    materialId, temperature: 20 + KELVIN, isWall: false,
  };
}

export function cylinder(
  label: string, center: Vec3, diameter: number, height: number, materialId: string,
): SimObject {
  return {
    id: nid('obj'), label, kind: 'cylinder',
    position: center, size: [diameter, height, diameter], yaw: 0,
    materialId, temperature: 20 + KELVIN, isWall: false,
  };
}

/** 隔墙（参与 GPU 热扩散，归属最近的墙纹理） */
export function partition(
  label: string, center: Vec3, size: Vec3, shell: ShellSurfaceId,
  rect: [number, number, number, number], yaw = 0,
): SimObject {
  return {
    id: nid('part'), label, kind: 'box', position: center, size, yaw,
    materialId: 'drywall', temperature: 20 + KELVIN, isWall: true,
    shellSurface: shell, shellRect: rect,
  };
}

/** 把场景深拷贝（重置训练时恢复脚本状态用） */
export function cloneScenario(s: ScenarioDef): ScenarioDef {
  return JSON.parse(JSON.stringify(s)) as ScenarioDef;
}
