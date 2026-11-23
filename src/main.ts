import './styles.css';
import { App } from './app/app';

const root = document.querySelector('#app')!;
const app = new App(root as HTMLElement);
app.render();

// 调试入口（控制台可访问）
declare global {
  interface Window { ticApp: App }
}
window.ticApp = app;
