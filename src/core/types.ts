import type { Vec3 } from './math';
export type { Vec3 } from './math';

/** 表面材料：决定发射率、导热率、热容等红外/热物理属性 */
export interface MaterialDef {
  id: string;
  name: string;
  emissivity: number;   // 长波红外发射率 0~1（1-ε 即反射率，玻璃/金属低 ε 产生假热点）
  conductivity: number; // 导热系数 W/(m·K)
  density: number;      // kg/m³
  specificHeat: number; // J/(kg·K)
  /** 漫/镜反射倾向：0 漫反射，1 镜面反射（玻璃、抛光金属接近 1） */
  metallic: number;
  /** 玻璃等对 LWIR 近似不透明但有透射分量；目前全部作不透明处理，保留字段 */
  lwTransmittance: number;
}

export type ShapeKind = 'box' | 'cylinder' | 'humanoid';

export interface SimObject {
  id: string;
  label: string;
  kind: ShapeKind;
  position: Vec3;          // 中心位置
  size: Vec3;              // box: 全尺寸；cylinder: [直径, 高, 直径]
  yaw: number;
  materialId: string;
  /** 运行时：集总热容温度（K），物体内部近似等温 */
  temperature: number;
  /** 是否为房间外壳/隔墙（参与 GPU 墙面热扩散），普通家具为集总物体 */
  isWall: boolean;
  /** 墙面所属外壳面（floor/ceiling/wallN…），仅 isWall 使用 */
  shellSurface?: ShellSurfaceId;
  /** 墙面在该外壳面纹理上的矩形覆盖区 [u0,v0,u1,v1] */
  shellRect?: [number, number, number, number];
  /** 人类对象用 */
  isVictim?: boolean;
}

export type ShellSurfaceId = 'floor' | 'ceiling' | 'wall0' | 'wall1' | 'wall2' | 'wall3';

export interface FireDef {
  id: string;
  /** 火源中心（贴地） */
  position: Vec3;
  /** t² 火增长类型 */
  growth: 'slow' | 'medium' | 'fast';
  /** 峰值热释放速率 kW（通风受限前） */
  peakHRR: number;
  /** 达到峰值的时间 s（脚本化发展用，缺省按 t² 推） */
  peakTime?: number;
  /** 衰减开始时间 s（燃料耗尽），不填则不衰减 */
  decayStart?: number;
  /** 初始是否已点燃；未点燃的火源由蔓延事件点燃 */
  ignited: boolean;
  ignitionTime?: number;
  /** 火焰可见半径 m */
  radius: number;
}

export interface VictimDef {
  id: string;
  name: string;
  position: Vec3;
  /** 躺 / 坐 / 站 */
  pose: 'lying' | 'sitting' | 'standing';
  /** 核心体温 K */
  coreTemp: number;
  /** 外层衣物温度 K（热像仪实际看到的表面） */
  surfaceTemp: number;
  /** 暴露皮肤区域比例 0~1（脸部/手部等 ~310K 的高温斑） */
  exposedSkin: number;
  found: boolean;
  foundAt?: number;
}

export interface MistEmitter {
  id: string;
  position: Vec3;
  direction: Vec3;
  /** 喷雾速率 0~1（队员水枪） */
  rate: number;
}

/** 双区烟气层（two-zone model）：界面高度 interfaceHeight 以上为热气层 */
export interface SmokeState {
  /** 烟气层界面高度 m（从地面算起），随时间下降 */
  interfaceHeight: number;
  /** 上层烟气温度 K */
  upperTemp: number;
  /** 下层空气温度 K */
  lowerTemp: number;
  /** 上层烟颗粒光学厚度系数（对 LWIR 较弱：薄烟可穿透） */
  upperOpticalDensity: number;
  /** 下层卷入的薄烟光学厚度 */
  lowerOpticalDensity: number;
  /** 水雾在空间中的占位（球），对 LWIR 强遮挡 */
  mists: { position: Vec3; radius: number; density: number }[];
}

export interface ScenarioDef {
  id: string;
  name: string;
  description: string;
  /** 房间内净尺寸 [x, y(高), z] */
  roomSize: Vec3;
  ambientC: number;
  objects: SimObject[];
  fires: FireDef[];
  victims: VictimDef[];
  mists: MistEmitter[];
  /** 队员出生点与朝向 */
  spawn: { position: Vec3; yaw: number };
  /** 蔓延/轰燃等脚本事件：{time, type, payload} */
  events: ScenarioEvent[];
}

export interface ScenarioEvent {
  time: number;
  type: 'ignite' | 'flashover' | 'vent' | 'hint';
  targetId?: string;
  text?: string;
}

/** 热像仪设置（对应真实 TIC 面板） */
export interface TicSettings {
  palette: 'iron' | 'whitehot';
  /** auto=自动增益（连续自适应）；locked=锁定量程 */
  gainMode: 'auto' | 'locked';
  /** 锁定量程的下限/上限（K） */
  lockedMin: number;
  lockedMax: number;
  /** 自动增益灵敏度：越小越敏感（直方图取分位宽度系数） */
  agcSensitivity: number;
  /** 传感器噪声幅度 K（等效噪声温差） */
  noiseLevel: number;
  /** 视场角（度，竖直） */
  fovY: number;
  /** 反射立方体贴图刷新间隔（帧），0=每帧 */
  reflectionInterval: number;
  /** 渲染分辨率缩放（性能兜底，保证 30fps） */
  renderScale: number;
}

export interface FireRuntime {
  def: FireDef;
  hrr: number;          // 当前热释放速率 kW
  flameTemp: number;    // 火焰温度 K
  flameHeight: number;  // m
  /** 每 tick 由该火源注入烟气层的能量与质量 */
}

export interface ShellSnapshot {
  surface: ShellSurfaceId;
  data: Float32Array; // 温度纹理 RG32F 展平（R=温度，G=0）
  width: number;
  height: number;
}

/** 一帧世界状态（回放快照用） */
export interface WorldSnapshot {
  time: number;
  smoke: SmokeState;
  objectTemps: Record<string, number>;
  victimTemps: { surface: number; core: number }[];
  fires: { hrr: number; flameTemp: number; flameHeight: number; ignited: boolean }[];
  shell: ShellSnapshot[];
  camera: { position: Vec3; yaw: number; pitch: number };
  foundVictimIds: string[];
  events: { time: number; text: string }[];
}
