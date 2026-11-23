// WebGL2 底层工具：着色器编译、程序链接、VAO/纹理/帧缓冲封装
export interface GLProgram {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
  attribs: Map<string, number>;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`着色器编译失败:\n${log}\n--- 源码 ---\n${src}`);
  }
  return sh;
}

export function createProgram(gl: WebGL2RenderingContext, vs: string, fs: string): GLProgram {
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  const program = gl.createProgram()!;
  gl.attachShader(program, v);
  gl.attachShader(program, f);
  gl.linkProgram(program);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`程序链接失败: ${gl.getProgramInfoLog(program)}`);
  }
  const uniforms = new Map<string, WebGLUniformLocation | null>();
  const attribs = new Map<string, number>();
  const nu = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < nu; i++) {
    const info = gl.getActiveUniform(program, i)!;
    uniforms.set(info.name.replace(/\[0\]$/, ''), gl.getUniformLocation(program, info.name));
  }
  const na = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES) as number;
  for (let i = 0; i < na; i++) {
    const info = gl.getActiveAttrib(program, i)!;
    attribs.set(info.name, gl.getAttribLocation(program, info.name));
  }
  return { program, uniforms, attribs };
}

export function useProgram(gl: WebGL2RenderingContext, p: GLProgram) {
  gl.useProgram(p.program);
}

export function u1(gl: WebGL2RenderingContext, p: GLProgram, name: string, x: number) {
  const loc = p.uniforms.get(name);
  if (loc) gl.uniform1f(loc, x);
}
/** int / bool 类型 uniform 必须用 uniform1i，否则 ANGLE 报 INVALID_OPERATION */
export function u1i(gl: WebGL2RenderingContext, p: GLProgram, name: string, x: number) {
  const loc = p.uniforms.get(name);
  if (loc) gl.uniform1i(loc, x | 0);
}
export function u2(gl: WebGL2RenderingContext, p: GLProgram, name: string, x: number, y: number) {
  const loc = p.uniforms.get(name);
  if (loc) gl.uniform2f(loc, x, y);
}
export function u3(gl: WebGL2RenderingContext, p: GLProgram, name: string, x: number, y: number, z: number) {
  const loc = p.uniforms.get(name);
  if (loc) gl.uniform3f(loc, x, y, z);
}
export function u4(gl: WebGL2RenderingContext, p: GLProgram, name: string, x: number, y: number, z: number, w: number) {
  const loc = p.uniforms.get(name);
  if (loc) gl.uniform4f(loc, x, y, z, w);
}
export function uMat4(gl: WebGL2RenderingContext, p: GLProgram, name: string, m: Float32Array) {
  const loc = p.uniforms.get(name);
  if (loc) gl.uniformMatrix4fv(loc, false, m);
}
export function uVec3(gl: WebGL2RenderingContext, p: GLProgram, name: string, v: ArrayLike<number>) {
  const loc = p.uniforms.get(name);
  if (loc) gl.uniform3fv(loc, v as Float32Array);
}
export function uVec2(gl: WebGL2RenderingContext, p: GLProgram, name: string, v: ArrayLike<number>) {
  const loc = p.uniforms.get(name);
  if (loc) gl.uniform2fv(loc, v as Float32Array);
}
export function uVec4(gl: WebGL2RenderingContext, p: GLProgram, name: string, v: ArrayLike<number>) {
  const loc = p.uniforms.get(name);
  if (loc) gl.uniform4fv(loc, v as Float32Array);
}
export function uTex(gl: WebGL2RenderingContext, p: GLProgram, name: string, unit: number, tex: WebGLTexture) {
  const loc = p.uniforms.get(name);
  if (loc) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }
}
export function uCube(gl: WebGL2RenderingContext, p: GLProgram, name: string, unit: number, tex: WebGLTexture) {
  const loc = p.uniforms.get(name);
  if (loc) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);
    gl.uniform1i(loc, unit);
  }
}

export interface TextureSpec {
  width: number;
  height: number;
  internal: number;   // gl.RG32F / gl.RGBA16F / gl.R8 ...
  format: number;
  type: number;
  filter?: number;
  wrap?: number;
  data?: ArrayBufferView | null;
}

export function createTexture2D(gl: WebGL2RenderingContext, spec: TextureSpec): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D, 0, spec.internal, spec.width, spec.height, 0,
    spec.format, spec.type, spec.data ?? null,
  );
  const filter = spec.filter ?? gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  const wrap = spec.wrap ?? gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  return tex;
}

export interface FBO {
  fbo: WebGLFramebuffer;
  textures: WebGLTexture[];
  depthTexture: WebGLTexture | null;
  width: number;
  height: number;
}

export function createFBO(
  gl: WebGL2RenderingContext,
  width: number, height: number,
  specs: TextureSpec[],
  depth: boolean | 'texture' = true,
): FBO {
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  const textures = specs.map((spec) => {
    const tex = createTexture2D(gl, { ...spec, width, height });
    return tex;
  });
  const bufs: number[] = [];
  textures.forEach((tex, i) => {
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, 0,
    );
    bufs.push(gl.COLOR_ATTACHMENT0 + i);
  });
  let depthTexture: WebGLTexture | null = null;
  if (depth === 'texture') {
    depthTexture = createTexture2D(gl, {
      width, height,
      internal: gl.DEPTH_COMPONENT24, format: gl.DEPTH_COMPONENT, type: gl.UNSIGNED_INT,
    });
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTexture, 0);
  } else if (depth) {
    const rb = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
    // 验证深度附件类型
    const att = gl.getFramebufferAttachmentParameter(
      gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE);
    if (att !== gl.RENDERBUFFER) {
      throw new Error(`深度 renderbuffer 附加失败，附件类型=0x${att.toString(16)}`);
    }
  }
  gl.drawBuffers(bufs);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`帧缓冲不完整: 0x${status.toString(16)}（浮点纹理可能需要 EXT_color_buffer_float）`);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, textures, depthTexture, width, height };
}

/** 全屏三角形（不用四边形，省一次裁剪） */
export function createFullscreenVAO(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}

export function checkFBOColorFloat(gl: WebGL2RenderingContext): boolean {
  const ext = gl.getExtension('EXT_color_buffer_float');
  return !!ext;
}
