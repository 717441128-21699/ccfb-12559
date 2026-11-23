import type { CameraState } from '../render/thermalRenderer';
import type { PhysicsWorld } from '../sim/physics';
import type { WorldSnapshot } from '../core/types';

export interface SamplePoint {
  t: number;
  pos: [number, number, number];
  yaw: number;
  pitch: number;
  /** 十字线温度 K */
  crossK: number;
  foundIds: string[];
}

export interface TrainingRecord {
  scenarioId: string;
  startedAt: number;
  duration: number;
  keyframes: WorldSnapshot[];      // 每 5s 一个完整快照（含墙面纹理）
  samples: SamplePoint[];          // 10Hz 轻量轨迹
  events: { time: number; text: string }[];
  foundVictims: { id: string; name: string; at: number; pos: [number, number, number] }[];
  outcome: 'completed' | 'aborted' | 'ongoing';
  summary: {
    distance: number;
    peakUpperTempK: number;
    minInterfaceHeight: number;
    mistUsedSeconds: number;
  };
}

const KEYFRAME_INTERVAL = 5; // s
const SAMPLE_INTERVAL = 0.1;

export class Recorder {
  private record: TrainingRecord;
  private lastKeyframe = -1;
  private lastSample = -1;
  private peakUpper = 0;
  private minInterface = 99;
  private mistSeconds = 0;

  constructor(scenarioId: string) {
    this.record = {
      scenarioId,
      startedAt: Date.now(),
      duration: 0,
      keyframes: [],
      samples: [],
      events: [],
      foundVictims: [],
      outcome: 'ongoing',
      summary: { distance: 0, peakUpperTempK: 0, minInterfaceHeight: 0, mistUsedSeconds: 0 },
    };
  }

  /**
   * 每个物理 tick 调用
   * @param shellProvider 仅在关键帧时刻执行 readback，避免每帧回读
   */
  tick(
    world: PhysicsWorld,
    cam: CameraState,
    crossK: number,
    shellProvider: () => WorldSnapshot['shell'],
    mistActive: boolean,
  ) {
    const t = world.time;
    if (mistActive) this.mistSeconds += SAMPLE_INTERVAL;
    this.peakUpper = Math.max(this.peakUpper, world.smoke.upperTemp);
    this.minInterface = Math.min(this.minInterface, world.smoke.interfaceHeight);

    if (t - this.lastSample >= SAMPLE_INTERVAL - 1e-6) {
      this.lastSample = t;
      this.record.samples.push({
        t,
        pos: [...cam.position] as [number, number, number],
        yaw: cam.yaw,
        pitch: cam.pitch,
        crossK,
        foundIds: world.victims.filter((v) => v.found).map((v) => v.id),
      });
    }
    if (t - this.lastKeyframe >= KEYFRAME_INTERVAL - 1e-6 || this.record.keyframes.length === 0) {
      this.lastKeyframe = t;
      this.record.keyframes.push(
        world.snapshot(
          { position: cam.position, yaw: cam.yaw, pitch: cam.pitch },
          shellProvider(),
        ),
      );
    }
  }

  markFound(world: PhysicsWorld) {
    for (const v of world.victims) {
      if (v.found && !this.record.foundVictims.some((f) => f.id === v.id)) {
        this.record.foundVictims.push({
          id: v.id, name: v.name, at: world.time,
          pos: [...v.position] as [number, number, number],
        });
      }
    }
  }

  finish(outcome: TrainingRecord['outcome'], distance: number): TrainingRecord {
    this.record.outcome = outcome;
    this.record.duration = this.record.samples.at(-1)?.t ?? 0;
    this.record.events = [...this.currentEvents];
    this.record.summary = {
      distance,
      peakUpperTempK: this.peakUpper,
      minInterfaceHeight: this.minInterface === 99 ? 0 : this.minInterface,
      mistUsedSeconds: this.mistSeconds,
    };
    return this.record;
  }

  private currentEvents: { time: number; text: string }[] = [];
  pushEvents(events: { time: number; text: string }[]) {
    this.currentEvents = events.map((e) => ({ ...e }));
  }

  get data() { return this.record; }
}
