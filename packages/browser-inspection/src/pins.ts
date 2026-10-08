/**
 * Verified against Microsoft's OCI registry and npm on 8 October 2026.
 * 0.0.83 has no published container yet; use the complete, matching 0.0.82 image.
 * Upstream builds Chromium only. No browser downloads occur in author containers.
 */
export const BROWSER_PINS = Object.freeze({
  mcpVersion: '0.0.82',
  playwrightVersion: '1.64.0-alpha-1789764292000',
  nodeVersion: '24.21.0',
  browserRevision: '1246',
  chromiumVersion: '154.0.8037.0',
  upstreamImage: 'mcr.microsoft.com/playwright/mcp',
  upstreamIndex: 'sha256:77dccc5ce9e94cb8ae7ebea87ddbb6cd54b05760c4d63c54e16accf2726b8734',
  upstreamLockSha256: '10bcbeb19608f046a76ea3b2c2d3d2bea3b2cc43e852c11f1d1b2ce602e1e5eb',
  upstreamBrowsersSha256: '6268af2c35843cd3d8be9fc9591125afcc6a2e4a38847ec3d0d4ec6afa023cdd',
  architectures: Object.freeze({
    'linux/amd64': Object.freeze({
      manifest: 'sha256:a8e5493fa6fd055e9d441fe69cf38069b5e32231ca7ab5aafcc51bf08ef619a5',
      config: 'sha256:a57bc217afdd3afef4418a781e96a2ef0ea6ef0e938f5c3df9055897ad698251',
      executablePath: '/ms-playwright/chromium-1246/chrome-linux64/chrome',
      compressedBytes: 426457104,
    }),
    'linux/arm64': Object.freeze({
      manifest: 'sha256:444482187203960aa7b762b98d330c037abf6e1b74029333aab2ef60d3e077d5',
      config: 'sha256:af28706f6b8e7a5833b1d7491c4b9a4e42e4ab68ba034c6d2fe92ea427e59034',
      executablePath: '/ms-playwright/chromium-1246/chrome-linux-arm64/chrome',
      compressedBytes: 425647879,
    }),
  }),
});

export type BrowserImagePlatform = keyof typeof BROWSER_PINS.architectures;

export const BROWSER_IMAGE_PATHS = Object.freeze({
  node: '/usr/local/bin/node',
  mcpCli: '/app/cli.js',
  playwrightPackage: '/app/node_modules/playwright',
  verifier: '/opt/enoughfactory/browser/verify.cjs',
  receipt: '/opt/enoughfactory/browser/image-toolchain.json',
  output: '/output',
});
