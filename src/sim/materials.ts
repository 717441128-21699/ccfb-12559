import type { MaterialDef } from '../core/types';

// 数值参考：工程手册与消防热物性常用取值；发射率取 8–14µm 波段典型值
export const MATERIALS: Record<string, MaterialDef> = {
  concrete: {
    id: 'concrete', name: '混凝土',
    emissivity: 0.92, conductivity: 1.4, density: 2300, specificHeat: 880,
    metallic: 0.05, lwTransmittance: 0,
  },
  drywall: {
    id: 'drywall', name: '石膏隔墙板',
    emissivity: 0.9, conductivity: 0.17, density: 800, specificHeat: 1090,
    metallic: 0, lwTransmittance: 0,
  },
  wood: {
    id: 'wood', name: '木材/家具',
    emissivity: 0.85, conductivity: 0.12, density: 600, specificHeat: 1700,
    metallic: 0, lwTransmittance: 0,
  },
  fabric: {
    id: 'fabric', name: '织物/沙发床垫',
    emissivity: 0.96, conductivity: 0.05, density: 80, specificHeat: 1300,
    metallic: 0, lwTransmittance: 0,
  },
  plastic: {
    id: 'plastic', name: '塑料',
    emissivity: 0.94, conductivity: 0.2, density: 1100, specificHeat: 1500,
    metallic: 0.1, lwTransmittance: 0,
  },
  glass: {
    // 玻璃对 LWIR 不透明（< 2.5µm 才透明），低发射率 + 高镜面反射 → 反射假热点
    id: 'glass', name: '玻璃',
    emissivity: 0.18, conductivity: 1.0, density: 2500, specificHeat: 800,
    metallic: 0.95, lwTransmittance: 0,
  },
  steel: {
    // 抛光/氧化钢材：低发射率、强镜面反射
    id: 'steel', name: '钢材/金属',
    emissivity: 0.23, conductivity: 45, density: 7850, specificHeat: 470,
    metallic: 0.98, lwTransmittance: 0,
  },
  paintedMetal: {
    id: 'paintedMetal', name: '喷漆金属',
    emissivity: 0.78, conductivity: 35, density: 7700, specificHeat: 480,
    metallic: 0.4, lwTransmittance: 0,
  },
  ceramic: {
    id: 'ceramic', name: '瓷砖/陶瓷',
    emissivity: 0.95, conductivity: 1.1, density: 2400, specificHeat: 850,
    metallic: 0.05, lwTransmittance: 0,
  },
  paper: {
    id: 'paper', name: '纸张/书籍',
    emissivity: 0.93, conductivity: 0.05, density: 500, specificHeat: 1400,
    metallic: 0, lwTransmittance: 0,
  },
  skin: {
    id: 'skin', name: '人体皮肤',
    emissivity: 0.98, conductivity: 0.4, density: 1050, specificHeat: 3500,
    metallic: 0, lwTransmittance: 0,
  },
  clothing: {
    id: 'clothing', name: '衣物',
    emissivity: 0.95, conductivity: 0.05, density: 400, specificHeat: 1300,
    metallic: 0, lwTransmittance: 0,
  },
  water: {
    id: 'water', name: '水/水雾',
    emissivity: 0.96, conductivity: 0.6, density: 1000, specificHeat: 4186,
    metallic: 0.1, lwTransmittance: 0,
  },
};
