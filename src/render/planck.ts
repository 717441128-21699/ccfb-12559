// 与 GLSL planck10/invPlanck10 完全同系数的 CPU 版本
// 10µm 单色辐射亮度，以 300K 为参考归一化
const C2 = 1.4387769e-2;
const LAMBDA = 1.0e-5;
const X300 = C2 / (LAMBDA * 300);
const B300 = 1 / (Math.exp(X300) - 1);

export function planck10(T: number): number {
  const x = C2 / (LAMBDA * T);
  const b = 1 / (Math.exp(x) - 1);
  return b / B300;
}

export function invPlanck10(b: number): number {
  const bn = Math.max(b * B300, 1e-7);
  const x = Math.log(1 + 1 / bn);
  return C2 / (LAMBDA * x);
}

/** 摄氏温度显示 */
export const kToC = (k: number) => k - 273.15;
export const cToK = (c: number) => c + 273.15;
