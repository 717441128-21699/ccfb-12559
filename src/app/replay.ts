import type { ScenarioDef, TicSettings } from '../core/types';
import type { TrainingRecord, SamplePoint } from './recorder';
import { PhysicsWorld, DT } from '../sim/physics';
import { buildHumanoid, buildMaterialTable, buildMesh, type Mesh } from '../sim/geometry';
import { ThermalRenderer, type CameraState } from '../render/thermalRenderer';
import { Minimap } from './minimap';

/**
 * 复盘回放：
 * - 播放时按录制的 10Hz 轨迹驱动相机，物理确定性重算；
 * - 拖进度条时定位到最近关键帧（5s 间隔），从该快照恢复后最多快进 50 个物理步。
 */
export class ReplayEngine {
  private record: TrainingRecord;
  private scenario: ScenarioDef;
  private world: PhysicsWorld;
  private renderer: ThermalRenderer;
  private minimap: Minimap;
  private settings: TicSettings;
  private raf = 0;
  private playing = false;
  private curT = 0;
  private last = 0;
  private restoredKey = -1;
  onTick?: (t: number, sample: SamplePoint | null) => void;

  constructor(
    canvas: HTMLCanvasElement,
    minimapCanvas: HTMLCanvasElement,
    record: TrainingRecord,
    scenario: ScenarioDef,
    settings: TicSettings,
  ) {
    this.record = record;
    this.scenario = scenario;
    this.settings = settings;
    this.world = new PhysicsWorld(scenario);

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
    this.minimap = new Minimap(minimapCanvas);
    // 初始尺寸由外部在构造后调用 resize() 再 seek，避免在默认 1280×720 上首帧渲染
  }

  get duration() { return this.record.duration; }
  get currentTime() { return this.curT; }
  get glRenderer() { return this.renderer; }

  private sampleAt(t: number): SamplePoint | null {
    const s = this.record.samples;
    if (!s.length) return null;
    let lo = 0, hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid].t < t) lo = mid + 1; else hi = mid;
    }
    return s[Math.max(0, lo - 1)] ?? s[0];
  }

  /** 跳转到指定时间（秒） */
  seek(t: number) {
    this.curT = Math.max(0, Math.min(this.record.duration, t));
    // 找最近的前序关键帧
    let kf = this.record.keyframes[0];
    let kIdx = 0;
    for (let i = 0; i < this.record.keyframes.length; i++) {
      if (this.record.keyframes[i].time <= this.curT) { kf = this.record.keyframes[i]; kIdx = i; }
    }
    if (kIdx !== this.restoredKey || this.curT < kf.time) {
      this.world.restoreSnapshot(kf);
      this.renderer.restoreHeat(kf.shell);
      this.restoredKey = kIdx;
    }
    // 从关键帧快进到目标时间（最多 50 步 = 5s）
    let guard = 0;
    while (this.world.time < this.curT - 1e-6 && guard < 60) {
      this.world.step();
      guard++;
    }
    this.curT = this.world.time;
    this.drawFrame();
  }

  private drawFrame() {
    const sample = this.sampleAt(this.curT);
    const cam: CameraState = sample
      ? { position: sample.pos, yaw: sample.yaw, pitch: sample.pitch }
      : { position: this.scenario.spawn.position, yaw: this.scenario.spawn.yaw, pitch: 0 };
    this.renderer.render(this.world, cam, this.settings, this.curT);
    this.minimap.draw(this.world, cam, true);
    this.onTick?.(this.curT, sample);
  }

  play() {
    if (this.playing) return;
    if (this.curT >= this.record.duration - 0.05) this.seek(0);
    this.playing = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.playing) return;
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.seek(this.curT + dt);
      if (this.curT >= this.record.duration - 0.05) {
        this.playing = false;
        this.onTick?.(this.curT, this.sampleAt(this.curT));
        return;
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
  }

  get isPlaying() { return this.playing; }

  dispose() {
    this.pause();
    const gl = (this.renderer as unknown as { gl: WebGL2RenderingContext }).gl;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

export { DT };
