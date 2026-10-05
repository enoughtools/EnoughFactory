import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createElement, StrictMode } from 'react';
import { renderToString } from 'react-dom/server';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = resolve(project, '.build');
await mkdir(temporary, { recursive: true });
try {
  const bundle = resolve(temporary, 'prerender.mjs');
  await build({ entryPoints: [resolve(project, 'src/App.tsx')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic' });
  const { App } = await import(pathToFileURL(bundle).href);
  const initialManifest = JSON.parse(await readFile(resolve(project, 'public/downloads/manifest.json'), 'utf8'));
  const template = await readFile(resolve(project, 'dist/index.html'), 'utf8');
  const routes = [
    { path: '/', title: 'Your devices. One software factory.', description: 'An open-source workspace for isolated development, connected devices and agents working toward a goal. Built for Mac and Linux.' },
    { path: '/docs', title: 'Guide', description: 'Start with an isolated development session. Connect your agents and devices, choose approvals and autonomy, and work toward a goal.' },
    { path: '/downloads', title: 'Downloads', description: 'Download EnoughFactory for Mac and Linux. Release packages, checksums, signing information and installation requirements.' },
    { path: '/404', title: 'Page not found', description: 'Find EnoughFactory downloads, installation instructions and the product guide.' }
  ];
  for (const route of routes) {
    const body = renderToString(createElement(StrictMode, null, createElement(App, { initialPath: route.path, initialManifest })));
    const title = `EnoughFactory — ${route.title}`;
    const origin = `https://factory.enoughtools.com${route.path === '/' ? '' : route.path}`;
    const html = template
      .replace('<div id="root"></div>', `<div id="root">${body}</div>`)
      .replace(/<title>.*?<\/title>/, `<title>${title}</title>`)
      .replace(/(<meta name="description" content=")[^"]*/, `$1${route.description}`)
      .replace(/(<meta property="og:title" content=")[^"]*/, `$1${title}`)
      .replace(/(<meta property="og:description" content=")[^"]*/, `$1${route.description}`)
      .replace(/(<meta property="og:url" content=")[^"]*/, `$1${origin}`)
      .replace(/(<link rel="canonical" href=")[^"]*/, `$1${origin}`);
    const destination = route.path === '/' ? resolve(project, 'dist/index.html') : resolve(project, `dist${route.path}.html`);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, html);
  }
  console.log(`Prepared ${routes.length} public pages.`);
} finally { await rm(temporary, { recursive: true, force: true }); }
