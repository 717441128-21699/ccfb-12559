import type { ShellSurfaceId, SimObject } from '../core/types';
import type { HeatDriver } from '../sim/physics';
import { createProgram, createTexture2D, u1, u1i, u2, uVec2, uVec3, uVec4, useProgram } from './glUtils';
import { HEAT_FS, QUAD_VS } from './shaders';
import { MATERIALS } from '../sim/materials';
import type { Vec3 } from '../core/math';
import { v3 } from '../core/math';

const TEX_SIZE = 48; // 每个壳面 48×48 温度纹素
export const SURFACES: ShellSurfaceId[] = ['floor', 'ceiling', 'wall0', 'wall1', 'wall2', 'wall3'];

/** float32 → float16 半浮点转换（RGBA16F 纹理初始化用） */
function floatToHalf(f: number): number {
  const buf = new ArrayBuffer(4);
  new Float32Array(buf)[0] = f;
  const i = new Uint32Array(buf)[0];
  const sign = (i >>> 16) & 0x8000;
  let exp = ((i >>> 23) & 0xff) - 127 + 15;
  const mant = i & 0x7fffff;
  if (exp <= 0) return sign;
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | (mant >>> 13);
}

interface SurfaceGPU {
  id: ShellSurfaceId;
  tex: [WebGLTexture, WebGLTexture]; // ping-pong RG32F
  origin: Vec3;
  basis: Vec3;      // 局部 u 轴世界方向
  normal: Vec3;
  physSize: [number, number];
  heatCapacity: number;
  alpha: number;
  /** 该壳面上的隔墙分区（世界包围盒 → 纹理 UV 矩形），同步参与扩散 */
  rects: { obj: SimObject; rect: [number, number, number, number] }[];
}

export class HeatField {
  private gl: WebGL2RenderingContext;
  private program: ReturnType<typeof createProgram>;
  private vao: WebGLVertexArrayObject;
  private fbo: WebGLFramebuffer;
  surfaces = new Map<ShellSurfaceId, SurfaceGPU>();
  private ambient: number;
  private emissivity: number;

  constructor(
    gl: WebGL2RenderingContext,
    room: Vec3,
    wallMaterialId: string,
    ambientK: number,
    fullscreenVao: WebGLVertexArrayObject,
    wallObjects: SimObject[],
  ) {
    this.gl = gl;
    this.ambient = ambientK;
    const mat = MATERIALS[wallMaterialId];
    this.emissivity = mat.emissivity;
    this.program = createProgram(gl, QUAD_VS, HEAT_FS);
    this.vao = fullscreenVao;
    this.fbo = gl.createFramebuffer()!;

    const [W, H, D] = room;
    const thickness = 0.15;
    const heatCapacity = mat.density * mat.specificHeat * thickness;
    const alpha = mat.conductivity / (mat.density * mat.specificHeat);

    // 每个壳面：原点（纹理 0,0 对应的世界点）、u 轴方向、法向、物理尺寸
    const defs: { id: ShellSurfaceId; origin: Vec3; basis: Vec3; normal: Vec3; phys: [number, number] }[] = [
      { id: 'floor', origin: [-W / 2, 0, -D / 2], basis: [1, 0, 0], normal: [0, 1, 0], phys: [W, D] },
      { id: 'ceiling', origin: [-W / 2, H, -D / 2], basis: [1, 0, 0], normal: [0, -1, 0], phys: [W, D] },
      { id: 'wall0', origin: [W / 2, 0, -D / 2], basis: [0, 1, 0], normal: [-1, 0, 0], phys: [H, D] },
      { id: 'wall1', origin: [-W / 2, 0, -D / 2], basis: [0, 1, 0], normal: [1, 0, 0], phys: [H, D] },
      { id: 'wall2', origin: [-W / 2, 0, D / 2], basis: [1, 0, 0], normal: [0, 0, -1], phys: [W, H] },
      { id: 'wall3', origin: [-W / 2, 0, -D / 2], basis: [1, 0, 0], normal: [0, 0, 1], phys: [W, H] },
    ];
    const halfData = new Uint16Array(TEX_SIZE * TEX_SIZE * 4);
    for (let i = 0; i < TEX_SIZE * TEX_SIZE; i++) {
      halfData[i * 4] = floatToHalf(ambientK); // R 通道存温度
    }
    for (const d of defs) {
      const mk = () => createTexture2D(gl, {
        width: TEX_SIZE, height: TEX_SIZE,
        internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT,
        filter: gl.NEAREST,
        data: new Uint16Array(halfData),
      });
      const rects = wallObjects
        .filter((o) => o.isWall && o.shellSurface === d.id && o.shellRect)
        .map((obj) => ({ obj, rect: obj.shellRect! }));
      this.surfaces.set(d.id, {
        id: d.id, tex: [mk(), mk()], origin: d.origin, basis: d.basis,
        normal: d.normal, physSize: d.phys, heatCapacity, alpha, rects,
      });
    }
  }

  colorTextures(): WebGLTexture[] {
    return SURFACES.map((id) => this.surfaces.get(id)!.tex[0]);
  }

  /** 10Hz 推进一次所有壳面的热扩散 */
  step(dt: number, driver: HeatDriver) {
    const gl = this.gl;
    useProgram(gl, this.program);
    const p = this.program;
    gl.bindVertexArray(this.vao);
    // 清空活动纹理单元，避免上一 Pass 残留绑定导致 FBO 挂载反馈
    for (let unit = 0; unit < 8; unit++) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, TEX_SIZE, TEX_SIZE);
    gl.disable(gl.DEPTH_TEST);

    const fires = driver.fires.slice(0, 6);
    const firePos = new Float32Array(6 * 4);
    const firePar = new Float32Array(6 * 4);
    for (let i = 0; i < 6; i++) {
      const f = fires[i];
      if (f) {
        firePos.set([f.position[0], f.position[1], f.position[2], f.radius], i * 4);
        firePar.set([f.hrr, f.flameHeight, f.flameTemp, 0], i * 4);
      } else {
        firePar.set([0, 0, this.ambient, 0], i * 4);
      }
    }
    const fpLoc = p.uniforms.get('uFires[0]');
    if (fpLoc) gl.uniform4fv(fpLoc, firePos);
    const fparLoc = p.uniforms.get('uFireParams[0]');
    if (fparLoc) gl.uniform4fv(fparLoc, firePar);
    u1i(gl, p, 'uFireCount', fires.length);
    u1(gl, p, 'uDt', dt);
    u1(gl, p, 'uAmbient', this.ambient);
    u1(gl, p, 'uEmissivity', this.emissivity);
    u1(gl, p, 'uUpperT', driver.smoke.upperTemp);
    u1(gl, p, 'uInterfaceH', driver.smoke.interfaceHeight);

    for (const id of SURFACES) {
      const s = this.surfaces.get(id)!;
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, s.tex[1], 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, s.tex[0]);
      const loc = p.uniforms.get('uPrev');
      if (loc) gl.uniform1i(loc, 0);
      u2(gl, p, 'uTexel', 1 / TEX_SIZE, 1 / TEX_SIZE);
      u1(gl, p, 'uAlpha', s.alpha);
      u1(gl, p, 'uHeatCapacity', s.heatCapacity);
      uVec3(gl, p, 'uSurfaceNormal', s.normal);
      uVec3(gl, p, 'uSurfaceOrigin', s.origin);
      uVec3(gl, p, 'uSurfaceBasis', s.basis);
      uVec2(gl, p, 'uSurfaceSize', s.physSize);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const tmp = s.tex[0]; s.tex[0] = s.tex[1]; s.tex[1] = tmp;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** 读回六张温度纹理（复盘快照，10Hz，单次约 18KB） */
  readback(): { surface: ShellSurfaceId; data: Float32Array; width: number; height: number }[] {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    const out: { surface: ShellSurfaceId; data: Float32Array; width: number; height: number }[] = [];
    const rgba = new Float32Array(TEX_SIZE * TEX_SIZE * 4);
    const oneChannel = new Float32Array(TEX_SIZE * TEX_SIZE);
    for (const id of SURFACES) {
      const s = this.surfaces.get(id)!;
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, s.tex[0], 0);
      gl.readPixels(0, 0, TEX_SIZE, TEX_SIZE, gl.RGBA, gl.FLOAT, rgba);
      for (let i = 0; i < TEX_SIZE * TEX_SIZE; i++) oneChannel[i] = rgba[i * 4];
      out.push({ surface: id, data: new Float32Array(oneChannel), width: TEX_SIZE, height: TEX_SIZE });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /** 从快照恢复（回放拖进度条） */
  restore(snapshots: { surface: ShellSurfaceId; data: Float32Array }[]) {
    const gl = this.gl;
    for (const snap of snapshots) {
      const s = this.surfaces.get(snap.surface)!;
      const rgba = new Uint16Array(TEX_SIZE * TEX_SIZE * 4);
      for (let i = 0; i < TEX_SIZE * TEX_SIZE; i++) rgba[i * 4] = floatToHalf(snap.data[i]);
      for (const tex of s.tex) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, TEX_SIZE, TEX_SIZE, 0, gl.RGBA, gl.HALF_FLOAT, rgba);
      }
    }
  }

  /** 计算墙面世界点对应的壳面 UV（场景 Pass 之外的调试/回读用） */
  worldToUV(id: ShellSurfaceId, world: Vec3): [number, number] {
    const s = this.surfaces.get(id)!;
    const rel = v3.sub(world, s.origin);
    return [
      v3.dot(rel, s.basis) / s.physSize[0],
      v3.dot(rel, v3.cross(s.normal, s.basis)) / s.physSize[1],
    ];
  }
}
