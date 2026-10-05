import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

export default defineConfig({
  plugins: [react(), { name: 'factory-oss-notices', generateBundle() { for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) this.emitFile({ type: 'asset', fileName: name, source: readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8') }); } }],
  base: './',
  server: {
    port: 4318,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:4317', ws: true }, '/preview': { target: 'http://127.0.0.1:4317', ws: true } },
  },
});
