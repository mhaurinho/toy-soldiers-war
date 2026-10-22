import '@fontsource/fraunces/latin-600.css';
import '@fontsource/fraunces/latin-700.css';
import '@fontsource/outfit/latin-400.css';
import '@fontsource/outfit/latin-500.css';
import '@fontsource/outfit/latin-700.css';
import './styles.css';
import { App } from './app';

const root = document.querySelector('#ui');
const gl = document.querySelector('#gl');
const fx = document.querySelector('#fx');
if (!(root instanceof HTMLElement) || !(gl instanceof HTMLCanvasElement) || !(fx instanceof HTMLCanvasElement)) {
  throw new Error('Marcação da página incompleta.');
}

const app = new App(root, gl, fx);
void app.start();
