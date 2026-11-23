import type { MaterialDef, ScenarioDef, ShellSurfaceId, SimObject, SmokeState, TicSettings } from '../core/types';
import { KELVIN, m4, v3, type Mat4, type Vec3 } from '../core/math';
import {
  checkFBOColorFloat, createFBO, createFullscreenVAO, createProgram, createTexture2D,
  u1, u1i, u2, uCube, uMat4, uTex, uVec3, uVec4, useProgram,
  type FBO, type GLProgram,
} from './glUtils';
import {
  FLAME_FS, FLAME_VS, MEDIUM_FS, PALETTE_FS, QUAD_VS,
  REDUCE_FS, BLIT_FS, SCENE_FS, SCENE_VS,
} from './shaders';
import { buildFlameCone, type GpuMesh, MeshStore } from './meshStore';
import { HeatField, SURFACES } from './heatField';
import { ReflectionProbe } from './reflectionProbe';
import { RangeController, buildHistogram, type Histogram } from './rangeController';
import { invPlanck10, planck10 } from './planck';
import type { PhysicsWorld } from '../sim/physics';
import { DT } from '../sim/physics';

export interface CameraState {
  position: Vec3;
  yaw: number;
  pitch: number;
}

export interface RenderStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  crosshairK: number;
  crosshairObjectLabel: string;
  histogram: Histogram | null;
  rangeMinK: number;
  rangeMaxK: number;
}

const MAX_MIST = 8;
const MAX_OBJECTS = 96;

export class ThermalRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private scenario: ScenarioDef;
  private meshStore: MeshStore;
  private gpuMeshes: GpuMesh[] = [];
  private materialTable: MaterialDef[];
  private slotOf: Map<string, number>;
  private heatField: HeatField;
  private probe: ReflectionProbe;
  private range = new RangeController();
  private quadVao: WebGLVertexArrayObject;
  private flameVao: WebGLVertexArrayObject;

  private progScene: GLProgram;
  private progFlame: GLProgram;
  private progMedium: GLProgram;
  private progReduce: GLProgram;
  private progBlit: GLProgram;
  private progPalette: GLProgram;

  // 帧缓冲
  private sceneFBO!: FBO;       // MRT: radiance / world / shell + depth
  private mediumFBO!: FBO;      // 介质后
  private reduceFBOs: FBO[] = [];
  private rangeTex!: WebGLTexture; // 1x1 min/max
  private rangeFBO!: WebGLFramebuffer;
  private histTex!: WebGLTexture;  // 64x64 回读用
  private histFBO!: WebGLFramebuffer;
  private depthSampleTex!: WebGLTexture;
  private depthBlitFBO!: WebGLFramebuffer;
  private _cleanTex: WebGLTexture | null = null;

  private width = 1280;
  private height = 720;
  private renderScale = 1;
  private frameNo = 0;
  private lastT = performance.now();
  private fpsAvg = 30;
  private frameMsAvg = 16;
  private objectTemps = new Float32Array(MAX_OBJECTS);
  private objectLabels: string[] = [];
  private shellIdMap = new Map<ShellSurfaceId, number>();
  private readbackBuf = new Float32Array(64 * 64);
  private stats: RenderStats;
  private drawCalls = 0;
  private lastGlErr = 0;
  /** 十字线像素中心温度（每帧更新） */
  private crosshairK = 300;
  private crosshairLabel = '';

  constructor(canvas: HTMLCanvasElement, scenario: ScenarioDef, materialTable: MaterialDef[], slotOf: Map<string, number>) {
    this.canvas = canvas;
    this.scenario = scenario;
    this.materialTable = materialTable;
    this.slotOf = slotOf;
    const gl = canvas.getContext('webgl2', {
      antialias: false, depth: true, alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    if (!checkFBOColorFloat(gl)) throw new Error('缺少 EXT_color_buffer_float，无法渲染浮点热缓冲');

    SURFACES.forEach((id, i) => this.shellIdMap.set(id, i));
    this.quadVao = createFullscreenVAO(gl);
    this.meshStore = new MeshStore(gl);
    this.flameVao = buildFlameCone(gl);

    this.progScene = createProgram(gl, SCENE_VS, SCENE_FS);
    this.progFlame = createProgram(gl, FLAME_VS, FLAME_FS);
    this.progMedium = createProgram(gl, QUAD_VS, MEDIUM_FS);
    this.progReduce = createProgram(gl, QUAD_VS, REDUCE_FS);
    this.progBlit = createProgram(gl, QUAD_VS, BLIT_FS);
    this.progPalette = createProgram(gl, QUAD_VS, PALETTE_FS);

    const wallObjs = scenario.objects.filter((o) => o.isWall);
    this.heatField = new HeatField(
      gl, scenario.roomSize, wallObjs[0]?.materialId ?? 'concrete',
      scenario.ambientC + KELVIN, this.quadVao, wallObjs,
    );
    this.probe = new ReflectionProbe(gl);
    this.range.reset(scenario.ambientC + KELVIN);

    this.stats = {
      fps: 0, frameMs: 0, drawCalls: 0,
      crosshairK: 300, crosshairObjectLabel: '',
      histogram: null, rangeMinK: 0, rangeMaxK: 0,
    };
  }

  attachMeshes(meshes: import('../sim/geometry').Mesh[]) {
    for (const mesh of meshes) this.gpuMeshes.push(this.meshStore.upload(mesh));
    this.objectLabels = new Array(MAX_OBJECTS).fill('');
    for (const m of this.gpuMeshes) {
      const obj = this.scenario.objects[m.objectId];
      if (obj) this.objectLabels[m.objectId] = obj.label;
    }
    this.resize(this.width, this.height);
  }

  get rangeController() { return this.range; }
  get currentStats() { return this.stats; }

  resize(cssW: number, cssH: number) {
    this.width = Math.max(320, cssW);
    this.height = Math.max(240, cssH);
    const s = this.renderScale;
    const w = Math.round(this.width * s), h = Math.round(this.height * s);
    const gl = this.gl;
    this.canvas.width = w;
    this.canvas.height = h;

    // MRT 场景缓冲（深度 renderbuffer，稍后 blit 到可采样深度纹理）
    this.sceneFBO = createFBO(gl, w, h, [
      { width: w, height: h, internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, filter: gl.NEAREST },
      { width: w, height: h, internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, filter: gl.NEAREST },
      { width: w, height: h, internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, filter: gl.NEAREST },
    ], true);
    // 供介质 Pass 采样的深度纹理 + 只挂深度的中转 FBO
    this.depthSampleTex = createTexture2D(gl, {
      width: w, height: h,
      internal: gl.DEPTH_COMPONENT24, format: gl.DEPTH_COMPONENT, type: gl.UNSIGNED_INT,
    });
    this.depthBlitFBO = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.depthBlitFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.depthSampleTex, 0);
    // 只挂深度的 FBO 必须显式声明无颜色输出，否则 blit 到它会失败
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    const depthBlitStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (depthBlitStatus !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`深度 blit FBO 不完整: 0x${depthBlitStatus.toString(16)}`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // 介质输出（辐射亮度 + 世界坐标）
    this.mediumFBO = createFBO(gl, w, h, [
      { width: w, height: h, internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, filter: gl.NEAREST },
      { width: w, height: h, internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, filter: gl.NEAREST },
    ]);
    // min/max 缩减链（每级 3×3 邻域 → 尺寸约缩 1/3）
    this.reduceFBOs.forEach((f) => gl.deleteFramebuffer(f.fbo));
    this.reduceFBOs = [];
    let rw = Math.ceil(w / 3), rh = Math.ceil(h / 3);
    while (rw >= 1 && rh >= 1) {
      this.reduceFBOs.push(createFBO(gl, rw, rh, [
        { width: rw, height: rh, internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, filter: gl.NEAREST },
      ], false));
      if (rw === 1 && rh === 1) break;
      rw = Math.max(1, Math.ceil(rw / 3));
      rh = Math.max(1, Math.ceil(rh / 3));
    }
    // 1x1 量程（RGBA16F，r=min g=max）；HALF_FLOAT 纹理初始数据必须是 Uint16Array 或 null
    this.rangeTex = createTexture2D(gl, {
      width: 1, height: 1, internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT,
      data: null,
    });
    this.rangeFBO = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.rangeFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.rangeTex, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // 直方图/十字线回读纹理（从最终辐射亮度降采样；RGBA16F 兼容性最好）
    this.histTex = createTexture2D(gl, {
      width: 64, height: 64, internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT,
    });
    this.histFBO = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.histFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.histTex, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  setRenderScale(scale: number) {
    this.renderScale = scale;
    this.resize(this.width, this.height);
  }

  get currentScale() { return this.renderScale; }

  // ============================================================ 主渲染
  render(world: PhysicsWorld, cam: CameraState, settings: TicSettings, time: number) {
    const gl = this.gl;
    const t0 = performance.now();
    this.drawCalls = 0;
    this.frameNo++;

    // 10Hz 墙面热扩散（与物理同频，每 6 帧约 10Hz）
    if (this.frameNo % 6 === 1) {
      this.heatField.step(DT, world.heatDriver());
    }

    // 物体温度 uniform
    world.objects.forEach((o: SimObject, i) => {
      if (i < MAX_OBJECTS) this.objectTemps[i] = o.temperature;
    });

    const aspect = this.canvas.width / this.canvas.height;
    const proj = m4.perspective((settings.fovY * Math.PI) / 180, aspect, 0.05, 60);
    const view = m4.inverse(m4.compose(cam.position, cam.yaw, cam.pitch));
    const vp = m4.multiply(proj, view);
    const invVP = m4.inverse(vp);

    // 反射立方体贴图（按间隔刷新，省性能）
    if (settings.reflectionInterval === 0 || this.frameNo % Math.max(1, settings.reflectionInterval) === 1) {
      const probeEye: Vec3 = [cam.position[0], 1.5, cam.position[2]];
      this.probe.render(
        probeEye, this.gpuMeshes, this.objectTemps, this.materialTable,
        this.flameVao, world.fires.length,
        world.fires.filter((f) => f.hrr > 1).map((f) => ({
          base: f.def.position, height: f.flameHeight, radius: f.def.radius, temp: f.flameTemp,
        })),
        planck10(world.ambientK),
      );
    }

    // ---------------- Pass 1: 场景 MRT ----------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFBO.fbo);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.depthFunc(gl.LEQUAL);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    useProgram(gl, this.progScene);
    const ps = this.progScene;
    uMat4(gl, ps, 'uVP', vp);
    uVec3(gl, ps, 'uCamPos', cam.position);
    const matData = new Float32Array(16 * 4);
    this.materialTable.forEach((m, i) => {
      matData[i * 4] = m.emissivity;
      matData[i * 4 + 1] = m.metallic;
    });
    const matLoc = ps.uniforms.get('uMatTable[0]');
    if (matLoc) gl.uniform4fv(matLoc, matData);
    const tLoc = ps.uniforms.get('uObjectTemp[0]');
    if (tLoc) gl.uniform1fv(tLoc, this.objectTemps);
    u1i(gl, ps, 'uObjectCount', Math.min(world.objects.length, MAX_OBJECTS));
    uCube(gl, ps, 'uEnvMap', 0, this.probe.cube);
    const shellTexs = this.heatField.colorTextures();
    // 六个独立采样器 uShell0..5 → 纹理单元 1–6
    for (let i = 0; i < 6; i++) {
      gl.activeTexture(gl.TEXTURE1 + i);
      gl.bindTexture(gl.TEXTURE_2D, shellTexs[i]);
      const loc = ps.uniforms.get(`uShell${i}`);
      if (loc) gl.uniform1i(loc, 1 + i);
    }
    gl.activeTexture(gl.TEXTURE0);

    for (const m of this.gpuMeshes) {
      const obj = world.objects[m.objectId];
      u1i(gl, ps, 'uIsWall', m.isWall ? 1 : 0);
      u1i(gl, ps, 'uObjectId', m.objectId);
      const shellId = obj?.shellSurface ? this.shellIdMap.get(obj.shellSurface) ?? 0 : 0;
      u1i(gl, ps, 'uShellId', shellId);
      if (obj?.shellRect) uVec4(gl, ps, 'uShellRect', obj.shellRect);
      else uVec4(gl, ps, 'uShellRect', [0, 0, 1, 1]);
      gl.bindVertexArray(m.vao);
      gl.drawElements(gl.TRIANGLES, m.indexCount, gl.UNSIGNED_INT, 0);
      this.drawCalls++;
    }

    // ---------------- Pass 2: 火焰代理 ----------------
    useProgram(gl, this.progFlame);
    const pf = this.progFlame;
    uMat4(gl, pf, 'uVP', vp);
    u1(gl, pf, 'uTime', time);
    gl.bindVertexArray(this.flameVao);
    world.fires.forEach((f, i) => {
      if (f.hrr <= 1 || f.flameHeight < 0.05) return;
      uVec3(gl, pf, 'uBase', f.def.position);
      u1(gl, pf, 'uHeight', f.flameHeight);
      u1(gl, pf, 'uRadius', f.def.radius);
      u1(gl, pf, 'uFlameTemp', f.flameTemp);
      u1i(gl, pf, 'uFireSeed', i + 1);
      gl.drawElements(gl.TRIANGLES, 120, gl.UNSIGNED_SHORT, 0);
      this.drawCalls++;
    });

    // ---------------- Pass 3: 介质（烟/水雾） ----------------
    gl.disable(gl.DEPTH_TEST);
    // 把场景深度 renderbuffer blit 到可采样深度纹理
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.sceneFBO.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.depthBlitFBO);
    gl.blitFramebuffer(
      0, 0, this.canvas.width, this.canvas.height,
      0, 0, this.canvas.width, this.canvas.height,
      gl.DEPTH_BUFFER_BIT, gl.NEAREST,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mediumFBO.fbo);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    useProgram(gl, this.progMedium);
    const pm = this.progMedium;
    uTex(gl, pm, 'uRadiance', 0, this.sceneFBO.textures[0]);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.depthSampleTex);
    const dLoc = pm.uniforms.get('uDepth');
    if (dLoc) gl.uniform1i(dLoc, 1);
    uMat4(gl, pm, 'uInvVP', invVP);
    uVec3(gl, pm, 'uCamPos', cam.position);
    const s: SmokeState = world.smoke;
    u1(gl, pm, 'uInterfaceH', s.interfaceHeight);
    u1(gl, pm, 'uUpperT', s.upperTemp);
    u1(gl, pm, 'uLowerT', s.lowerTemp);
    u1(gl, pm, 'uUpperOD', s.upperOpticalDensity);
    u1(gl, pm, 'uLowerOD', s.lowerOpticalDensity);
    const mists = s.mists.slice(0, MAX_MIST);
    const mistData = new Float32Array(MAX_MIST * 4);
    const mistDens = new Float32Array(MAX_MIST);
    mists.forEach((m, i) => {
      mistData[i * 4] = m.position[0];
      mistData[i * 4 + 1] = m.position[1];
      mistData[i * 4 + 2] = m.position[2];
      mistData[i * 4 + 3] = m.radius;
      mistDens[i] = m.density;
    });
    const mLoc = pm.uniforms.get('uMists[0]');
    if (mLoc) gl.uniform4fv(mLoc, mistData);
    const dLoc2 = pm.uniforms.get('uMistDens[0]');
    if (dLoc2) gl.uniform1fv(dLoc2, mistDens);
    u1i(gl, pm, 'uMistCount', mists.length);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.drawCalls++;

    // ---------------- Pass 4: min/max 缩减 ----------------
    let srcTex = this.mediumFBO.textures[0];
    let srcW = this.canvas.width, srcH = this.canvas.height;
    useProgram(gl, this.progReduce);
    for (const fbo of this.reduceFBOs) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo);
      gl.viewport(0, 0, fbo.width, fbo.height);
      uTex(gl, this.progReduce, 'uSrc', 0, srcTex);
      u2(gl, this.progReduce, 'uTexel', 1 / srcW, 1 / srcH);
      gl.bindVertexArray(this.quadVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      srcTex = fbo.textures[0];
      srcW = fbo.width; srcH = fbo.height;
      this.drawCalls++;
    }
    // 最终 1x1 复制到量程纹理
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.rangeFBO);
    gl.viewport(0, 0, 1, 1);
    uTex(gl, this.progReduce, 'uSrc', 0, srcTex);
    u2(gl, this.progReduce, 'uTexel', 1, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 回读 1x1 min/max（每帧，仅 2 个 float，廉价）
    const mm = new Float32Array(2);
    gl.readPixels(0, 0, 1, 1, gl.RG, gl.FLOAT, mm);
    // 量程更新（锁定模式内部直接冻结 → 切换当帧即生效）
    this.range.update(mm[0], mm[1], settings.agcSensitivity);

    // ---------------- Pass 5: 调色板（输出到默认帧缓冲） ----------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    useProgram(gl, this.progPalette);
    const pp = this.progPalette;
    uTex(gl, pp, 'uRadiance', 0, this.mediumFBO.textures[0]);
    uTex(gl, pp, 'uRange', 1, this.rangeTex);
    u1i(gl, pp, 'uPalette', settings.palette === 'iron' ? 0 : 1);
    u1(gl, pp, 'uNoiseK', settings.noiseLevel);
    u1(gl, pp, 'uTime', time);
    u2(gl, pp, 'uResolution', this.canvas.width, this.canvas.height);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.drawCalls++;

    // ---------------- 回读：十字线温度 + 直方图（10Hz） ----------------
    this.readCenterAndHistogram(world, cam);

    // 统计
    const dtMs = performance.now() - t0;
    this.frameMsAvg = this.frameMsAvg * 0.92 + dtMs * 0.08;
    const now = performance.now();
    const fpsDt = (now - this.lastT) / 1000;
    if (fpsDt > 0.25) {
      this.fpsAvg = this.fpsAvg * 0.7 + (1 / fpsDt) * 0.3;
      this.lastT = now;
    }
    const rk = this.range.rangeKelvin;
    this.stats = {
      fps: this.fpsAvg,
      frameMs: this.frameMsAvg,
      drawCalls: this.drawCalls,
      crosshairK: this.crosshairK,
      crosshairObjectLabel: this.crosshairLabel,
      histogram: this.stats.histogram,
      rangeMinK: rk.minK,
      rangeMaxK: rk.maxK,
    };
  }

  /** 把最终辐射亮度降采样到 64×64 回读，中心纹素即十字线，整体生成直方图 */
  private readCenterAndHistogram(world: PhysicsWorld, cam: CameraState) {
    if (this.frameNo % 6 !== 0) return;
    const gl = this.gl;
    // 用纯复制 blit 保留真实辐射亮度（线性过滤由纹理 LINEAR 完成降采样）
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.histFBO);
    gl.viewport(0, 0, 64, 64);
    useProgram(gl, this.progBlit);
    uTex(gl, this.progBlit, 'uSrc', 0, this.mediumFBO.textures[0]);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const rgba = new Float32Array(64 * 64 * 4);
    gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.FLOAT, rgba);
    for (let i = 0; i < 64 * 64; i++) this.readbackBuf[i] = rgba[i * 4];
    // 中心纹素（RED 紧凑存储，每元素 1 float）
    const idx = 32 * 64 + 32;
    this.crosshairK = invPlanck10(this.readbackBuf[idx]);
    // 通过射线求物体标签
    this.crosshairLabel = this.labelAtCenter(world, cam);
    const compact = new Float32Array(64 * 64);
    compact.set(this.readbackBuf.subarray(0, 64 * 64));
    this.stats.histogram = buildHistogram(compact, 48);
    // 恢复默认帧缓冲，避免下一帧绘制泄漏进回读 FBO
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** 十字线射线与场景 AABB 求交，给出物体标签 */
  private labelAtCenter(world: PhysicsWorld, cam: CameraState): string {
    const dir: Vec3 = [
      Math.sin(cam.yaw) * Math.cos(cam.pitch),
      Math.sin(cam.pitch),
      Math.cos(cam.yaw) * Math.cos(cam.pitch),
    ];
    // 屏幕中心射线方向（右手系，yaw=0 朝 -z）
    dir[0] = -Math.sin(cam.yaw) * Math.cos(cam.pitch);
    dir[2] = -Math.cos(cam.yaw) * Math.cos(cam.pitch);
    let best: { t: number; label: string } | null = null;
    for (const o of world.objects) {
      const h = v3.scale(o.size, 0.5);
      const c = o.position;
      let tmin = 0, tmax = 40;
      let ok = true;
      for (let k = 0; k < 3; k++) {
        const d = dir[k];
        if (Math.abs(d) < 1e-9) {
          if (cam.position[k] < c[k] - h[k] || cam.position[k] > c[k] + h[k]) { ok = false; break; }
        } else {
          const t1 = (c[k] - h[k] - cam.position[k]) / d;
          const t2 = (c[k] + h[k] - cam.position[k]) / d;
          tmin = Math.max(tmin, Math.min(t1, t2));
          tmax = Math.min(tmax, Math.max(t1, t2));
          if (tmin > tmax) { ok = false; break; }
        }
      }
      if (ok && tmax > 0 && (!best || tmin < best.t)) best = { t: tmin, label: o.label };
    }
    return best?.label ?? '烟气/背景';
  }

  /** 回放恢复：替换墙面纹理与量程 */
  restoreHeat(shell: { surface: ShellSurfaceId; data: Float32Array }[]) {
    this.heatField.restore(shell);
  }

  /** 关键帧快照：读回六张墙面温度纹理 */
  readbackHeat() {
    return this.heatField.readback();
  }

  resetRange() {
    this.range.reset(this.scenario.ambientC + KELVIN);
  }

  get viewProj(): Mat4 { return m4.identity(); }
}
