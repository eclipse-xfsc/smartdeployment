import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { transform } from 'esbuild';

export default defineConfig({
  plugins: [vue(), {
    name: 'ocm-esbuild-transform',
    enforce: 'post',
    async transform(code, id) {
      if (/\.(?:js|vue)(?:\?|$)/.test(id)) return transform(code, { loader: 'js', target: 'es2022' });
    }
  }],
  base: '/orce/',
  build: {
    outDir: '../runtime/uibuilder/orce/dist',
    emptyOutDir: true,
    sourcemap: false,
    target: ['es2022'],
    manifest: true
  }
});
