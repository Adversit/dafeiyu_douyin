import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:19423',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (request, incoming) => {
            if (['http://127.0.0.1:5173', 'http://localhost:5173'].includes(incoming.headers.origin)) {
              request.setHeader('Origin', 'http://127.0.0.1:19423');
            }
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      onwarn(warning, warn) {
        // Ant Design also targets React Server Components. These directives have
        // no role in this browser-only application; preserve every other warning.
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('use client')) return;
        warn(warning);
      },
      output: {
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return;
          if (/\/(?:react|react-dom|scheduler)\//.test(id)) return 'react';
          if (id.includes('/@ant-design/icons')) return 'icons';
          if (id.includes('/antd/')) return 'antd';
          return 'ui-dependencies';
        },
      },
    },
  },
});
