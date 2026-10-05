import { build } from 'esbuild';
await build({
  entryPoints: ['src/main.ts', 'src/preload.ts'],
  outdir: 'dist', outExtension: { '.js': '.cjs' },
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  external: ['electron'], sourcemap: true,
});
