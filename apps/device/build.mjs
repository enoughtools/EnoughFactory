import { build } from 'esbuild';
await build({ entryPoints: { service: 'src/index.ts', 'inspection-build-worker': 'src/inspection-build-worker.ts' }, bundle: true, platform: 'node', target: 'node22', format: 'cjs', outdir: 'dist', outExtension: { '.js': '.cjs' }, external: ['node-datachannel'], sourcemap: true,
  banner: {js:'const __enoughfactoryImportMetaUrl = require("node:url").pathToFileURL(__filename).href;'},
  define: {'import.meta.url':'__enoughfactoryImportMetaUrl'}
});
