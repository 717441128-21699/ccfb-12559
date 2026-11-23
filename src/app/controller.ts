import type { ScenarioDef } from '../core/types';
import { clamp, v3, type Vec3 } from '../core/math';
import type { CameraState } from '../render/thermalRenderer';

const EYE_HEIGHT = 1.62;
const RADIUS = 0.32;       // 队员碰撞半径
const WALK_SPEED = 2.4;    // m/s 搜索行进速度
const RUN_SPEED = 4.2;

/**
 * 第一人称搜索控制：WASD 移动 + 指针锁定鼠标视角 + 碰撞（与墙体 AABB 推挤）
 * 同时维护热像仪姿态（与头部一致）
 */
export class FirstPersonController {
  camera: CameraState;
  private keys = new Set<string>();
  private locked = false;
  private scenario: ScenarioDef;
  private el: HTMLElement;
  private onLockChange?: (locked: boolean) => void;
  /** 累计移动里程（训练评估用） */
  distanceWalked = 0;

  constructor(canvas: HTMLElement, scenario: ScenarioDef, onLockChange?: (locked: boolean) => void) {
    this.el = canvas;
    this.scenario = scenario;
    this.onLockChange = onLockChange;
    this.camera = {
      position: [...scenario.spawn.position] as Vec3,
      yaw: scenario.spawn.yaw,
      pitch: 0,
    };
    this.bind();
  }

  private bind() {
    document.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
    });
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
    this.el.addEventListener('click', () => {
      if (!this.locked) this.el.requestPointerLock?.();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      this.onLockChange?.(this.locked);
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      const sens = 0.0022;
      this.camera.yaw -= e.movementX * sens;
      this.camera.pitch = clamp(
        this.camera.pitch - e.movementY * sens,
        -Math.PI / 2 + 0.08, Math.PI / 2 - 0.08,
      );
    });
  }

  get isLocked() { return this.locked; }
  requestLock() { this.el.requestPointerLock?.(); }
  exitLock() { document.exitPointerLock?.(); }

  update(dt: number): CameraState {
    if (!this.locked) return this.camera;
    const forward: Vec3 = [-Math.sin(this.camera.yaw), 0, -Math.cos(this.camera.yaw)];
    const right: Vec3 = [Math.cos(this.camera.yaw), 0, -Math.sin(this.camera.yaw)];
    const move: Vec3 = [0, 0, 0];
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) {
      move[0] += forward[0]; move[2] += forward[2];
    }
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) {
      move[0] -= forward[0]; move[2] -= forward[2];
    }
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) {
      move[0] -= right[0]; move[2] -= right[2];
    }
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) {
      move[0] += right[0]; move[2] += right[2];
    }
    const speed = this.keys.has('ShiftLeft') ? RUN_SPEED : WALK_SPEED;
    const len = Math.hypot(move[0], move[2]);
    if (len > 1e-6) {
      const step = v3.scale(v3.norm(move), speed * dt);
      const next = v3.add(this.camera.position, step);
      this.collide(next);
      this.distanceWalked += v3.dist(this.camera.position, next);
      this.camera.position = next;
    }
    this.camera.position[1] = EYE_HEIGHT;
    return this.camera;
  }

  /** AABB 碰撞推挤（只在水平面上处理） */
  private collide(pos: Vec3) {
    const room = this.scenario.roomSize;
    pos[0] = clamp(pos[0], -room[0] / 2 + RADIUS, room[0] / 2 - RADIUS);
    pos[2] = clamp(pos[2], -room[2] / 2 + RADIUS, room[2] / 2 - RADIUS);
    for (const o of this.scenario.objects) {
      if (o.isWall && (o.shellSurface === 'floor' || o.shellSurface === 'ceiling')) continue;
      const hx = o.size[0] / 2 + RADIUS;
      const hz = o.size[2] / 2 + RADIUS;
      const dx = pos[0] - o.position[0];
      const dz = pos[2] - o.position[2];
      // 圆柱-矩形简化：最近点判定
      const nx = clamp(dx, -hx, hx);
      const nz = clamp(dz, -hz, hz);
      const d2 = (dx - nx) ** 2 + (dz - nz) ** 2;
      if (d2 < RADIUS * RADIUS) {
        // 从最近点推出
        const d = Math.sqrt(d2) || 0.001;
        const push = (RADIUS - d) / d;
        pos[0] += (dx - nx) * push;
        pos[2] += (dz - nz) * push;
        // 完全在盒内时按最小穿透轴推出
        if (d2 < 1e-8) {
          const ox = hx - Math.abs(dx);
          const oz = hz - Math.abs(dz);
          if (ox < oz) pos[0] += (dx >= 0 ? ox : -ox);
          else pos[2] += (dz >= 0 ? oz : -oz);
        }
      }
    }
  }

  teleport(p: Vec3, yaw: number) {
    this.camera.position = [...p] as Vec3;
    this.camera.yaw = yaw;
    this.camera.pitch = 0;
  }
}
