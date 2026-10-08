import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveNativeAssets(base?: string): { macHelperExecutable: string; iosXctestrunPath?: string; iosPrepareRunScript: string } {
  const installed = base ?? process.env.ENOUGHFACTORY_NATIVE_ASSETS ?? (process.env.ENOUGHFACTORY_RESOURCES ? join(process.env.ENOUGHFACTORY_RESOURCES, 'runtime/native-inspection') : undefined);
  // Installed device service is bundled to CJS. Do not evaluate import.meta.url there.
  const packageRoot = installed ? undefined : process.env.ENOUGHFACTORY_REPO ? join(process.env.ENOUGHFACTORY_REPO, 'packages/native-inspection') : typeof __dirname === 'string' ? resolve(process.cwd(), 'packages/native-inspection') : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const products = installed ? join(installed, 'ios/Products') : join(packageRoot!, 'native/ios/.build/Build/Products');
  const testRun = existsSync(products) ? readdirSync(products).filter(x => x.endsWith('.xctestrun')).sort()[0] : undefined;
  return {
    macHelperExecutable: process.env.ENOUGHFACTORY_NATIVE_MAC_HELPER ?? (installed ? join(installed, 'macos/EnoughFactory Native Inspection.app/Contents/MacOS/EnoughNativeInspection') : join(packageRoot!, '.build/EnoughFactory Native Inspection.app/Contents/MacOS/EnoughNativeInspection')),
    iosXctestrunPath: process.env.ENOUGHFACTORY_NATIVE_IOS_XCTESTRUN ?? (testRun ? join(products, testRun) : undefined),
    iosPrepareRunScript: installed ? join(installed, 'ios/prepare-run.mjs') : join(packageRoot!, 'native/ios/prepare-run.mjs'),
  };
}
