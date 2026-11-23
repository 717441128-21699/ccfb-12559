import type { ScenarioDef, TicSettings, WorldSnapshot } from '../core/types';
import { KELVIN, type Vec3 } from '../core/math';
import { PhysicsWorld, DT } from '../sim/physics';
import { buildHumanoid, buildMaterialTable, buildMesh, type Mesh } from '../sim/geometry';
import { ThermalRenderer, type CameraState, type RenderStats } from '../render/thermalRenderer';
import { FirstPersonController } from './controller';
import { Recorder, type TrainingRecord } from './recorder';
import { Minimap } from './minimap';

export interface EngineEvents {
  onStats?: (s: RenderStats) => void;
  onVictimFound?: (name: string) => void;
  onToast?: (text: string) => void;
  onEvent?: (text: string) => void;
}

/**
 * 仿真引擎：物理 10Hz 固定步长 + 渲染 rAF；
 * 渲染管线在 WebGL2，其余逻辑全部 TypeScript。
 */
export class SimulationEngine {
  world: PhysicsWorld;
  renderer: ThermalRenderer;
  controller: FirstPersonController;
  recorder: Recorder;
  minimap: Minimap;
  settings: TicSettings;
  private raf = 0;
  private running = false;
  private last = 0;
  private acc = 0;
  private simTime = 0;
  private events: EngineEvents;
  private mistRate = 0;
  private fpsLowFrames = 0;
  private autoScale = true;
  private currentScale = 1;

  constructor(
    canvas: HTMLCanvasElement,
    minimapCanvas: HTMLCanvasElement,
    scenario: ScenarioDef,
    settings: TicSettings,
    events: EngineEvents = {},
  ) {
    this.settings = settings;
    this.events = events;
    this.world = new PhysicsWorld(scenario);

    // 网格：墙面/家具盒子 + 圆柱 + 人形
    const materialIds = scenario.objects.map((o) => o.materialId);
    const { table, slotOf } = buildMaterialTable(materialIds);
    const meshes: Mesh[] = scenario.objects.map((obj, id) => {
      if (obj.kind === 'humanoid') {
        const v = scenario.victims.find((x) => `vobj-${x.id}` === obj.id);
        return buildHumanoid(obj, id, slotOf.get('skin')!, slotOf.get('clothing')!, v?.exposedSkin ?? 0.25);
      }
      return buildMesh(obj, id, slotOf.get(obj.materialId)!);
    });

    this.renderer = new ThermalRenderer(canvas, scenario, table, slotOf);
    this.renderer.attachMeshes(meshes);
    this.currentScale = settings.renderScale;
    this.renderer.setRenderScale(this.currentScale);

    this.controller = new FirstPersonController(canvas, scenario, (locked) => {
      if (!locked && this.running) this.events.onToast?.('指针已释放，点击画面继续搜索');
    });
    this.recorder = new Recorder(scenario.id);
    this.minimap = new Minimap(minimapCanvas);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.acc = 0;
    const loop = (now: number) => {
      if (!this.running) return;
      const frameDt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.acc += frameDt;
      let steps = 0;
      while (this.acc >= DT && steps < 8) {
        this.world.step([{ id: this.world.scenario.mists[0]?.id ?? 'mist-1', rate: this.mistRate }]);
        this.simTime += DT;
        this.acc -= DT;
        steps++;
        // 记录（关键帧内做墙面纹理回读）
        this.recorder.tick(
          this.world, this.controller.camera,
          this.renderer.currentStats.crosshairK,
          () => this.renderer.readbackHeat(),
          this.mistRate > 0.05,
        );
        this.recorder.pushEvents(this.world.eventLog);
        this.checkVictimProximity();
      }
      const cam = this.controller.update(frameDt);
      this.renderer.render(this.world, cam, this.settings, this.simTime);
      this.minimap.draw(this.world, cam);
      this.adaptPerformance();
      this.events.onStats?.(this.renderer.currentStats);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private shellSnapshot(): WorldSnapshot['shell'] {
    return this.renderer.readbackHeat();
  }

  /** 30fps 兜底：连续低帧则降渲染分辨率，恢复后回升 */
  private adaptPerformance() {
    if (!this.autoScale) return;
    const fps = this.renderer.currentStats.fps;
    if (fps > 0 && fps < 28) {
      this.fpsLowFrames++;
      if (this.fpsLowFrames > 60 && this.currentScale > 0.6) {
        this.currentScale = Math.max(0.6, this.currentScale - 0.1);
        this.renderer.setRenderScale(this.currentScale);
        this.fpsLowFrames = 0;
        this.events.onToast?.(`性能自适应：渲染分辨率降至 ${Math.round(this.currentScale * 100)}%`);
      }
    } else if (fps > 45 && this.currentScale < this.settings.renderScale) {
      this.fpsLowFrames--;
      if (this.fpsLowFrames < -90) {
        this.currentScale = Math.min(this.settings.renderScale, this.currentScale + 0.1);
        this.renderer.setRenderScale(this.currentScale);
        this.fpsLowFrames = 0;
      }
    }
  }

  /** 队员靠近被困者 1.5m 内按 E / 或自动标记（自动：进入 1.8m） */
  private checkVictimProximity() {
    for (const v of this.world.victims) {
      if (v.found) continue;
      const d = Math.hypot(
        this.controller.camera.position[0] - v.position[0],
        this.controller.camera.position[2] - v.position[2],
      );
      if (d < 1.8) {
        v.found = true;
        v.foundAt = this.world.time;
        this.recorder.markFound(this.world);
        this.events.onVictimFound?.(v.name);
      }
    }
  }

  markNearestVictim() {
    let best: { d: number; id: string } | null = null;
    for (const v of this.world.victims) {
      if (v.found) continue;
      const d = Math.hypot(
        this.controller.camera.position[0] - v.position[0],
        this.controller.camera.position[2] - v.position[2],
      );
      if (d < 4 && (!best || d < best.d)) best = { d, id: v.id };
    }
    if (best) {
      const v = this.world.victims.find((x) => x.id === best!.id)!;
      v.found = true; v.foundAt = this.world.time;
      this.recorder.markFound(this.world);
      this.events.onVictimFound?.(v.name);
    } else {
      this.events.onToast?.('附近 4m 内没有可标记的被困者');
    }
  }

  setMist(rate: number) { this.mistRate = Math.max(0, Math.min(1, rate)); }
  get mistActive() { return this.mistRate > 0.05; }

  updateSettings(patch: Partial<TicSettings>) {
    const prevScale = this.settings.renderScale;
    Object.assign(this.settings, patch);
    if (patch.renderScale && patch.renderScale !== prevScale) {
      this.currentScale = patch.renderScale;
      this.renderer.setRenderScale(this.currentScale);
    }
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.controller.exitLock();
  }

  finish(outcome: TrainingRecord['outcome']): TrainingRecord {
    const rec = this.recorder.finish(outcome, this.controller.distanceWalked);
    return rec;
  }

  get camera(): CameraState { return this.controller.camera; }
  get time() { return this.simTime; }

  /** 释放 GL 资源（切换场景时） */
  dispose() {
    this.stop();
    const gl = (this.renderer as unknown as { gl: WebGL2RenderingContext }).gl;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

export function defaultSettings(): TicSettings {
  return {
    palette: 'iron',
    gainMode: 'auto',
    lockedMin: 290,
    lockedMax: 320,
    agcSensitivity: 1,
    noiseLevel: 0.6,
    fovY: 50,
    reflectionInterval: 2,
    renderScale: 1,
  };
}

export { KELVIN };
export type { Vec3 };
