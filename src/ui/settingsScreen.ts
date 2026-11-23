import type { TicSettings } from '../core/types';
import { kToC } from '../render/planck';
import { defaultSettings } from '../app/engine';

export class SettingsScreen {
  private host: Element;
  private settings: TicSettings;
  private onChange: (s: TicSettings) => void;

  constructor(host: Element, settings: TicSettings, onChange: (s: TicSettings) => void) {
    this.host = host;
    this.settings = { ...settings };
    this.onChange = onChange;
  }

  private row(label: string, input: string, valId: string, val: string): string {
    return `<div class="row"><label>${label}</label>${input}<span class="val" id="${valId}">${val}</span></div>`;
  }

  mount() {
    const s = this.settings;
    this.host.innerHTML = `
      <div class="settings-layout">
        <div class="panel">
          <h2>增益与量程（AGC）</h2>
          <div class="row">
            <label>增益模式</label>
            <div class="toggle" style="flex:1">
              <button id="gAuto" class="${s.gainMode === 'auto' ? 'on' : ''}">自动增益</button>
              <button id="gLock" class="${s.gainMode === 'locked' ? 'on' : ''}">锁定量程</button>
            </div>
          </div>
          ${this.row('AGC 灵敏度',
            `<input type="range" id="agc" min="0.2" max="2" step="0.1" value="${s.agcSensitivity}">`,
            'agcVal', `${s.agcSensitivity.toFixed(1)}×`)}
          <div class="muted">灵敏度越低，自动量程越窄、画面对比越强，但火焰出现时压黑效应也越明显。</div>

          <h3>锁定量程（手动，单位 ℃）</h3>
          ${this.row('量程下限',
            `<input type="range" id="lmin" min="-10" max="200" step="1" value="${kToC(s.lockedMin).toFixed(0)}">`,
            'lminVal', `${kToC(s.lockedMin).toFixed(0)} ℃`)}
          ${this.row('量程上限',
            `<input type="range" id="lmax" min="20" max="600" step="5" value="${kToC(s.lockedMax).toFixed(0)}">`,
            'lmaxVal', `${kToC(s.lockedMax).toFixed(0)} ℃`)}
          <div class="muted">锁定模式下调整立即生效且无过渡；读数训练建议量程 20–80℃，观察轰燃前兆切换到 20–500℃。</div>

          <h3>调色板</h3>
          <div class="toggle">
            <button id="palIron" class="${s.palette === 'iron' ? 'on' : ''}">铁红 Ironbow</button>
            <button id="palWhite" class="${s.palette === 'whitehot' ? 'on' : ''}">白热 White-Hot</button>
          </div>
        </div>

        <div class="panel">
          <h2>传感器与光学</h2>
          ${this.row('等效噪声温差',
            `<input type="range" id="noise" min="0" max="2" step="0.1" value="${s.noiseLevel}">`,
            'noiseVal', `${s.noiseLevel.toFixed(1)} K`)}
          <div class="muted">模拟非制冷微测辐射热计的 NETD，噪声在温度域叠加后再映射亮度。</div>
          ${this.row('竖直视场角',
            `<input type="range" id="fov" min="25" max="70" step="1" value="${s.fovY}">`,
            'fovVal', `${s.fovY}°`)}
          ${this.row('反射探针刷新',
            `<input type="range" id="refl" min="0" max="10" step="1" value="${s.reflectionInterval}">`,
            'reflVal', s.reflectionInterval === 0 ? '每帧' : `每 ${s.reflectionInterval} 帧`)}
          <div class="muted">玻璃/金属表面的假热点来自环境立方体贴图；降低刷新频率可提升帧率。</div>

          <h3>性能（保证搜索过程 ≥30fps）</h3>
          ${this.row('渲染分辨率',
            `<input type="range" id="scale" min="0.6" max="1" step="0.05" value="${s.renderScale}">`,
            'scaleVal', `${Math.round(s.renderScale * 100)}%`)}
          <div class="muted">运行中若帧率持续低于 28fps，会自动以 10% 步进降分辨率保帧率。</div>

          <h3>当前画面温度直方图</h3>
          <div class="hist" id="hist"></div>
          <div class="muted" id="histMeta">进入「队员搜索」后每 100ms 刷新一次。</div>

          <div style="margin-top:16px; display:flex; gap:10px;">
            <button class="primary" id="apply">应用设置</button>
            <button id="default">恢复默认</button>
          </div>
        </div>
      </div>`;

    const bindRange = (id: string, valId: string, fmt: (v: number) => string, key: keyof TicSettings) => {
      const el = this.host.querySelector<HTMLInputElement>(`#${id}`)!;
      el.addEventListener('input', () => {
        const v = Number(el.value);
        (this.settings[key] as number) = v;
        this.host.querySelector(`#${valId}`)!.textContent = fmt(v);
        this.emit();
      });
    };
    bindRange('agc', 'agcVal', (v) => `${v.toFixed(1)}×`, 'agcSensitivity');
    bindRange('noise', 'noiseVal', (v) => `${v.toFixed(1)} K`, 'noiseLevel');
    bindRange('fov', 'fovVal', (v) => `${v}°`, 'fovY');
    bindRange('refl', 'reflVal', (v) => (v === 0 ? '每帧' : `每 ${v} 帧`), 'reflectionInterval');
    bindRange('scale', 'scaleVal', (v) => `${Math.round(v * 100)}%`, 'renderScale');

    const lmin = this.host.querySelector<HTMLInputElement>('#lmin')!;
    const lmax = this.host.querySelector<HTMLInputElement>('#lmax')!;
    const syncLock = () => {
      this.settings.lockedMin = Number(lmin.value) + 273.15;
      this.settings.lockedMax = Number(lmax.value) + 273.15;
      this.host.querySelector('#lminVal')!.textContent = `${lmin.value} ℃`;
      this.host.querySelector('#lmaxVal')!.textContent = `${lmax.value} ℃`;
      this.emit();
    };
    lmin.addEventListener('input', syncLock);
    lmax.addEventListener('input', syncLock);

    const toggle = (id: string, patch: Partial<TicSettings>, on: () => void) => {
      this.host.querySelector(`#${id}`)!.addEventListener('click', () => {
        Object.assign(this.settings, patch);
        on();
        this.emit();
      });
    };
    const refreshGainBtns = () => {
      this.host.querySelector('#gAuto')!.classList.toggle('on', this.settings.gainMode === 'auto');
      this.host.querySelector('#gLock')!.classList.toggle('on', this.settings.gainMode === 'locked');
    };
    toggle('gAuto', { gainMode: 'auto' }, refreshGainBtns);
    toggle('gLock', { gainMode: 'locked' }, refreshGainBtns);
    const refreshPal = () => {
      this.host.querySelector('#palIron')!.classList.toggle('on', this.settings.palette === 'iron');
      this.host.querySelector('#palWhite')!.classList.toggle('on', this.settings.palette === 'whitehot');
    };
    toggle('palIron', { palette: 'iron' }, refreshPal);
    toggle('palWhite', { palette: 'whitehot' }, refreshPal);

    this.host.querySelector('#default')!.addEventListener('click', () => {
      this.settings = defaultSettings();
      this.onChange(this.settings);
      this.mount();
    });
    this.host.querySelector('#apply')!.addEventListener('click', () => this.emit());

    // 直方图由外部引擎通过 setHistogram 推入
    this.pendingHist?.();
  }

  private pendingHist: (() => void) | null = null;
  setHistogram(bins: Uint16Array, minK: number, maxK: number) {
    this.pendingHist = () => {
      const box = this.host.querySelector('#hist');
      if (!box) return;
      const max = Math.max(1, ...bins);
      box.innerHTML = Array.from(bins)
        .map((b) => `<div class="bar" style="height:${(b / max) * 100}%"></div>`).join('');
      this.host.querySelector('#histMeta')!.textContent =
        `温度区间 ${kToC(minK).toFixed(0)}℃ ~ ${kToC(maxK).toFixed(0)}℃，共 ${bins.length} 档`;
    };
    this.pendingHist();
  }

  private emit() {
    this.onChange({ ...this.settings });
  }
}
