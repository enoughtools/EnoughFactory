import { build } from 'esbuild';
await build({ entryPoints: ['src/index.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: 'dist/service.cjs', external: ['node-datachannel'], sourcemap: true,
  banner: {js:'const __enoughfactoryImportMetaUrl = require("node:url").pathToFileURL(__filename).href;'},
  define: {'import.meta.url':'__enoughfactoryImportMetaUrl'}
});
