import type { MaterialDef } from '../core/types';
import type { GpuMesh } from './meshStore';
import { createProgram, u1, u1i, uMat4, uVec4, useProgram } from './glUtils';
import { CUBE_FLAME_FS, CUBE_FS, CUBE_VS } from './shaders';
import { m4, v3, type Mat4, type Vec3 } from '../core/math';
import { planck10 } from './planck';

const CUBE_SIZE = 128;

/**
 * 每帧（或按间隔）从房间中心附近把场景简化重绘到立方体贴图：
 * 只写表面自身发射项 eps*planck(T)，主 Pass 再按菲涅耳混合反射。
 * 火焰也写入，使玻璃/金属能映出火光形成假热点。
 */
export class ReflectionProbe {
  private gl: WebGL2RenderingContext;
  cube: WebGLTexture;
  private fbo: WebGLFramebuffer;
  private rb: WebGLRenderbuffer;
  private progObj: ReturnType<typeof createProgram>;
  private progFlame: ReturnType<typeof createProgram>;
  private viewMats: Mat4[] = [];
  private proj: Mat4;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.cube = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.cube);
    for (let i = 0; i < 6; i++) {
      gl.texImage2D(
        gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, 0, gl.R16F,
        CUBE_SIZE, CUBE_SIZE, 0, gl.RED, gl.HALF_FLOAT, null,
      );
    }
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);

    this.fbo = gl.createFramebuffer()!;
    this.rb = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, CUBE_SIZE, CUBE_SIZE);

    this.progObj = createProgram(gl, CUBE_VS, CUBE_FS);
    this.progFlame = createProgram(gl, CUBE_VS, CUBE_FLAME_FS);
    this.proj = m4.perspective(Math.PI / 2, 1, 0.1, 60);
  }

  private buildViews(eye: Vec3) {
    const look = (center: Vec3, up: Vec3): Mat4 => {
      // 手写 lookAt
      const f = v3.norm(v3.sub(center, eye));
      const s = v3.norm(v3.cross(f, up));
      const u = v3.cross(s, f);
      const m = m4.identity();
      m[0] = s[0]; m[4] = s[1]; m[8] = s[2];
      m[1] = u[0]; m[5] = u[1]; m[9] = u[2];
      m[2] = -f[0]; m[6] = -f[1]; m[10] = -f[2];
      m[12] = -v3.dot(s, eye);
      m[13] = -v3.dot(u, eye);
      m[14] = v3.dot(f, eye);
      return m4.multiply(this.proj, m);
    };
    const [x, y, z] = eye;
    this.viewMats = [
      look([x + 1, y, z], [0, 1, 0]),
      look([x - 1, y, z], [0, 1, 0]),
      look([x, y + 1, z], [0, 0, -1]),
      look([x, y - 1, z], [0, 0, 1]),
      look([x, y, z + 1], [0, 1, 0]),
      look([x, y, z - 1], [0, 1, 0]),
    ];
  }

  render(
    eye: Vec3,
    meshes: GpuMesh[],
    objectTemps: Float32Array,
    materialTable: MaterialDef[],
    flameVao: WebGLVertexArrayObject,
    flameCount: number,
    flames: { base: Vec3; height: number; radius: number; temp: number }[],
    ambientL: number,
  ) {
    const gl = this.gl;
    this.buildViews(eye);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.rb);
    gl.viewport(0, 0, CUBE_SIZE, CUBE_SIZE);
    gl.enable(gl.DEPTH_TEST);
    // 背景（未被几何占据的方向）= 常温环境辐射
    gl.clearColor(ambientL, 0, 0, 1);

    // 材料表（发射率/金属度）
    const matData = new Float32Array(16 * 4);
    materialTable.forEach((m, i) => {
      matData[i * 4] = m.emissivity;
      matData[i * 4 + 1] = m.metallic;
    });

    for (let face = 0; face < 6; face++) {
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, this.cube, 0,
      );
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      // 物体
      useProgram(gl, this.progObj);
      const p = this.progObj;
      uMat4(gl, p, 'uMVP', this.viewMats[face]);
      const loc = p.uniforms.get('uMatTable[0]');
      if (loc) gl.uniform4fv(loc, matData);
      const tLoc = p.uniforms.get('uObjectTemp[0]');
      if (tLoc) gl.uniform1fv(tLoc, objectTemps);
      const ambLoc = p.uniforms.get('uAmbientL');
      if (ambLoc) gl.uniform1f(ambLoc, ambientL);
      for (const m of meshes) {
        u1i(gl, p, 'uObjectId', m.objectId);
        gl.bindVertexArray(m.vao);
        gl.drawElements(gl.TRIANGLES, m.indexCount, gl.UNSIGNED_INT, 0);
      }

      // 火焰（高发射代理，写辐射亮度供低 ε 表面反射）
      if (flameCount > 0) {
        useProgram(gl, this.progFlame);
        const pf = this.progFlame;
        uMat4(gl, pf, 'uMVP', this.viewMats[face]);
        const loc2 = pf.uniforms.get('uMatTable[0]');
        if (loc2) gl.uniform4fv(loc2, matData);
        const tLoc2 = pf.uniforms.get('uObjectTemp[0]');
        if (tLoc2) gl.uniform1fv(tLoc2, objectTemps);
        u1i(gl, pf, 'uFlameMode', 1);
        gl.bindVertexArray(flameVao);
        for (const f of flames) {
          if (f.height < 0.05) continue;
          uVec4(gl, pf, 'uBase', [f.base[0], f.base[1], f.base[2], 0]);
          u1(gl, pf, 'uHeight', f.height);
          u1(gl, pf, 'uRadius', f.radius);
          u1(gl, pf, 'uFlameL', planck10(f.temp));
          gl.drawElements(gl.TRIANGLES, 120, gl.UNSIGNED_SHORT, 0);
        }
        u1i(gl, pf, 'uFlameMode', 0);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
}
