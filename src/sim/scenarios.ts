import type { ScenarioDef, SimObject, VictimDef, Vec3 } from '../core/types';
import { KELVIN } from '../core/math';
import { box, buildRoomShell, cylinder, partition } from './roomBuilder';

const amb = (c: number) => c + KELVIN;

function victim(id: string, name: string, position: Vec3, pose: VictimDef['pose'], exposed = 0.25): VictimDef {
  const lying = pose === 'lying';
  return {
    id, name, position, pose,
    coreTemp: 310,
    surfaceTemp: lying ? 305 : 307,
    exposedSkin: exposed,
    found: false,
  };
}

/** 给受害者也建立对应的可渲染 SimObject（人形网格） */
function victimObject(v: VictimDef): SimObject {
  const size: Vec3 = v.pose === 'lying'
    ? [0.5, 0.45, 1.85]
    : v.pose === 'sitting'
      ? [0.5, 1.15, 0.6]
      : [0.5, 1.75, 0.4];
  const pos: Vec3 = v.pose === 'lying'
    ? [v.position[0], size[1] / 2, v.position[2]]
    : [v.position[0], size[1] / 2, v.position[2]];
  return {
    id: `vobj-${v.id}`, label: `被困人员·${v.name}`,
    kind: 'humanoid', position: pos, size, yaw: 0,
    materialId: 'clothing', temperature: v.surfaceTemp,
    isWall: false, isVictim: true,
  };
}

// ============================================================ 场景 1：住宅客厅火灾
function scenarioLivingRoom(): ScenarioDef {
  const room: Vec3 = [8, 2.7, 7];
  const objects: SimObject[] = [
    ...buildRoomShell(room),
    box('布艺沙发', [2.2, 0.4, -1.8], [2.2, 0.8, 0.9], 'fabric', 0),
    box('木质茶几', [2.2, 0.25, -0.5], [1.2, 0.5, 0.6], 'wood'),
    box('电视柜', [-3.2, 0.35, -2.9], [1.6, 0.7, 0.45], 'wood'),
    box('电视机（玻璃屏）', [-3.2, 1.05, -3.18], [1.3, 0.75, 0.06], 'glass'),
    box('餐桌', [-1.6, 0.75, 1.6], [1.4, 0.08, 0.8], 'wood'),
    box('餐椅×4-1', [-2.5, 0.45, 1.6], [0.4, 0.9, 0.4], 'wood'),
    box('餐椅×4-2', [-0.7, 0.45, 1.6], [0.4, 0.9, 0.4], 'wood'),
    box('书柜', [3.3, 1.0, 1.5], [0.45, 2.0, 1.4], 'wood'),
    box('书柜内书籍', [3.05, 1.1, 1.5], [0.12, 0.5, 1.2], 'paper'),
    cylinder('金属垃圾桶', [3.4, 0.3, -2.6], 0.35, 0.6, 'steel'),
    box('落地窗玻璃', [0, 1.35, 3.42], [3.6, 2.3, 0.05], 'glass'),
    box('金属窗框', [0, 2.55, 3.4], [3.8, 0.1, 0.1], 'paintedMetal'),
    box('厨房金属台面', [-3.3, 0.85, 2.6], [0.65, 0.08, 1.6], 'steel'),
  ];
  const victims = [
    victim('v1', '老人（躺卧沙发旁）', [2.2, 0, -0.2], 'lying', 0.3),
    victim('v2', '儿童（餐桌下）', [-1.6, 0, 1.2], 'sitting', 0.4),
  ];
  objects.push(...victims.map(victimObject));
  return {
    id: 'living-room',
    name: '住宅客厅火灾',
    description: '沙发起火，烟气层逐步下压；玻璃电视与落地窗产生反射假热点，2 名被困人员。',
    roomSize: room,
    ambientC: 20,
    objects,
    fires: [
      {
        id: 'fire-sofa', position: [2.2, 0, -1.8], growth: 'medium',
        peakHRR: 1800, peakTime: 150, decayStart: 420,
        ignited: true, radius: 0.5,
      },
      {
        id: 'fire-books', position: [3.3, 0, 1.5], growth: 'fast',
        peakHRR: 900, peakTime: 120, ignited: false, ignitionTime: 200, radius: 0.4,
      },
    ],
    victims,
    mists: [{ id: 'mist-1', position: [0, 1.5, 3.0], direction: [0, -0.15, -1], rate: 0 }],
    spawn: { position: [0, 1.6, 3.0], yaw: Math.PI },
    events: [
      { time: 200, type: 'ignite', targetId: 'fire-books', text: '书柜被辐射引燃，第二火点出现' },
      { time: 300, type: 'hint', text: '提示：注意电视屏幕上的反射热点，勿误判为火点' },
    ],
  };
}

// ============================================================ 场景 2：开放式办公室
function scenarioOffice(): ScenarioDef {
  const room: Vec3 = [12, 3.0, 9];
  const objects: SimObject[] = [
    ...buildRoomShell(room, 'concrete'),
  ];
  // 工位阵列
  const desks: [number, number][] = [[-3.5, -2], [0, -2], [3.5, -2], [-3.5, 1], [0, 1], [3.5, 1]];
  for (const [x, z] of desks) {
    objects.push(box('办公桌', [x, 0.72, z], [1.5, 0.06, 0.75], 'wood'));
    objects.push(box('办公椅', [x, 0.48, z + 0.65], [0.55, 0.95, 0.55], 'plastic'));
    objects.push(box('显示器', [x, 1.05, z - 0.25], [0.55, 0.35, 0.05], 'glass'));
    objects.push(box('电脑主机（金属）', [x + 0.5, 0.35, z - 0.1], [0.2, 0.5, 0.45], 'steel'));
  }
  objects.push(
    box('玻璃隔断墙', [0, 1.35, -4.0], [6.0, 2.7, 0.06], 'glass'),
    box('金属隔断框-1', [-3.0, 1.35, -4.0], [0.08, 2.7, 0.08], 'paintedMetal'),
    box('金属隔断框-2', [3.0, 1.35, -4.0], [0.08, 2.7, 0.08], 'paintedMetal'),
    box('文件柜', [-5.2, 1.0, -3.2], [0.5, 2.0, 1.2], 'steel'),
    box('服务器机柜', [5.2, 1.1, -3.5], [0.8, 2.2, 1.0], 'steel'),
    cylinder('饮水机', [5.2, 0.55, 2.8], 0.35, 1.1, 'plastic'),
    box('沙发休息区', [-5.0, 0.4, 3.2], [2.0, 0.8, 0.9], 'fabric'),
  );
  const victims = [
    victim('v1', '值班员（倒伏工位旁）', [0, 0, -1.2], 'lying', 0.35),
    victim('v2', '访客（休息区）', [-5.0, 0, 2.6], 'sitting', 0.2),
    victim('v3', 'IT 人员（机柜后）', [5.2, 0, -2.6], 'lying', 0.5),
  ];
  objects.push(...victims.map(victimObject));
  return {
    id: 'office',
    name: '开放式办公室电气火灾',
    description: '服务器机柜电气起火，蔓延慢但烟量大；玻璃隔断形成大面积反射，3 名被困人员，空间开阔考验搜索路线。',
    roomSize: room,
    ambientC: 22,
    objects,
    fires: [
      {
        id: 'fire-rack', position: [5.2, 0, -3.5], growth: 'slow',
        peakHRR: 1200, peakTime: 240, decayStart: 500,
        ignited: true, radius: 0.55,
      },
      {
        id: 'fire-cabinet', position: [-5.2, 0, -3.2], growth: 'medium',
        peakHRR: 700, peakTime: 140, ignited: false, ignitionTime: 280, radius: 0.4,
      },
    ],
    victims,
    mists: [{ id: 'mist-1', position: [0, 1.6, 3.8], direction: [0.3, -0.1, -1], rate: 0 }],
    spawn: { position: [0, 1.65, 3.8], yaw: Math.PI },
    events: [
      { time: 280, type: 'ignite', targetId: 'fire-cabinet', text: '文件柜被引燃，通风侧出现第二火点' },
      { time: 240, type: 'hint', text: '提示：金属机柜表面温度低但会反射火光，注意绕到侧面确认' },
    ],
  };
}

// ============================================================ 场景 3：两居室（隔墙 + 多房间搜索）
function scenarioApartment(): ScenarioDef {
  const room: Vec3 = [10, 2.7, 8];
  const objects: SimObject[] = [
    ...buildRoomShell(room),
    // 隔墙分出卧室与卫生间，留门洞
    partition('主卧隔墙', [-1.5, 1.35, 0], [0.12, 2.7, 4.2], 'wall2', [0.1, 0.1, 0.55, 0.9]),
    partition('主卧隔墙门垛', [-1.5, 1.35, 2.8], [0.12, 2.7, 1.4], 'wall2', [0.6, 0.1, 0.75, 0.9]),
    partition('卫生间隔墙', [1.8, 1.35, 0], [0.12, 2.7, 3.4], 'wall3', [0.1, 0.1, 0.5, 0.9]),
    partition('卫生间隔墙门垛', [1.8, 1.35, 2.5], [0.12, 2.7, 2.0], 'wall3', [0.55, 0.1, 0.8, 0.9]),
    // 主卧
    box('双人床', [-3.6, 0.35, -2.2], [1.8, 0.7, 2.0], 'fabric'),
    box('衣柜', [-4.4, 1.05, 0.8], [0.6, 2.1, 1.6], 'wood'),
    box('卧室玻璃窗', [-4.85, 1.4, -2.2], [0.05, 1.4, 1.6], 'glass'),
    // 卫生间
    box('浴缸（陶瓷）', [3.5, 0.35, -2.4], [0.8, 0.7, 1.7], 'ceramic'),
    cylinder('金属洗手盆', [3.6, 0.8, 0.6], 0.5, 0.2, 'steel'),
    box('浴室镜（玻璃）', [4.85, 1.5, -0.5], [0.05, 1.0, 1.2], 'glass'),
    // 客厅/厨房
    box('厨房橱柜', [0.2, 0.45, 3.3], [2.4, 0.9, 0.6], 'wood'),
    box('金属灶台', [0.2, 0.92, 3.35], [0.7, 0.04, 0.5], 'steel'),
    box('冰箱（喷漆金属）', [-0.9, 0.95, 3.3], [0.7, 1.9, 0.65], 'paintedMetal'),
    box('餐桌', [1.2, 0.75, 0.8], [1.2, 0.08, 0.8], 'wood'),
    box('餐椅', [1.2, 0.45, 0.1], [0.4, 0.9, 0.4], 'wood'),
  ];
  const victims = [
    victim('v1', '卧室住户（床上昏迷）', [-3.6, 0, -2.2], 'lying', 0.15),
    victim('v2', '卫生间被困者（浴缸旁）', [3.5, 0, -1.2], 'sitting', 0.45),
  ];
  objects.push(...victims.map(victimObject));
  return {
    id: 'apartment',
    name: '两居室厨房火灾搜救',
    description: '灶台起火，需穿越门洞逐室搜索；隔墙阻挡辐射使卧室升温滞后，镜面/玻璃反射热点多，2 名被困人员。',
    roomSize: room,
    ambientC: 18,
    objects,
    fires: [
      {
        id: 'fire-stove', position: [0.2, 0, 3.35], growth: 'fast',
        peakHRR: 1500, peakTime: 120, decayStart: 380,
        ignited: true, radius: 0.4,
      },
      {
        id: 'fire-cabinet', position: [0.2, 0, 2.9], growth: 'medium',
        peakHRR: 800, peakTime: 110, ignited: false, ignitionTime: 90, radius: 0.35,
      },
    ],
    victims,
    mists: [{ id: 'mist-1', position: [0, 1.5, -3.5], direction: [0, -0.1, 1], rate: 0 }],
    spawn: { position: [0, 1.6, -3.5], yaw: 0 },
    events: [
      { time: 90, type: 'ignite', targetId: 'fire-cabinet', text: '橱柜被灶台引燃' },
      { time: 220, type: 'vent', text: '破窗通风：烟气层短暂回落' },
      { time: 260, type: 'hint', text: '提示：门后与卫生间镜面是假热点高发区，进门前先测温' },
    ],
  };
}

// ============================================================ 场景 4：轰燃训练
function scenarioFlashover(): ScenarioDef {
  const room: Vec3 = [7, 2.6, 6];
  const objects: SimObject[] = [
    ...buildRoomShell(room, 'drywall'),
    box('单人床', [-2.2, 0.3, -1.5], [1.2, 0.6, 2.0], 'fabric'),
    box('床垫（易燃）', [-2.2, 0.65, -1.5], [1.25, 0.25, 1.95], 'fabric'),
    box('木质衣柜', [2.6, 1.0, -2.0], [0.6, 2.0, 1.4], 'wood'),
    box('书桌', [2.4, 0.75, 1.2], [1.2, 0.08, 0.6], 'wood'),
    box('塑料椅', [1.6, 0.45, 1.2], [0.5, 0.9, 0.5], 'plastic'),
    box('纸箱堆-1', [2.8, 0.4, 2.2], [0.8, 0.8, 0.8], 'paper'),
    box('纸箱堆-2', [-2.8, 0.3, 2.0], [0.7, 0.6, 0.7], 'paper'),
    cylinder('金属垃圾桶', [0.5, 0.3, 0], 0.3, 0.6, 'steel'),
    box('玻璃窗', [0, 1.4, 2.92], [2.4, 1.8, 0.05], 'glass'),
  ];
  const victims = [
    victim('v1', '被困者（门后）', [0.8, 0, 2.4], 'lying', 0.3),
  ];
  objects.push(...victims.map(victimObject));
  return {
    id: 'flashover-room',
    name: '轰燃征兆识别训练',
    description: '封闭小房间快速火，约 3 分钟后轰燃：观察烟气层温度与界面下降速度，在轰燃前撤出。重点训练 AGC 锁定量程读数。',
    roomSize: room,
    ambientC: 25,
    objects,
    fires: [
      {
        id: 'fire-bed', position: [-2.2, 0, -1.5], growth: 'fast',
        peakHRR: 2200, peakTime: 140, ignited: true, radius: 0.5,
      },
      {
        id: 'fire-closet', position: [2.6, 0, -2.0], growth: 'fast',
        peakHRR: 1400, peakTime: 100, ignited: false, ignitionTime: 110, radius: 0.4,
      },
    ],
    victims,
    mists: [{ id: 'mist-1', position: [0, 1.5, 2.6], direction: [0, -0.2, -1], rate: 0 }],
    spawn: { position: [0, 1.55, 2.6], yaw: Math.PI },
    events: [
      { time: 110, type: 'ignite', targetId: 'fire-closet', text: '衣柜引燃，第二火点' },
      { time: 185, type: 'flashover', text: '轰燃！全员撤离' },
      { time: 150, type: 'hint', text: '提示：上层烟气超过 500℃ 且界面低于 1.5m 是轰燃前兆' },
    ],
  };
}

export const SCENARIOS: ScenarioDef[] = [
  scenarioLivingRoom(),
  scenarioOffice(),
  scenarioApartment(),
  scenarioFlashover(),
];

export function getScenario(id: string): ScenarioDef {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`未知场景：${id}`);
  return JSON.parse(JSON.stringify(s)) as ScenarioDef;
}

export { amb };
