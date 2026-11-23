import type {
  FireDef, FireRuntime, ScenarioDef, SimObject, SmokeState, VictimDef, WorldSnapshot,
  ShellSurfaceId, ScenarioEvent,
} from '../core/types';
import { KELVIN, clamp, v3, type Vec3 } from '../core/math';
import { MATERIALS } from './materials';

const STEFAN = 5.67e-8;
const DT = 0.1;                 // 固定物理步长 10Hz（确定性回放基础）
const GRAVITY_FIRE = 1;

// t² 火增长系数 kW/s²（NFPA 分类）
const T2_ALPHA: Record<FireDef['growth'], number> = {
  slow: 0.00293,   // 达到 1MW 约 584s
  medium: 0.01172, // 约 292s
  fast: 0.04688,   // 约 146s
};

export interface FireRadiationInfo {
  position: [number, number, number];
  radius: number;
  flameHeight: number;
  hrr: number;
  flameTemp: number;
}

/** 墙面 GPU 热扩散所需的每帧驱动数据 */
export interface HeatDriver {
  fires: FireRadiationInfo[];
  smoke: SmokeState;
}

export class PhysicsWorld {
  readonly scenario: ScenarioDef;
  time = 0;
  smoke!: SmokeState;
  fires: FireRuntime[] = [];
  /** 已触发的脚本事件 */
  firedEvents: ScenarioEvent[] = [];
  /** 事件日志（含提示文本，供复盘时间线） */
  eventLog: { time: number; text: string }[] = [];
  /** 每个火源对各物体的视线遮挡缓存（每 tick 重算） */
  private losBlock: boolean[][] = [];

  constructor(scenario: ScenarioDef) {
    this.scenario = scenario;
    this.reset();
  }

  reset() {
    this.time = 0;
    const amb = this.scenario.ambientC + KELVIN;
    this.smoke = {
      interfaceHeight: this.scenario.roomSize[1], // 初始烟气层界面在天花板
      upperTemp: amb,
      lowerTemp: amb,
      upperOpticalDensity: 0,
      lowerOpticalDensity: 0,
      mists: [],
    };
    this.fires = this.scenario.fires.map((def) => ({
      def, hrr: 0, flameTemp: amb, flameHeight: 0,
    }));
    this.firedEvents = [];
    this.eventLog = [];
    for (const o of this.scenario.objects) o.temperature = amb;
    for (const v of this.scenario.victims) {
      v.found = false;
      v.foundAt = undefined;
      v.surfaceTemp = v.surfaceTemp || 306;
      v.coreTemp = v.coreTemp || 310;
    }
    this.losBlock = this.fires.map(() => this.scenario.objects.map(() => false));
  }

  get ambientK() { return this.scenario.ambientC + KELVIN; }
  get objects() { return this.scenario.objects; }
  get victims() { return this.scenario.victims; }
  get totalHRR() { return this.fires.reduce((s, f) => s + f.hrr, 0); }

  /** 确定性 hash 噪声（回放一致） */
  private noise(seed: number): number {
    const x = Math.sin(seed * 12.9898 + this.time * 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  // ---------------------------------------------------------------- 火源
  private updateFire(f: FireRuntime) {
    const d = f.def;
    const burning = d.ignited && (d.ignitionTime === undefined || this.time >= d.ignitionTime);
    if (!burning) {
      f.hrr = 0; f.flameHeight = 0; f.flameTemp = this.ambientK;
      return;
    }
    const tBurn = this.time - (d.ignitionTime ?? 0);
    const alpha = T2_ALPHA[d.growth];
    const tPeak = d.peakTime ?? Math.sqrt(d.peakHRR / alpha);
    let hrr: number;
    if (tBurn <= 0) hrr = 0;
    else if (tBurn < tPeak) hrr = Math.min(alpha * tBurn * tBurn, d.peakHRR);
    else if (d.decayStart === undefined || this.time < d.decayStart) hrr = d.peakHRR;
    else {
      // 线性衰减：decayStart 后 120s 耗尽
      const k = clamp(1 - (this.time - d.decayStart) / 120, 0, 1);
      hrr = d.peakHRR * k;
    }
    f.hrr = hrr;
    if (hrr > 1) {
      // Heskestad 火焰高度：L = 0.235·Q^(2/5) - 1.02·D（Q 单位 kW）
      f.flameHeight = Math.max(0.15, 0.235 * Math.pow(hrr, 0.4) - 1.02 * d.radius * 2);
      // 火焰温度随 HRR 趋于 ~1200K，小火焰偏低；加入确定性闪烁
      const flicker = 1 + 0.08 * (this.noise(parseInt(d.id.replace(/\D/g, '') || '1', 10)) - 0.5);
      f.flameTemp = (700 + 450 * (1 - Math.exp(-hrr / 600))) * flicker;
    } else {
      f.flameHeight = 0;
      f.flameTemp = this.ambientK;
    }
  }

  // ---------------------------------------------------------------- 烟气层
  private updateSmoke() {
    const [, H, ,] = this.scenario.roomSize;
    const area = this.scenario.roomSize[0] * this.scenario.roomSize[2];
    const totalQ = Math.max(0, this.totalHRR);
    const s = this.smoke;

    // 烟气质量生成（kg/s）：约 0.025 kg/s per kW 的羽流卷吸当量（工程简化）
    const smokeGen = totalQ * 0.018;
    // 上层体积增长 → 界面下降；上层温度高密度小，做体积当量换算
    const dV = smokeGen * DT * 0.9 / 1.18;
    const upperVol = Math.max(0.01, (H - s.interfaceHeight) * area + dV);
    s.interfaceHeight = clamp(H - upperVol / area, 0.35, H);

    // 上层能量平衡：火源功率约 60% 进入烟气（HRR 单位 kW → 乘 1000 换算焦耳）
    const upperMass = upperVol * 1.1;
    const dE = totalQ * 0.6 * DT * 1000; // J
    const cap = upperMass * 1005;        // J/K
    const loss = cap * (s.upperTemp - this.ambientK) * 0.0006 * DT;
    s.upperTemp += (dE - loss) / cap;
    s.upperTemp = clamp(s.upperTemp, this.ambientK, 873);

    // 下层缓慢升温（辐射与混合）
    s.lowerTemp += (s.upperTemp - s.lowerTemp) * 0.0008 * DT
      + (this.ambientK - s.lowerTemp) * 0.0002 * DT;

    // 光学厚度：随烟量积累，轰燃后显著增大；LWIR 穿透系数取可见光的 0.25
    const targetUpperOD = clamp(totalQ / 400 + (s.interfaceHeight < 1 ? 0.6 : 0), 0, 2.2);
    s.upperOpticalDensity += (targetUpperOD - s.upperOpticalDensity) * 0.05 * DT;
    s.lowerOpticalDensity += (s.upperOpticalDensity * 0.18 - s.lowerOpticalDensity) * 0.04 * DT;
  }

  // ---------------------------------------------------------------- 视线遮挡
  /** 火源中心到物体中心之间是否被其他墙面/大件挡住（粗粒度 AABB 测试） */
  private computeLOS() {
    const objs = this.scenario.objects;
    this.fires.forEach((f, fi) => {
      if (f.hrr <= 1) { this.losBlock[fi].fill(true); return; }
      const fp: Vec3 = [f.def.position[0], f.def.position[1] + f.flameHeight * 0.5, f.def.position[2]];
      objs.forEach((o, oi) => {
        this.losBlock[fi][oi] = this.segmentHitsOtherBox(fp, o.position, oi);
      });
    });
  }

  private segmentHitsOtherBox(a: Vec3, b: Vec3, selfIdx: number): boolean {
    for (let i = 0; i < this.scenario.objects.length; i++) {
      if (i === selfIdx) continue;
      const o = this.scenario.objects[i];
      if (!o.isWall && (o.size[0] * o.size[1] * o.size[2] < 0.4)) continue; // 小物件不挡辐射
      const c = o.position, h = v3.scale(o.size, 0.5);
      // 线段-AABB 相交（slab 法）
      let tmin = 0, tmax = 1;
      let hit = true;
      for (let k = 0; k < 3; k++) {
        const d = b[k] - a[k];
        if (Math.abs(d) < 1e-9) {
          if (a[k] < c[k] - h[k] || a[k] > c[k] + h[k]) { hit = false; break; }
        } else {
          let t1 = (c[k] - h[k] - a[k]) / d, t2 = (c[k] + h[k] - a[k]) / d;
          if (t1 > t2) [t1, t2] = [t2, t1];
          tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
          if (tmin > tmax) { hit = false; break; }
        }
      }
      if (hit && tmax > 0.05 && tmin < 0.95) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- 物体热平衡
  private updateObjects() {
    const s = this.smoke;
    this.fires.forEach((f, fi) => {
      if (f.hrr <= 1) return;
      const fp: Vec3 = [f.def.position[0], f.def.position[1] + f.flameHeight * 0.5, f.def.position[2]];
      this.scenario.objects.forEach((o, oi) => {
        const mat = MATERIALS[o.materialId];
        const V = o.size[0] * o.size[1] * o.size[2];
        const A = 2 * (o.size[0] * o.size[1] + o.size[1] * o.size[2] + o.size[0] * o.size[2]);
        const cap = Math.max(1, mat.density * V * mat.specificHeat); // J/K
        // 1) 烟气对流（浸没在上层/下层中）
        const gasT = o.position[1] + o.size[1] / 2 > s.interfaceHeight ? s.upperTemp : s.lowerTemp;
        const hConv = o.position[1] + o.size[1] / 2 > s.interfaceHeight ? 22 : 8;
        const qConv = hConv * A * (gasT - o.temperature) * DT;
        // 2) 火源辐射：点源模型 Q_rad/(4πr²)，视线不被遮挡
        let qRad = 0;
        if (!this.losBlock[fi][oi]) {
          const r = Math.max(0.6, v3.dist(fp, o.position));
          const flux = (f.hrr * 0.3 * 1000) / (4 * Math.PI * r * r); // W/m²
          qRad = mat.emissivity * flux * A * DT;
        }
        // 3) 热烟气辐射（上层物体）
        let qGasRad = 0;
        if (o.position[1] + o.size[1] / 2 > s.interfaceHeight) {
          qGasRad = mat.emissivity * STEFAN * (s.upperTemp ** 4 - o.temperature ** 4) * A * 0.5 * DT;
        }
        o.temperature += (qConv + qRad + qGasRad) / cap;
        o.temperature = clamp(o.temperature, this.ambientK - 2, 900);
      });
    });
    // 无火时向环境缓慢回落
    if (this.totalHRR < 1) {
      for (const o of this.scenario.objects) {
        const mat = MATERIALS[o.materialId];
        const tau = mat.density * mat.specificHeat * 0.02 / (8 * 4); // 简化时间常数
        o.temperature += (this.ambientK - o.temperature) * clamp(DT / Math.max(60, tau * 30), 0, 0.02);
      }
    }
  }

  // ---------------------------------------------------------------- 受害者
  private updateVictims() {
    const s = this.smoke;
    for (const v of this.scenario.victims) {
      // 衣物温度受环境气体影响，核心体温缓慢变化；吸入高温气体时核心上升
      const gasT = v.position[1] > s.interfaceHeight ? s.upperTemp : s.lowerTemp;
      v.surfaceTemp += (gasT - v.surfaceTemp) * 0.004 * DT;
      v.surfaceTemp = clamp(v.surfaceTemp, 296, 360);
      const heatStress = Math.max(0, gasT - 333) * 0.0009 * DT;
      v.coreTemp = clamp(v.coreTemp + heatStress - 0.0006 * DT, 308, 316);
    }
  }

  // ---------------------------------------------------------------- 水雾
  updateMists(rates: { id: string; rate: number }[]) {
    const s = this.smoke;
    for (const em of this.scenario.mists) {
      const live = rates.find((r) => r.id === em.id);
      const rate = live?.rate ?? 0;
      if (rate <= 0.01) continue;
      const tip = v3.add(em.position, v3.scale(em.direction, 1.2));
      // 圆锥喷雾：沿方向布 3 个衰减雾团
      for (let i = 0; i < 3; i++) {
        const p = v3.add(tip, v3.scale(em.direction, 0.7 + i * 0.8));
        const existing = s.mists.find((m) => v3.dist(m.position, p) < 1.0);
        if (existing) {
          existing.density = clamp(existing.density + rate * 0.25 * DT, 0, 1.6);
        } else {
          s.mists.push({ position: p, radius: 1.1 + i * 0.25, density: rate * 0.7 });
        }
      }
    }
    // 雾团蒸发/沉降衰减（典型水雾存活 20–40s），并冷却周围烟气
    for (const m of s.mists) {
      const before = m.density;
      m.density -= 0.025 * DT;
      if (m.position[1] > s.interfaceHeight) {
        s.upperTemp -= before * 220 * DT / Math.max(200, this.totalHRR + 50);
        s.upperTemp = Math.max(s.upperTemp, this.ambientK + 5);
      }
    }
    s.mists = s.mists.filter((m) => m.density > 0.02);
  }

  // ---------------------------------------------------------------- 脚本事件
  private updateEvents() {
    for (const ev of this.scenario.events) {
      if (this.firedEvents.includes(ev)) continue;
      if (this.time >= ev.time) {
        this.firedEvents.push(ev);
        if (ev.type === 'ignite' && ev.targetId) {
          const f = this.fires.find((x) => x.def.id === ev.targetId);
          if (f) { f.def.ignited = true; f.def.ignitionTime = this.time; }
        }
        if (ev.type === 'flashover') {
          // 轰燃：所有未燃料具进入充分燃烧，烟气层瞬间增强
          for (const f of this.fires) {
            if (!f.def.ignited) { f.def.ignited = true; f.def.ignitionTime = this.time; }
            f.def.peakHRR = Math.max(f.def.peakHRR, 2500);
          }
          this.smoke.upperTemp = Math.max(this.smoke.upperTemp, 773);
          this.smoke.upperOpticalDensity = Math.max(this.smoke.upperOpticalDensity, 1.8);
        }
        if (ev.type === 'vent') {
          // 通风：烟气层短时降温、界面回升
          this.smoke.upperTemp -= 60;
          this.smoke.interfaceHeight = Math.min(
            this.scenario.roomSize[1], this.smoke.interfaceHeight + 0.4);
        }
        this.eventLog.push({ time: this.time, text: ev.text ?? this.defaultEventText(ev) });
      }
    }
  }

  private defaultEventText(ev: ScenarioEvent): string {
    switch (ev.type) {
      case 'ignite': return '次级火源被引燃（火势蔓延）';
      case 'flashover': return '轰燃！房间进入全面燃烧';
      case 'vent': return '通风口开启，烟气层扰动';
      case 'hint': return ev.text ?? '训练提示';
    }
  }

  /** 推进一个固定步长 */
  step(mistRates: { id: string; rate: number }[] = []) {
    this.time += DT;
    this.updateEvents();
    for (const f of this.fires) this.updateFire(f);
    this.updateSmoke();
    this.computeLOS();
    this.updateObjects();
    this.updateVictims();
    this.updateMists(mistRates);
  }

  /** 供 GPU 墙面热扩散着色器使用的驱动数据 */
  heatDriver(): HeatDriver {
    return {
      fires: this.fires.filter((f) => f.hrr > 1).map((f) => ({
        position: f.def.position,
        radius: f.def.radius,
        flameHeight: f.flameHeight,
        hrr: f.hrr,
        flameTemp: f.flameTemp,
      })),
      smoke: this.smoke,
    };
  }

  // ---------------------------------------------------------------- 快照
  snapshot(camera: WorldSnapshot['camera'], shell: WorldSnapshot['shell']): WorldSnapshot {
    return {
      time: this.time,
      smoke: JSON.parse(JSON.stringify(this.smoke)),
      objectTemps: Object.fromEntries(this.objects.map((o) => [o.id, o.temperature])),
      victimTemps: this.victims.map((v) => ({ surface: v.surfaceTemp, core: v.coreTemp })),
      fires: this.fires.map((f) => ({
        hrr: f.hrr, flameTemp: f.flameTemp, flameHeight: f.flameHeight, ignited: f.def.ignited,
      })),
      shell,
      camera: { ...camera, position: [...camera.position] as [number, number, number] },
      foundVictimIds: this.victims.filter((v) => v.found).map((v) => v.id),
      events: this.eventLog.map((e) => ({ ...e })),
    };
  }

  restoreSnapshot(s: WorldSnapshot) {
    this.time = s.time;
    this.smoke = JSON.parse(JSON.stringify(s.smoke));
    for (const o of this.objects) o.temperature = s.objectTemps[o.id] ?? this.ambientK;
    this.victims.forEach((v: VictimDef, i) => {
      v.surfaceTemp = s.victimTemps[i]?.surface ?? v.surfaceTemp;
      v.coreTemp = s.victimTemps[i]?.core ?? v.coreTemp;
      v.found = s.foundVictimIds.includes(v.id);
      v.foundAt = v.found ? s.time : undefined;
    });
    this.fires.forEach((f, i) => {
      f.hrr = s.fires[i]?.hrr ?? 0;
      f.flameTemp = s.fires[i]?.flameTemp ?? this.ambientK;
      f.flameHeight = s.fires[i]?.flameHeight ?? 0;
      f.def.ignited = s.fires[i]?.ignited ?? f.def.ignited;
    });
    this.eventLog = s.events.map((e) => ({ ...e }));
  }
}

export { DT, STEFAN };
export type { ShellSurfaceId };
