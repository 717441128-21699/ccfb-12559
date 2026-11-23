import type { ScenarioDef, TicSettings } from '../core/types';
import { SCENARIOS, getScenario } from '../sim/scenarios';
import { defaultSettings, SimulationEngine } from './engine';
import { ReplayEngine } from './replay';
import { SearchScreen } from '../ui/searchScreen';
import { SettingsScreen } from '../ui/settingsScreen';
import { ReplayScreen } from '../ui/replayScreen';
import { kToC } from '../render/planck';
import type { TrainingRecord } from './recorder';

export type Screen = 'setup' | 'search' | 'settings' | 'replay';

const STORE_KEY = 'tic-training-settings-v1';

function loadSettings(): TicSettings {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...defaultSettings(), ...JSON.parse(raw) };
  } catch { /* 忽略损坏配置 */ }
  return defaultSettings();
}

export class App {
  private root: HTMLElement;
  screen: Screen = 'setup';
  settings: TicSettings = loadSettings();
  private currentScenario: ScenarioDef = getScenario(SCENARIOS[0].id);
  private engine: SimulationEngine | null = null;
  private replay: ReplayEngine | null = null;
  private lastRecord: TrainingRecord | null = null;
  private searchScreen: SearchScreen | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    window.addEventListener('beforeunload', () => this.saveSettings());
  }

  saveSettings() {
    localStorage.setItem(STORE_KEY, JSON.stringify(this.settings));
  }

  go(screen: Screen) {
    this.screen = screen;
    this.render();
  }

  private topbar(): string {
    const tab = (id: Screen, label: string) =>
      `<button class="tab ${this.screen === id ? 'active' : ''}" data-tab="${id}">${label}</button>`;
    return `
      <header class="topbar">
        <h1>🔥 热像仪火场搜索训练仿真</h1>
        <div class="tabs">
          ${tab('setup', '场景布置')}
          ${tab('search', '队员搜索')}
          ${tab('settings', '热像仪设置')}
          ${tab('replay', '训练复盘')}
        </div>
        <div class="spacer"></div>
        <div class="meta">长波红外 8–14µm · WebGL2 物理渲染</div>
      </header>`;
  }

  render() {
    this.root.innerHTML = `${this.topbar()}<main id="view"></main>`;
    this.root.querySelectorAll<HTMLElement>('[data-tab]').forEach((el) =>
      el.addEventListener('click', () => {
        const target = el.dataset.tab as Screen;
        if (target === 'search' && !this.engine) {
          this.toast('请先在「场景布置」中选择场景并开始训练');
          this.go('setup');
          return;
        }
        if (target === 'replay' && !this.lastRecord) {
          this.toast('暂无复盘数据，请先完成一次搜索训练');
          this.go('setup');
          return;
        }
        this.go(target);
      }));
    const view = this.root.querySelector('#view')!;
    switch (this.screen) {
      case 'setup': this.renderSetup(view); break;
      case 'search': this.renderSearch(view); break;
      case 'settings': this.renderSettings(view); break;
      case 'replay': this.renderReplay(view); break;
    }
  }

  // ================================================== 场景布置
  private renderSetup(view: Element) {
    view.innerHTML = `
      <div class="view" style="padding:18px; overflow:auto;">
        <div class="panel" style="margin-bottom:14px;">
          <h2>训练场景选择（房间布局 × 火势发展共 ${SCENARIOS.length} 套）</h2>
          <div class="scenario-grid">
            ${SCENARIOS.map((s) => `
              <div class="card ${s.id === this.currentScenario.id ? 'selected' : ''}" data-scene="${s.id}">
                <h2>${s.name}</h2>
                <div class="desc">${s.description}</div>
                <div class="tags">
                  <span class="chip">房间 ${s.roomSize[0]}×${s.roomSize[2]}×${s.roomSize[1]}m</span>
                  <span class="chip hot">火源 ${s.fires.length}</span>
                  <span class="chip">被困者 ${s.victims.length}</span>
                  <span class="chip">事件 ${s.events.length}</span>
                </div>
              </div>`).join('')}
          </div>
        </div>
        <div class="panel">
          <h2>环境与初始条件</h2>
          <div class="row">
            <label>环境温度</label>
            <input type="range" id="ambient" min="-10" max="40" step="1" value="${this.currentScenario.ambientC}">
            <span class="val" id="ambientVal">${this.currentScenario.ambientC} ℃</span>
          </div>
          <div class="row">
            <label>调色板</label>
            <div class="toggle" style="flex:1">
              <button data-pal="iron" class="${this.settings.palette === 'iron' ? 'on' : ''}">铁红 Iron</button>
              <button data-pal="whitehot" class="${this.settings.palette === 'whitehot' ? 'on' : ''}">白热 White-Hot</button>
            </div>
          </div>
          <div class="row">
            <label>增益模式</label>
            <div class="toggle" style="flex:1">
              <button data-gain="auto" class="${this.settings.gainMode === 'auto' ? 'on' : ''}">自动增益 AGC</button>
              <button data-gain="locked" class="${this.settings.gainMode === 'locked' ? 'on' : ''}">锁定量程</button>
            </div>
          </div>
          <div class="muted" style="margin-top:8px">
            提示：火焰进入视野后自动增益会把常温区域压黑；切换锁定量程可保持物体亮度不随视野内容变化（量程切换单帧完成）。
          </div>
          <div style="margin-top:16px; display:flex; gap:10px;">
            <button class="primary" id="startBtn">▶ 开始搜索训练</button>
            <button id="resetAmbient">重置环境温度</button>
          </div>
        </div>
      </div>`;

    view.querySelectorAll<HTMLElement>('[data-scene]').forEach((card) =>
      card.addEventListener('click', () => {
        this.currentScenario = getScenario(card.dataset.scene!);
        this.renderSetup(view);
      }));
    const amb = view.querySelector<HTMLInputElement>('#ambient')!;
    amb.addEventListener('input', () => {
      this.currentScenario.ambientC = Number(amb.value);
      view.querySelector('#ambientVal')!.textContent = `${amb.value} ℃`;
    });
    view.querySelector('#resetAmbient')!.addEventListener('click', () => {
      this.currentScenario.ambientC = 20;
      this.renderSetup(view);
    });
    view.querySelectorAll<HTMLElement>('[data-pal]').forEach((b) =>
      b.addEventListener('click', () => {
        this.settings.palette = b.dataset.pal as TicSettings['palette'];
        this.saveSettings();
        this.renderSetup(view);
      }));
    view.querySelectorAll<HTMLElement>('[data-gain]').forEach((b) =>
      b.addEventListener('click', () => {
        this.settings.gainMode = b.dataset.gain as TicSettings['gainMode'];
        this.saveSettings();
        this.renderSetup(view);
      }));
    view.querySelector('#startBtn')!.addEventListener('click', () => this.startTraining());
  }

  private startTraining() {
    // 深拷贝场景，保证重复训练互不污染
    this.currentScenario = getScenario(this.currentScenario.id);
    this.go('search');
  }

  // ================================================== 搜索
  private renderSearch(view: Element) {
    const screen = new SearchScreen(
      view,
      this.currentScenario,
      structuredClone(this.settings),
      {
        onSettingsChange: (s) => { this.settings = s; this.saveSettings(); },
        onFinish: (record) => {
          this.lastRecord = record;
          this.engine?.dispose();
          this.engine = null;
          this.toast('训练已记录，切换到「训练复盘」查看回放');
          this.go('replay');
        },
        onExit: () => {
          this.engine?.dispose();
          this.engine = null;
          this.go('setup');
        },
        onEngine: (e) => { this.engine = e; },
      },
    );
    this.searchScreen = screen;
    screen.mount();
  }

  // ================================================== 设置
  private renderSettings(view: Element) {
    const screen = new SettingsScreen(view, this.settings, (next) => {
      this.settings = next;
      this.saveSettings();
      this.engine?.updateSettings(next);
      if (this.replay) (this.replay as unknown as { settings: TicSettings }).settings = next;
    });
    screen.mount();
  }

  // ================================================== 复盘
  private renderReplay(view: Element) {
    if (!this.lastRecord) {
      view.innerHTML = `<div class="view" style="padding:40px;"><div class="panel"><h2>暂无复盘数据</h2>
        <p class="muted">完成一次搜索训练后，记录会自动保存在本次会话中，可在此回放与拖进度条分析。</p>
        <button class="primary" id="goSetup">去场景布置</button></div></div>`;
      view.querySelector('#goSetup')!.addEventListener('click', () => this.go('setup'));
      return;
    }
    const scenario = getScenario(this.lastRecord.scenarioId);
    const screen = new ReplayScreen(view, this.lastRecord, scenario, structuredClone(this.settings));
    screen.mount();
    this.replay = screen.engine;
  }

  toast(text: string) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  static formatK(k: number) { return `${kToC(k).toFixed(1)} ℃`; }
}
