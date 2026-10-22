import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const webgpuBuild = fileURLToPath(new URL('./node_modules/three/build/three.webgpu.js', import.meta.url));
const tslBuild = fileURLToPath(new URL('./node_modules/three/build/three.tsl.js', import.meta.url));

// Addons import from 'three'. Alias that exact specifier to the WebGPU build so
// Scene, BufferGeometry and materials are one instance (the official examples do
// the same with an import map). Prefix matches would also rewrite three/addons.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^three$/, replacement: webgpuBuild },
      { find: 'three/webgpu', replacement: webgpuBuild },
      { find: 'three/tsl', replacement: tslBuild },
    ],
  },
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1', port: 4173 },
});
