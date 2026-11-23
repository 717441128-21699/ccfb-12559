import type { Mesh } from '../sim/geometry';
import { STRIDE } from '../sim/geometry';

/** 一个上传到 GPU 的网格包，记录绘制参数与回读用的物体映射 */
export interface GpuMesh {
  vao: WebGLVertexArrayObject;
  indexCount: number;
  objectId: number;
  materialSlot: number;
  isWall: boolean;
}

export class MeshStore {
  private gl: WebGL2RenderingContext;
  meshes: GpuMesh[] = [];

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  upload(mesh: Mesh): GpuMesh {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);

    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
    const stride = STRIDE * 4;
    // location 0: pos(3) 1: normal(3) 2: uv(2) 3: matSlot(1)
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 3 * 4);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 6 * 4);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 8 * 4);

    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

    gl.bindVertexArray(null);
    const gpu: GpuMesh = {
      vao,
      indexCount: mesh.indices.length,
      objectId: mesh.objectId,
      materialSlot: mesh.materialSlot,
      isWall: mesh.isWall,
    };
    this.meshes.push(gpu);
    return gpu;
  }

  uploadAll(meshes: Mesh[]): GpuMesh[] {
    return meshes.map((m) => this.upload(m));
  }

  dispose() {
    for (const m of this.meshes) this.gl.deleteVertexArray(m.vao);
    this.meshes.length = 0;
  }
}

/** 火焰圆锥代理网格（局部坐标：半径 1、高 1，y∈[0,1]） */
export function buildFlameCone(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
  const seg = 20;
  const verts: number[] = [];
  const idx: number[] = [];
  // 侧面
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const x = Math.cos(a), z = Math.sin(a);
    // 底环
    verts.push(x, 0, z, x, 0, z, 0, 0, 0);
    // 顶环（收窄）
    verts.push(x * 0.25, 1, z * 0.25, x * 0.25, 1, z * 0.25, 0, 1, 0);
  }
  for (let i = 0; i < seg; i++) {
    const b0 = i * 6, t0 = b0 + 3;
    const b1 = (i + 1) * 6, t1 = b1 + 3;
    idx.push(b0, b1, t1, b0, t1, t0);
  }
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 9 * 4, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 9 * 4, 3 * 4);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 9 * 4, 6 * 4);
  gl.vertexAttrib1f(3, 0);
  const ibo = gl.createBuffer()!;
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return vao;
}
