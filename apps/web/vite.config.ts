import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repositoryRoot = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
const git = (...args: string[]) => execFileSync('git', args, {
  cwd: repositoryRoot,
  encoding: 'utf8',
  timeout: 5_000,
  stdio: ['ignore', 'pipe', 'ignore'],
}).trim();

function sourceIdentity(): { revisionFull: string | null; dirty: boolean | null } {
  try {
    // A source archive nested in another checkout must not inherit that checkout's identity.
    if (realpathSync(git('rev-parse', '--show-toplevel')) === repositoryRoot) {
      const revisionFull = git('rev-parse', 'HEAD');
      let dirty: boolean | null = null;
      try { dirty = git('status', '--porcelain', '--untracked-files=normal').length > 0; } catch { /* Modification state is unavailable. */ }
      return { revisionFull, dirty };
    }
  } catch { /* Source archives can provide their identity explicitly below. */ }

  const sourceCommit = process.env.ENOUGHFACTORY_SOURCE_COMMIT?.trim();
  const revisionFull = sourceCommit && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sourceCommit) ? sourceCommit.toLowerCase() : null;
  const sourceDirty = process.env.ENOUGHFACTORY_SOURCE_DIRTY?.trim();
  const dirty = revisionFull && sourceDirty === 'true' ? true : revisionFull && sourceDirty === 'false' ? false : null;
  return { revisionFull, dirty };
}

const source = sourceIdentity();

export default defineConfig({
  define: {
    __ENOUGHFACTORY_UI_BUILD__: JSON.stringify({ version, revision: source.revisionFull?.slice(0, 7) ?? null, ...source }),
  },
  plugins: [react(), { name: 'factory-oss-notices', generateBundle() { for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) this.emitFile({ type: 'asset', fileName: name, source: readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8') }); } }],
  base: './',
  server: {
    port: 4318,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:4317', ws: true }, '/preview': { target: 'http://127.0.0.1:4317', ws: true } },
  },
});
