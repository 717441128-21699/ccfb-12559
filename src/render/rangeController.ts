import { invPlanck10, planck10 } from './planck';
import { clamp, lerp } from '../core/math';

/**
 * 自动增益控制（AGC）量程状态机
 *
 * 关键训练需求（验收点 1）：
 * - auto：每帧用画面 min/max 连续自适应，火焰进入视野后极热像素把上限拉高，
 *   常温物体被压到调色板低端 → 一片黑；
 * - locked：切入选中瞬间冻结的辐射量程，之后同一物体的归一化亮度不再随
 *   视野内容变化；切换在同一帧内完成，无过渡动画。
 */
export class RangeController {
  mode: 'auto' | 'locked' = 'auto';
  /** 当前生效的辐射量程（归一化辐射亮度） */
  minL = planck10(285);
  maxL = planck10(315);
  /** 锁定时刻的备份 */
  private lockedMinL = this.minL;
  private lockedMaxL = this.maxL;
  /** 自动模式平滑系数（防止量程抖动） */
  private smooth = 0.12;

  reset(ambientK: number) {
    this.minL = planck10(ambientK - 3);
    this.maxL = planck10(ambientK + 25);
    this.lockedMinL = this.minL;
    this.lockedMaxL = this.maxL;
    this.mode = 'auto';
  }

  /**
   * 每帧更新
   * @param rawMin/rawMax 本帧画面辐射亮度的 min/max
   * @param sensitivity 灵敏度 0.1~2（越小量程越窄、对比度越高）
   */
  update(rawMin: number, rawMax: number, sensitivity: number) {
    if (this.mode === 'locked') {
      // 锁定：完全不随画面变化 —— 同一物体亮度恒定
      this.minL = this.lockedMinL;
      this.maxL = this.lockedMaxL;
      return;
    }
    // 自动：在 raw min/max 上按灵敏度收窄，并做时间平滑
    const span = Math.max(rawMax - rawMin, 1e-3);
    const pad = span * 0.08 * sensitivity;
    const targetMin = rawMin - pad;
    const targetMax = rawMax + pad;
    this.minL = lerp(this.minL, targetMin, this.smooth);
    this.maxL = lerp(this.maxL, targetMax, this.smooth);
    if (this.maxL - this.minL < 1e-3) this.maxL = this.minL + 1e-3;
  }

  /** 单帧切换到锁定（冻结当前量程） */
  lock() {
    this.mode = 'locked';
    this.lockedMinL = this.minL;
    this.lockedMaxL = this.maxL;
  }

  /** 单帧切回自动 */
  unlock() {
    this.mode = 'auto';
  }

  /** 锁定模式下手动调整量程（K），立即生效、无过渡 */
  setLockedKelvin(minK: number, maxK: number) {
    this.lockedMinL = planck10(minK);
    this.lockedMaxL = planck10(Math.max(maxK, minK + 1));
    if (this.mode === 'locked') {
      this.minL = this.lockedMinL;
      this.maxL = this.lockedMaxL;
    }
  }

  get rangeKelvin() {
    return { minK: invPlanck10(this.minL), maxK: invPlanck10(this.maxL) };
  }

  get lockedKelvin() {
    return { minK: invPlanck10(this.lockedMinL), maxK: invPlanck10(this.lockedMaxL) };
  }

  set lockedKelvin(v: { minK: number; maxK: number }) {
    this.setLockedKelvin(v.minK, v.maxK);
  }
}

export interface Histogram {
  bins: Uint16Array;
  binCount: number;
  minK: number;
  maxK: number;
}

/** 由降采样回读的辐射亮度数组构建温度直方图（设置界面显示用） */
export function buildHistogram(samples: Float32Array, binCount = 48): Histogram {
  const bins = new Uint16Array(binCount);
  let minK = Infinity, maxK = -Infinity;
  const kelvins = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const k = invPlanck10(samples[i]);
    kelvins[i] = k;
    if (k < minK) minK = k;
    if (k > maxK) maxK = k;
  }
  if (!isFinite(minK)) { minK = 280; maxK = 320; }
  const span = Math.max(maxK - minK, 1);
  for (let i = 0; i < kelvins.length; i++) {
    const b = clamp(Math.floor(((kelvins[i] - minK) / span) * binCount), 0, binCount - 1);
    bins[b]++;
  }
  return { bins, binCount, minK, maxK };
}
