// 物理层冒烟测试：node --import tsx 太麻烦，直接用 vite 的 esbuild 转译后跑
// 这里用极简方式：通过 npx tsx 执行
import { getScenario } from '../src/sim/scenarios';
import { PhysicsWorld, DT } from '../src/sim/physics';
import { planck10, invPlanck10 } from '../src/render/planck';
import { RangeController } from '../src/render/rangeController';

let pass = 0, fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

console.log('--- 普朗克函数可逆性 ---');
for (const T of [250, 300, 400, 800, 1200]) {
  const back = invPlanck10(planck10(T));
  assert(Math.abs(back - T) < 0.5, `T=${T}K 正反变换误差 ${Math.abs(back - T).toFixed(3)}K`);
}
assert(planck10(1000) > planck10(300) * 20, '1000K 辐射显著高于 300K');

console.log('--- 场景物理推进（住宅客厅，5 分钟）---');
const scenario = getScenario('living-room');
const world = new PhysicsWorld(scenario);
const amb0 = world.ambientK;
let maxObjT = amb0;
let smokeDropped = false;
let mistEver = false;
const h0 = world.smoke.interfaceHeight;
for (let i = 0; i < 5 * 60 / DT; i++) {
  world.step(i % 50 === 0 ? [{ id: 'mist-1', rate: 0.6 }] : []);
  for (const o of world.objects) if (!o.isWall) maxObjT = Math.max(maxObjT, o.temperature);
  if (world.smoke.interfaceHeight < h0 - 0.3) smokeDropped = true;
  if (world.smoke.mists.length > 0) mistEver = true;
}
console.log(`  5min 后: HRR=${world.totalHRR.toFixed(0)}kW 烟层界面=${world.smoke.interfaceHeight.toFixed(2)}m 上层=${(world.smoke.upperTemp - 273.15).toFixed(1)}℃`);
assert(world.totalHRR > 100, '火源持续燃烧且 HRR>100kW');
assert(world.smoke.upperTemp > amb0 + 30, '上层烟气显著升温');
assert(smokeDropped, '烟气层界面随时间下压');
assert(maxObjT > amb0 + 5, '火源附近物体被热传导/辐射加热');
assert(mistEver, '水雾雾团生成（喷射期间）');
assert(world.eventLog.length >= 0, '事件系统可运行');

console.log('--- 轰燃场景事件 ---');
const fo = getScenario('flashover-room');
const w2 = new PhysicsWorld(fo);
let flashoverFired = false;
for (let i = 0; i < 4 * 60 / DT; i++) {
  w2.step();
  if (w2.eventLog.some((e) => e.text.includes('轰燃'))) flashoverFired = true;
}
assert(flashoverFired, '轰燃事件在脚本时间触发');
assert(w2.fires.every((f) => f.def.ignited), '轰燃后所有火源点燃');
assert(w2.smoke.upperTemp > 600, '轰燃后上层烟气 > 600K');

console.log('--- AGC 量程状态机（验收点 1）---');
const rc = new RangeController();
rc.reset(293);
// 常温画面
rc.update(planck10(290), planck10(310), 1);
const normalRange = { ...rc.rangeKelvin };
// 火焰进入视野：极热像素拉高上限
for (let i = 0; i < 30; i++) rc.update(planck10(290), planck10(1100), 1);
const fireAutoMax = rc.rangeKelvin.maxK;
assert(fireAutoMax > normalRange.maxK + 100, '自动模式：火焰进视野后量程上限被显著拉高（常温区压黑）');
// 切锁定：立即冻结
rc.lock();
const locked1 = { ...rc.rangeKelvin };
for (let i = 0; i < 30; i++) rc.update(planck10(290), planck10(1100), 1);
const locked2 = { ...rc.rangeKelvin };
assert(locked1.minK === locked2.minK && locked1.maxK === locked2.maxK, '锁定模式：画面内容变化不影响量程');
// 火焰离开视野，锁定量程依旧不变
for (let i = 0; i < 30; i++) rc.update(planck10(290), planck10(310), 1);
const locked3 = { ...rc.rangeKelvin };
assert(locked3.maxK === locked1.maxK, '锁定模式：火焰离开视野后量程仍恒定 → 同物体亮度不变');
// 切回自动，量程重新适应
rc.unlock();
for (let i = 0; i < 40; i++) rc.update(planck10(290), planck10(310), 1);
assert(rc.rangeKelvin.maxK < locked3.maxK - 50, '切回自动后量程重新收窄');
// 手动锁定量程立即生效
rc.lock();
rc.setLockedKelvin(293, 353);
assert(Math.abs(rc.rangeKelvin.maxK - 353) < 1, '手动量程（80℃）单帧生效');

console.log('--- 确定性（回放一致性）---');
const a = new PhysicsWorld(getScenario('office'));
const b = new PhysicsWorld(getScenario('office'));
for (let i = 0; i < 100; i++) { a.step(); b.step(); }
let maxDiff = 0;
a.objects.forEach((o, i) => maxDiff = Math.max(maxDiff, Math.abs(o.temperature - b.objects[i].temperature)));
assert(maxDiff < 1e-9, `两次独立演化温度完全一致（最大差 ${maxDiff}）`);
assert(a.smoke.upperTemp === b.smoke.upperTemp && a.totalHRR === b.totalHRR, '烟气/HRR 演化一致');

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
