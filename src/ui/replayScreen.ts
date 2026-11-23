import type { ScenarioDef, TicSettings } from '../core/types';
import type { TrainingRecord } from '../app/recorder';
import { ReplayEngine } from '../app/replay';
import { kToC } from '../render/planck';

export class ReplayScreen {
  private host: Element;
  private record: TrainingRecord;
  private scenario: ScenarioDef;
  private settings: TicSettings;
  engine!: ReplayEngine;

  constructor(host: Element, record: TrainingRecord, scenario: ScenarioDef, settings: TicSettings) {
    this.host = host;
    this.record = record;
    this.scenario = scenario;
    this.settings = settings;
  }

  mount() {
    const r = this.record;
    this.host.innerHTML = `
      <div class="view" style="padding:12px; gap:10px; display:flex; flex-direction:column;">
        <div class="replay-layout" style="flex:1; min-height:0;">
          <div class="stage" style="flex:1;">
            <canvas id="replayCanvas" style="width:100%;height:100%;display:block;"></canvas>
          </div>
          <aside class="side" style="width:320px; flex-basis:320px; display:flex; flex-direction:column; gap:10px; overflow:auto;">
            <div class="panel">
              <h2>训练统计</h2>
              <div class="stat-grid">
                <div class="stat"><div class="k">训练时长</div><div class="v2">${r.duration.toFixed(0)} s</div></div>
                <div class="stat"><div class="k">发现人数</div><div class="v2">${r.foundVictims.length}/${this.scenario.victims.length}</div></div>
                <div class="stat"><div class="k">行进里程</div><div class="v2">${r.summary.distance.toFixed(1)} m</div></div>
                <div class="stat"><div class="k">水雾用时</div><div class="v2">${r.summary.mistUsedSeconds.toFixed(0)} s</div></div>
                <div class="stat"><div class="k">烟层最高温</div><div class="v2">${kToC(r.summary.peakUpperTempK).toFixed(0)} ℃</div></div>
                <div class="stat"><div class="k">最低界面高度</div><div class="v2">${r.summary.minInterfaceHeight.toFixed(2)} m</div></div>
              </div>
              <h3>搜救结果</h3>
              <div class="victim-list">
                ${this.scenario.victims.map((v) => {
                  const f = r.foundVictims.find((x) => x.id === v.id);
                  return `<div class="v ${f ? 'found' : ''}"><span>${f ? '✅' : '❌'} ${v.name}</span>
                    <span>${f ? `${f.at.toFixed(0)}s` : '未发现'}</span></div>`;
                }).join('')}
              </div>
            </div>
            <div class="panel minimap-wrap">
              <h2>回放态势图</h2>
              <canvas id="replayMap" width="290" height="240"></canvas>
            </div>
            <div class="panel">
              <h2>事件时间线</h2>
              <div class="event-log">
                ${r.events.length ? r.events.map((e) => `
                  <div class="e"><span class="t">${e.time.toFixed(0)}s</span><span>${e.text}</span></div>`).join('')
                  : '<div class="muted">本次训练无脚本事件触发。</div>'}
              </div>
            </div>
          </aside>
        </div>
        <div class="timeline">
          <button id="playBtn" class="primary">▶ 播放</button>
          <input type="range" id="seek" min="0" max="${r.duration}" step="0.1" value="0">
          <span class="val" id="timeText" style="min-width:96px">0.0 / ${r.duration.toFixed(1)} s</span>
        </div>
      </div>`;

    const canvas = this.host.querySelector<HTMLCanvasElement>('#replayCanvas')!;
    const map = this.host.querySelector<HTMLCanvasElement>('#replayMap')!;
    requestAnimationFrame(() => {
      const rect = canvas.parentElement!.getBoundingClientRect();
      this.engine = new ReplayEngine(
        canvas, map, r, this.scenario, this.settings,
      );
      this.engine.glRenderer.resize(Math.round(rect.width), Math.round(rect.height));
      this.engine.seek(0);
      this.engine.onTick = (t) => {
        this.host.querySelector<HTMLInputElement>('#seek')!.value = String(t);
        this.host.querySelector('#timeText')!.textContent =
          `${t.toFixed(1)} / ${r.duration.toFixed(1)} s`;
      };
      this.bindTimeline();
    });
  }

  private bindTimeline() {
    const seek = this.host.querySelector<HTMLInputElement>('#seek')!;
    const playBtn = this.host.querySelector<HTMLButtonElement>('#playBtn')!;
    playBtn.addEventListener('click', () => {
      if (this.engine.isPlaying) {
        this.engine.pause();
        playBtn.textContent = '▶ 播放';
      } else {
        this.engine.play();
        playBtn.textContent = '⏸ 暂停';
      }
    });
    seek.addEventListener('input', () => {
      this.engine.pause();
      playBtn.textContent = '▶ 播放';
      this.engine.seek(Number(seek.value));
    });
    this.engine.onTick = (t) => {
      seek.value = String(t);
      this.host.querySelector('#timeText')!.textContent =
        `${t.toFixed(1)} / ${this.record.duration.toFixed(1)} s`;
      if (!this.engine.isPlaying) playBtn.textContent = '▶ 播放';
    };
  }
}
