import type { PhysicsWorld } from '../sim/physics';
import type { CameraState } from '../render/thermalRenderer';
import { MATERIALS } from '../sim/materials';

/** Canvas2D 顶视图小地图，训练搜索与复盘共用 */
export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private trail: { x: number; z: number }[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  clearTrail() { this.trail.length = 0; }

  draw(world: PhysicsWorld, cam: CameraState, compact = false) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const room = world.scenario.roomSize;
    const scale = Math.min((W - 16) / room[0], (H - 16) / room[2]);
    const ox = W / 2, oz = H / 2;
    const toX = (x: number) => ox + x * scale;
    const toY = (z: number) => oz + z * scale;

    ctx.fillStyle = '#0b0f14';
    ctx.fillRect(0, 0, W, H);

    // 房间外轮廓
    ctx.strokeStyle = '#3a4a5e';
    ctx.lineWidth = 2;
    ctx.strokeRect(toX(-room[0] / 2), toY(-room[2] / 2), room[0] * scale, room[2] * scale);

    // 物体（墙/家具/玻璃金属区分）
    for (const o of world.objects) {
      const mat = MATERIALS[o.materialId];
      if (o.isVictim) continue;
      const w = o.size[0] * scale, d = o.size[2] * scale;
      if (o.isWall) {
        if (o.shellSurface === 'floor' || o.shellSurface === 'ceiling') continue;
        ctx.fillStyle = '#263445';
      } else if (mat.metallic > 0.8) {
        ctx.fillStyle = '#4d6b8a';
      } else if (o.materialId === 'glass') {
        ctx.fillStyle = 'rgba(110,180,200,0.55)';
      } else {
        ctx.fillStyle = '#33414f';
      }
      ctx.fillRect(toX(o.position[0]) - w / 2, toY(o.position[2]) - d / 2, w, d);
      // 温度热染色（升温的家具泛红）
      const dT = o.temperature - (world.ambientK);
      if (dT > 8 && !o.isWall) {
        ctx.fillStyle = `rgba(255,${Math.max(60, 180 - dT * 2)},40,${Math.min(0.7, dT / 120)})`;
        ctx.fillRect(toX(o.position[0]) - w / 2, toY(o.position[2]) - d / 2, w, d);
      }
    }

    // 烟气层投影范围（界面低于 1.8m 时整屋填烟色，深浅表示 OD）
    if (world.smoke.interfaceHeight < room[1] - 0.05) {
      const a = Math.min(0.5, world.smoke.upperOpticalDensity * 0.22);
      ctx.fillStyle = `rgba(160,160,170,${a})`;
      ctx.fillRect(toX(-room[0] / 2), toY(-room[2] / 2), room[0] * scale, room[2] * scale);
    }
    // 水雾
    for (const m of world.smoke.mists) {
      ctx.fillStyle = `rgba(120,170,255,${Math.min(0.5, m.density * 0.4)})`;
      ctx.beginPath();
      ctx.arc(toX(m.position[0]), toY(m.position[2]), m.radius * scale, 0, Math.PI * 2);
      ctx.fill();
    }
    // 火源
    for (const f of world.fires) {
      if (f.hrr <= 1) continue;
      const r = Math.max(4, f.def.radius * scale * (1 + f.hrr / 2000));
      const grad = ctx.createRadialGradient(toX(f.def.position[0]), toY(f.def.position[2]), 0,
        toX(f.def.position[0]), toY(f.def.position[2]), r * 1.8);
      grad.addColorStop(0, 'rgba(255,140,30,0.95)');
      grad.addColorStop(1, 'rgba(255,60,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(toX(f.def.position[0]), toY(f.def.position[2]), r * 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    // 被困者
    for (const v of world.victims) {
      ctx.fillStyle = v.found ? '#3ddc84' : '#ffd54a';
      ctx.beginPath();
      ctx.arc(toX(v.position[0]), toY(v.position[2]), compact ? 3.5 : 5, 0, Math.PI * 2);
      ctx.fill();
      if (v.found) {
        ctx.strokeStyle = '#3ddc84';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(toX(v.position[0]), toY(v.position[2]), 8, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // 队员轨迹
    this.trail.push({ x: cam.position[0], z: cam.position[2] });
    if (this.trail.length > 900) this.trail.shift();
    ctx.strokeStyle = 'rgba(90,200,255,0.5)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    this.trail.forEach((p, i) => {
      if (i === 0) ctx.moveTo(toX(p.x), toY(p.z));
      else ctx.lineTo(toX(p.x), toY(p.z));
    });
    ctx.stroke();

    // 队员（带朝向锥）
    const px = toX(cam.position[0]), py = toY(cam.position[2]);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-cam.yaw);
    ctx.fillStyle = '#5ac8ff';
    ctx.beginPath();
    ctx.moveTo(9, 0);
    ctx.lineTo(-5, -5);
    ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
