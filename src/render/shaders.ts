// 所有 GLSL ES 3.00 着色器源码集中管理，便于审查物理模型
// 普朗克公式在 8–14µm 波段用归一化系数（与 TS 端 planck.ts 标定一致）

const PLANCK_GLSL = /* glsl */ `
// 10µm 处单色辐射亮度，以 300K 为参考归一化（任意线性单位）
float planck10(float T) {
  float x = 1.4387769e-2 / (1.0e-5 * T);
  float b = 1.0 / (exp(x) - 1.0);
  float x300 = 1.4387769e-2 / (1.0e-5 * 300.0);
  float b300 = 1.0 / (exp(x300) - 1.0);
  return b / b300;
}
// 逆普朗克：由辐射亮度反推亮度温度（十字线读数用）
float invPlanck10(float b) {
  float x300 = 1.4387769e-2 / (1.0e-5 * 300.0);
  float b300 = 1.0 / (exp(x300) - 1.0);
  float bn = max(b * b300, 1e-7);
  float x = log(1.0 + 1.0 / bn);
  return 1.4387769e-2 / (1.0e-5 * x);
}
// Schlick 菲涅耳：f0 为垂直入射反射率，掠射角趋近 1
float fresnelReflect(float f0, float cosTheta) {
  return f0 + (1.0 - f0) * pow(1.0 - max(cosTheta, 0.0), 5.0);
}
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
`;

// ============================================================ 场景几何 Pass（MRT）
export const SCENE_VS = /* glsl */ `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
layout(location=3) in float aMatSlot;
uniform mat4 uVP;
out vec3 vWorld;
out vec3 vNormal;
out vec2 vUV;
flat out int vMatSlot;
void main() {
  vWorld = aPos;
  vNormal = normalize(aNormal);
  vUV = aUV;
  vMatSlot = int(aMatSlot + 0.5);
  gl_Position = uVP * vec4(aPos, 1.0);
}`;

/**
 * MRT 输出：
 * 0: r=辐射亮度(归一化) g=表面温度K b=发射率 a=物体ID+0.5（火焰为 -1）
 * 1: r/g/b=世界坐标 a=当前片段菲涅耳反射率
 * 2: r=壳面ID g/b=壳UV a=是否墙面
 */
export const SCENE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in vec2 vUV;
flat in int vMatSlot;
uniform vec3 uCamPos;
uniform sampler2D uShell0;
uniform sampler2D uShell1;
uniform sampler2D uShell2;
uniform sampler2D uShell3;
uniform sampler2D uShell4;
uniform sampler2D uShell5;
uniform samplerCube uEnvMap;      // 环境热辐射立方体贴图（假热点来源）
uniform int uIsWall;
uniform int uObjectId;
uniform int uShellId;
uniform vec4 uShellRect;          // 该墙面在壳纹理上的 UV 矩形
uniform vec4 uMatTable[16];       // x=发射率 y=金属度
uniform float uObjectTemp[96];    // 集总物体温度（按 objectId 索引）
uniform int uObjectCount;
layout(location=0) out vec4 oRadiance;
layout(location=1) out vec4 oWorld;
layout(location=2) out vec4 oShell;
${PLANCK_GLSL}
// 常量索引 if 链：ES3.00 片元采样器不能动态索引；所有分支都被静态引用，编译器不会消除采样器
float sampleShell(int id, vec2 suv) {
  if (id == 0) return texture(uShell0, suv).r;
  if (id == 1) return texture(uShell1, suv).r;
  if (id == 2) return texture(uShell2, suv).r;
  if (id == 3) return texture(uShell3, suv).r;
  if (id == 4) return texture(uShell4, suv).r;
  return texture(uShell5, suv).r;
}
void main() {
  vec4 mat = uMatTable[vMatSlot];
  float emissivity = clamp(mat.x, 0.02, 0.99);
  float metallic = mat.y;

  float T;
  if (uIsWall == 1) {
    vec2 suv = mix(uShellRect.xy, uShellRect.zw, vUV);
    T = sampleShell(uShellId, suv);
  } else {
    int idx = min(uObjectId, uObjectCount - 1);
    T = uObjectTemp[idx];
  }

  vec3 n = normalize(vNormal);
  vec3 v = normalize(uCamPos - vWorld);
  float cosT = max(dot(n, v), 0.0);
  float Lself = planck10(T);

  // 反射：玻璃/金属低发射率，把环境立方体贴图里的热区映成假热点。
  // 能量守恒：自身发射占 emissivity，其余 (1-emissivity) 在镜面/漫反射间分配。
  vec3 reflDir = reflect(-v, n);
  float LenvSpec = texture(uEnvMap, reflDir).r;
  float LenvDiff = texture(uEnvMap, n).r;
  float f0 = 1.0 - emissivity;
  float Fr = mix(fresnelReflect(f0, cosT), f0, metallic * 0.6);
  Fr = clamp(Fr, 0.0, 1.0 - emissivity);
  float specW = Fr;                                   // 镜面反射权重
  float diffW = (1.0 - emissivity) - specW;           // 漫反射权重（非金属为主）
  float Lout = emissivity * Lself + specW * LenvSpec + diffW * LenvDiff;

  oRadiance = vec4(Lout, T, emissivity, float(uObjectId) + 0.5);
  oWorld = vec4(vWorld, Fr);
  oShell = vec4(float(uShellId), mix(uShellRect.xy, uShellRect.zw, vUV), float(uIsWall));
}`;

// ============================================================ 火焰 Pass（圆锥代理 + 噪声裁剪）
export const FLAME_VS = /* glsl */ `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uVP;
uniform vec3 uBase;
uniform float uHeight;
uniform float uRadius;
out vec3 vLocal;
void main() {
  vLocal = aPos;
  vec3 p = uBase + vec3(aPos.x * uRadius, aPos.y * uHeight, aPos.z * uRadius);
  gl_Position = uVP * vec4(p, 1.0);
}`;

export const FLAME_FS = /* glsl */ `#version 300 es
precision highp float;
in vec3 vLocal;
uniform float uTime;
uniform float uFlameTemp;
uniform int uFireSeed;
layout(location=0) out vec4 oRadiance;
layout(location=1) out vec4 oWorld;
layout(location=2) out vec4 oShell;
${PLANCK_GLSL}
void main() {
  float h = clamp(vLocal.y, 0.0, 1.0);
  float ang = atan(vLocal.z, vLocal.x);
  float n = hash21(vec2(ang * 3.0 + float(uFireSeed), h * 8.0 - uTime * 4.0));
  float n2 = hash21(vec2(ang * 7.0 - float(uFireSeed), h * 13.0 - uTime * 6.5));
  float r = length(vLocal.xz);
  float taper = 1.0 - h * 0.75;
  float edge = taper * (0.75 + 0.35 * n);
  float alpha = smoothstep(edge, edge - 0.28, r) * smoothstep(1.02, 0.82, h);
  if (alpha < 0.02) discard;
  float T = mix(uFlameTemp, uFlameTemp * 0.62, h) + (n2 - 0.5) * 60.0;
  float L = planck10(T) * (0.85 + 0.3 * n);
  oRadiance = vec4(L, T, 1.0, -1.0); // a=-1 标记火焰
  oWorld = vec4(0.0, 0.0, 0.0, 1.0);
  oShell = vec4(-1.0, 0.0, 0.0, 0.0);
}`;

// ============================================================ 介质 Pass（烟 + 水雾，屏幕空间深度重建）
export const QUAD_VS = /* glsl */ `#version 300 es
layout(location=0) in vec2 aQuad;
out vec2 vUV;
void main() { vUV = aQuad * 0.5 + 0.5; gl_Position = vec4(aQuad, 0.0, 1.0); }`;

export const MEDIUM_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uRadiance;
uniform sampler2D uDepth;
uniform mat4 uInvVP;
uniform vec3 uCamPos;
uniform float uInterfaceH;
uniform float uUpperT;
uniform float uLowerT;
uniform float uUpperOD;
uniform float uLowerOD;
uniform vec4 uMists[8];    // xyz=中心 w=半径
uniform float uMistDens[8];
uniform int uMistCount;
layout(location=0) out vec4 oRadiance;
layout(location=1) out vec4 oWorld;
layout(location=2) out vec4 oShell;
${PLANCK_GLSL}
vec3 reconstructWorld(float depth, vec2 uv) {
  vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 w = uInvVP * ndc;
  return w.xyz / w.w;
}
void main() {
  vec4 src = texture(uRadiance, vUV);
  float depth = texture(uDepth, vUV).r;
  vec3 world = reconstructWorld(depth, vUV);
  vec3 ray = world - uCamPos;
  float dist = length(ray);
  vec3 dir = ray / max(dist, 1e-4);

  // ---- 双区烟气层：LWIR 消光系数取可见光的 0.25（薄烟可穿透）----
  float trans = 1.0;
  float Lemit = 0.0;
  bool camAbove = uCamPos.y > uInterfaceH;
  float od;
  float gasT;
  if ((camAbove && world.y > uInterfaceH) || (!camAbove && world.y < uInterfaceH)) {
    // 全程在同一层
    od = (camAbove ? uUpperOD : uLowerOD) * 0.25 * dist;
    gasT = camAbove ? uUpperT : uLowerT;
  } else {
    // 跨层：求射线与界面平面 y=uInterfaceH 的参数 t
    float tCross = (uInterfaceH - uCamPos.y) / dir.y;
    tCross = clamp(tCross, 0.0, dist);
    float dUpper = camAbove ? tCross : (dist - tCross);
    float dLower = camAbove ? (dist - tCross) : tCross;
    od = 0.25 * (uUpperOD * dUpper + uLowerOD * dLower);
    gasT = (uUpperT * dUpper + uLowerT * dLower) / max(dist, 1e-4);
  }
  float tau = exp(-od);
  Lemit += (1.0 - tau) * planck10(gasT);
  trans *= tau;

  // ---- 水雾：水滴粒径与 10µm 波长相当，LWIR 强遮挡 ----
  for (int i = 0; i < 8; i++) {
    if (i >= uMistCount) break;
    vec4 mp = uMists[i];
    vec3 oc = uCamPos - mp.xyz;
    float tb = clamp(-dot(oc, dir), 0.0, dist);
    float closest = length(oc + dir * tb);
    if (closest < mp.w) {
      float chord = 2.0 * sqrt(max(0.0, mp.w * mp.w - closest * closest));
      float secLen = min(chord, dist);
      float tauM = exp(-uMistDens[i] * 2.2 * secLen);
      Lemit = Lemit * tauM + (1.0 - tauM) * planck10(max(290.0, uLowerT - 4.0));
      trans *= tauM;
    }
  }

  float Lout = src.r * trans + Lemit;
  oRadiance = vec4(Lout, src.g, src.b, src.a);
  oWorld = vec4(world, 0.0);
  oShell = vec4(0.0, 0.0, 0.0, 0.0);
}`;

// ============================================================ 降采样 min/max（AGC 量程缩减）
export const REDUCE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uSrc;
uniform vec2 uTexel;
out vec4 oMinMax; // r=min g=max
void main() {
  float lo = 1e9, hi = -1e9;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 uv = vUV + vec2(float(x), float(y)) * uTexel;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) continue;
      float v = texture(uSrc, uv).r;
      lo = min(lo, v); hi = max(hi, v);
    }
  }
  oMinMax = vec4(lo, hi, 0.0, 0.0);
}`;

// 纯复制降采样（线性），用于十字线读数与直方图：保留真实辐射亮度而非 min/max
export const BLIT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uSrc;
out vec4 oOut;
void main() { oOut = vec4(texture(uSrc, vUV).r, 0.0, 0.0, 1.0); }
`;

// ============================================================ 调色板 Pass（AGC 映射 + 铁红/白热 + 噪声 + 十字线）
export const PALETTE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uRadiance;
uniform sampler2D uRange;
uniform int uPalette;           // 0=铁红 1=白热
uniform float uNoiseK;
uniform float uTime;
uniform vec2 uResolution;
out vec4 oColor;
${PLANCK_GLSL}
vec3 ironbow(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c;
  c.r = smoothstep(0.15, 0.95, t) + (1.0 - smoothstep(0.0, 0.35, t)) * 0.18;
  c.g = smoothstep(0.45, 0.85, t) * 0.85 + smoothstep(0.9, 1.0, t) * 0.15;
  c.b = smoothstep(0.72, 1.0, t);
  return c;
}
void main() {
  vec4 src = texture(uRadiance, vUV);
  vec2 range = texture(uRange, vec2(0.5)).rg;
  float lo = range.r, hi = max(range.g, range.r + 1e-4);

  // 传感器噪声在温度域叠加，再转回辐射域
  float Tb = invPlanck10(src.r);
  float n = (hash21(gl_FragCoord.xy + fract(uTime) * 17.0) - 0.5) * uNoiseK;
  float L = planck10(Tb + n);

  float t = clamp((L - lo) / (hi - lo), 0.0, 1.0);
  t = pow(t, 0.9);
  vec3 col = uPalette == 0 ? ironbow(t) : vec3(t);

  // 十字线（屏幕中心，中心留缺口）
  vec2 px = vUV * uResolution;
  vec2 center = uResolution * 0.5;
  float lineW = 1.2;
  bool hLine = abs(px.y - center.y) < lineW && abs(px.x - center.x) < 40.0;
  bool vLine = abs(px.x - center.x) < lineW && abs(px.y - center.y) < 40.0;
  bool gap = abs(px.x - center.x) < 6.0 && abs(px.y - center.y) < 6.0;
  if ((hLine || vLine) && !gap) {
    col = mix(col, uPalette == 0 ? vec3(0.9, 0.95, 1.0) : vec3(0.1), 0.75);
  }
  oColor = vec4(col, 1.0);
}`;

// ============================================================ 墙面 GPU 热扩散（ping-pong，10Hz）
export const HEAT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uPrev;
uniform vec2 uTexel;
uniform float uDt;
uniform float uAmbient;
uniform float uAlpha;
uniform float uHeatCapacity;  // 单位面积热容 J/(m²·K)
uniform vec4 uFires[6];       // xyz=中心 w=半径
uniform vec4 uFireParams[6];  // x=HRR(kW) y=火焰高度 z=火焰温度
uniform int uFireCount;
uniform vec3 uSurfaceNormal;
uniform vec3 uSurfaceOrigin;
uniform vec3 uSurfaceBasis;   // 局部平面 u 轴的世界方向，v 轴 = normal × basis
uniform vec2 uSurfaceSize;
uniform float uUpperT;
uniform float uInterfaceH;
uniform float uEmissivity;
out vec4 oTemp;
void main() {
  float T = texture(uPrev, vUV).r;
  float tl = texture(uPrev, vUV + vec2(-uTexel.x, 0)).r;
  float tr = texture(uPrev, vUV + vec2(uTexel.x, 0)).r;
  float tu = texture(uPrev, vUV + vec2(0, uTexel.y)).r;
  float td = texture(uPrev, vUV + vec2(0, -uTexel.y)).r;
  float lap = tl + tr + tu + td - 4.0 * T;
  // 纹素物理间距（米）：扩散项按真实 dx 标定
  vec2 dxM = uTexel * uSurfaceSize;
  float dT = uAlpha * uDt * lap / max(dxM.x * dxM.y, 1e-8);

  // 纹素世界坐标：origin 沿切向基展开到真实墙面
  vec3 worldP = uSurfaceOrigin
    + uSurfaceBasis * (vUV.x * uSurfaceSize.x)
    + cross(normalize(uSurfaceNormal), uSurfaceBasis) * (vUV.y * uSurfaceSize.y);
  float gasT = worldP.y > uInterfaceH ? uUpperT : uAmbient;
  float hConv = worldP.y > uInterfaceH ? 18.0 : 6.0;
  dT += uDt * hConv * (gasT - T) / uHeatCapacity;

  for (int i = 0; i < 6; i++) {
    if (i >= uFireCount) break;
    vec3 fp = uFires[i].xyz + vec3(0.0, uFireParams[i].y * 0.5, 0.0);
    vec3 toF = fp - worldP;
    float r2 = max(dot(toF, toF), 0.36);
    float cosI = max(dot(normalize(toF), normalize(uSurfaceNormal)), 0.0);
    float flux = (uFireParams[i].x * 0.3 * 1000.0) / (3.14159 * r2);
    dT += uDt * uEmissivity * flux * cosI / uHeatCapacity;
  }
  dT += uDt * 8.0 * (uAmbient - T) / uHeatCapacity;
  oTemp = vec4(clamp(T + dT, uAmbient - 2.0, 900.0), 0.0, 0.0, 1.0);
}`;

// ============================================================ 环境立方体贴图 Pass（反射假热点数据源）
export const CUBE_VS = /* glsl */ `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=3) in float aMatSlot;
uniform mat4 uMVP;
uniform vec3 uBase;
uniform float uHeight;
uniform float uRadius;
uniform int uFlameMode;
uniform float uObjectTemp[96];
uniform int uObjectId;
out float vTemp;
flat out int vMatSlot;
void main() {
  vMatSlot = int(aMatSlot + 0.5);
  if (uFlameMode == 1) {
    // 火焰代理：单位圆柱缩放
    vec3 p = uBase + vec3(aPos.x * uRadius, aPos.y * uHeight, aPos.z * uRadius);
    vTemp = 900.0;
    gl_Position = uMVP * vec4(p, 1.0);
  } else {
    vTemp = uObjectTemp[min(uObjectId, 95)];
    gl_Position = uMVP * vec4(aPos, 1.0);
  }
}`;

export const CUBE_FS = /* glsl */ `#version 300 es
precision highp float;
in float vTemp;
flat in int vMatSlot;
uniform vec4 uMatTable[16];
uniform float uAmbientL;   // 环境（常温空气/墙面）的普朗克辐射基准
out vec4 oColor;
${PLANCK_GLSL}
void main() {
  float eps = uMatTable[vMatSlot].x;
  // 立方体贴图存“该方向看到的出射辐射”：表面自身发射 + 反射的环境基准
  float selfL = planck10(vTemp) * eps;
  float reflL = uAmbientL * (1.0 - eps);
  oColor = vec4(selfL + reflL, 0.0, 0.0, 1.0);
}`;

// 火焰专用立方体 Pass（火焰需要进入反射，制造玻璃上的火光镜像）
export const CUBE_FLAME_FS = /* glsl */ `#version 300 es
precision highp float;
in float vTemp;
flat in int vMatSlot;
uniform vec4 uMatTable[16];
uniform float uFlameL;
out vec4 oColor;
${PLANCK_GLSL}
void main() {
  // 火焰作为强辐射源进入反射，制造玻璃/金属上的火光镜像
  oColor = vec4(max(uFlameL, planck10(vTemp)), 0.0, 0.0, 1.0);
}`;
