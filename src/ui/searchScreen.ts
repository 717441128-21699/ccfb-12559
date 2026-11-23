import type { ScenarioDef, TicSettings } from '../core/types';
import { SimulationEngine } from '../app/engine';
import { kToC } from '../render/planck';
import type { RenderStats } from '../render/thermalRenderer';
import type { TrainingRecord } from '../app/recorder';

interface Callbacks {
  onSettingsChange: (s: TicSettings) => void;
  onFinish: (record: TrainingRecord) => void;
  onExit: () => void;
  onEngine: (e: SimulationEngine) => void;
}

export class SearchScreen {
  private host: Element;
  private scenario: ScenarioDef;
  private settings: TicSettings;
  private cb: Callbacks;
  private engine!: SimulationEngine;
  private hudTimer = 0;

  constructor(host: Element, scenario: ScenarioDef, settings: TicSettings, cb: Callbacks) {
    this.host = host;
    this.scenario = scenario;
    this.settings = settings;
    this.cb = cb;
  }

  mount() {
    this.host.innerHTML = `
      <div class="search-layout">
        <div class="stage">
          <canvas class="tic" id="ticCanvas"></canvas>
          <div class="hud-overlay">
            <div class="hud-top">
              <div class="hud-box">
                <div class="sub">场景时间</div>
                <div id="hudTime" style="font-size:18px;font-weight:700">00:00</div>
              </div>
              <div class="hud-box" style="text-align:center">
                <div class="sub">十字线温度</div>
                <div class="big" id="hudCross">--.- ℃</div>
                <div class="sub" id="hudTarget">未瞄准物体</div>
              </div>
              <div class="hud-box" style="text-align:right">
                <div class="sub">量程 <span id="hudMode">AGC</span></div>
                <div id="hudRange" style="font-size:13px">-- ~ -- ℃</div>
                <div class="sub" id="hudFps">-- fps</div>
              </div>
            </div>
            <div class="hud-bottom">
              <div class="hud-box">
                <div class="sub">烟气层界面 / 上层温度</div>
                <div><span id="hudSmokeH">-- m</span> · <span id="hudSmokeT">-- ℃</span></div>
              </div>
              <div class="hud-box">
                <div class="sub">总热释放 HRR</div>
                <div id="hudHrr">-- kW</div>
              </div>
            </div>
          </div>
          <div class="lock-banner" id="lockBanner">
            <div style="font-size:18px;">点击画面锁定指针开始搜索</div>
            <div class="muted" style="max-width:420px;text-align:center">
              <span class="kbd">W A S D</span> 移动 · <span class="kbd">Shift</span> 快走 ·
              鼠标环视 · <span class="kbd">E</span> 标记被困者 ·
              <span class="kbd">F</span> 喷水雾 · <span class="kbd">G</span> 切换量程 ·
              <span class="kbd">Esc</span> 释放指针
            </div>
          </div>
        </div>
        <aside class="side">
          <div class="panel">
            <h2>任务态势</h2>
            <div class="row"><label>已发现</label><span class="val" id="foundCount">0 / ${this.scenario.victims.length}</span></div>
            <div class="victim-list" id="victimList"></div>
          </div>
          <div class="panel minimap-wrap">
            <h2>平面态势图</h2>
            <canvas id="minimap" width="280" height="240"></canvas>
          </div>
          <div class="panel">
            <h2>热像仪快控</h2>
            <div class="toggle">
              <button id="btnPal">铁红</button>
              <button id="btnGain">切锁定量程</button>
            </div>
            <div class="row" style="margin-top:10px">
              <label>水雾喷射</label>
              <input type="range" id="mist" min="0" max="1" step="0.05" value="0">
            </div>
            <div class="muted">水雾对长波红外强遮挡，喷向火场方向会遮蔽目标，用于训练水雾干扰判读。</div>
          </div>
          <div class="panel">
            <h2>训练控制</h2>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="primary" id="btnMark">标记被困者 (E)</button>
              <button id="btnFinish">结束并复盘</button>
              <button class="ghost" id="btnExit">退出</button>
            </div>
          </div>
        </aside>
      </div>`;

    const canvas = this.host.querySelector<HTMLCanvasElement>('#ticCanvas')!;
    const minimap = this.host.querySelector<HTMLCanvasElement>('#minimap')!;
    const stageRect = canvas.parentElement!.getBoundingClientRect();
    const initW = Math.max(320, Math.round(stageRect.width));
    const initH = Math.max(240, Math.round(stageRect.height));
    this.engine = new SimulationEngine(canvas, minimap, this.scenario, this.settings, {
      onStats: (s) => this.updateHud(s),
      onVictimFound: (name) => this.cbOnToast(`✅ 已发现被困者：${name}`),
      onToast: (t) => this.cbOnToast(t),
    });
    this.engine.renderer.resize(initW, initH);
    this.cb.onEngine(this.engine);
    (window as unknown as { __engine: unknown }).__engine = this.engine;
    this.engine.start();
    this.bindKeys();
    this.bindControls();
    this.refreshVictimList();
  }

  private cbOnToast(text: string) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2400);
  }

  private bindKeys() {
    const onKey = (down: boolean) => (e: KeyboardEvent) => {
      if (e.code === 'KeyE' && down) this.engine.markNearestVictim();
      if (e.code === 'KeyF' && down) {
        const slider = this.host.querySelector<HTMLInputElement>('#mist')!;
        slider.value = slider.value === '0' ? '0.8' : '0';
        this.engine.setMist(Number(slider.value));
      }
      if (e.code === 'KeyG' && down) this.toggleGain();
    };
    document.addEventListener('keydown', this._kd = onKey(true));
    document.addEventListener('keyup', this._ku = onKey(false));
    document.addEventListener('pointerlockchange', this._pl = () => {
      const banner = this.host.querySelector('#lockBanner') as HTMLElement;
      if (banner) banner.style.display = document.pointerLockElement ? 'none' : 'flex';
    });
  }
  private _kd!: (e: KeyboardEvent) => void;
  private _ku!: (e: KeyboardEvent) => void;
  private _pl!: () => void;

  private bindControls() {
    this.host.querySelector<HTMLButtonElement>('#btnPal')!.addEventListener('click', () => {
      this.settings.palette = this.settings.palette === 'iron' ? 'whitehot' : 'iron';
      this.host.querySelector('#btnPal')!.textContent =
        this.settings.palette === 'iron' ? '铁红' : '白热';
      this.engine.updateSettings({ palette: this.settings.palette });
      this.cb.onSettingsChange(this.settings);
    });
    this.host.querySelector<HTMLButtonElement>('#btnGain')!.addEventListener('click', () => this.toggleGain());
    this.host.querySelector<HTMLInputElement>('#mist')!.addEventListener('input', (e) => {
      this.engine.setMist(Number((e.target as HTMLInputElement).value));
    });
    this.host.querySelector('#btnMark')!.addEventListener('click', () => this.engine.markNearestVictim());
    this.host.querySelector('#btnFinish')!.addEventListener('click', () => {
      const rec = this.engine.finish('completed');
      this.cb.onFinish(rec);
    });
    this.host.querySelector('#btnExit')!.addEventListener('click', () => {
      this.engine.finish('aborted');
      this.cb.onExit();
    });
    window.addEventListener('resize', this._rs = () => {
      const canvas = this.host.querySelector<HTMLCanvasElement>('#ticCanvas');
      if (canvas) {
        const r = canvas.parentElement!.getBoundingClientRect();
        this.engine.renderer.resize(Math.round(r.width), Math.round(r.height));
      }
    });
  }
  private _rs!: () => void;

  private toggleGain() {
    const rc = this.engine.renderer.rangeController;
    if (rc.mode === 'auto') {
      rc.lock();
      this.settings.gainMode = 'locked';
      const lk = rc.lockedKelvin;
      this.settings.lockedMin = lk.minK;
      this.settings.lockedMax = lk.maxK;
      this.host.querySelector('#btnGain')!.textContent = '切回自动增益';
      this.cbOnToast('量程已锁定：同物体亮度不再随火焰进出视野变化');
    } else {
      rc.unlock();
      this.settings.gainMode = 'auto';
      this.host.querySelector('#btnGain')!.textContent = '切锁定量程';
    }
    this.engine.updateSettings({ gainMode: this.settings.gainMode });
    this.cb.onSettingsChange(this.settings);
  }

  private updateHud(s: RenderStats) {
    this.hudTimer++;
    const set = (id: string, txt: string) => {
      const el = this.host.querySelector(`#${id}`);
      if (el) el.textContent = txt;
    };
    const mm = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    set('hudTime', mm(this.engine.time));
    set('hudCross', `${kToC(s.crosshairK).toFixed(1)} ℃`);
    set('hudTarget', s.crosshairObjectLabel || '烟气/背景');
    set('hudMode', this.engine.renderer.rangeController.mode === 'auto' ? 'AGC 自动' : '锁定');
    set('hudRange', `${kToC(s.rangeMinK).toFixed(0)} ~ ${kToC(s.rangeMaxK).toFixed(0)} ℃`);
    set('hudFps', `${s.fps.toFixed(0)} fps · ${s.frameMs.toFixed(1)}ms`);
    const w = this.engine.world;
    set('hudSmokeH', `${w.smoke.interfaceHeight.toFixed(2)} m`);
    set('hudSmokeT', `${kToC(w.smoke.upperTemp).toFixed(0)} ℃`);
    set('hudHrr', `${w.totalHRR.toFixed(0)} kW`);
    if (this.hudTimer % 12 === 0) this.refreshVictimList();
  }

  private refreshVictimList() {
    const list = this.host.querySelector('#victimList');
    if (!list) return;
    list.innerHTML = this.scenario.victims.map((v) => `
      <div class="v ${v.found ? 'found' : ''}">
        <span>${v.found ? '✅' : '⏳'} ${v.name}</span>
        <span>${v.found ? `${v.foundAt?.toFixed(0)}s 发现` : '未发现'}</span>
      </div>`).join('');
    const found = this.scenario.victims.filter((v) => v.found).length;
    const fc = this.host.querySelector('#foundCount');
    if (fc) fc.textContent = `${found} / ${this.scenario.victims.length}`;
  }

  dispose() {
    document.removeEventListener('keydown', this._kd);
    document.removeEventListener('keyup', this._ku);
    document.removeEventListener('pointerlockchange', this._pl);
    window.removeEventListener('resize', this._rs);
  }
}
