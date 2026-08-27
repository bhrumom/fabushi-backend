import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { MiniAppMarketplace } from './miniapp_marketplace.js';
import { officialMiniAppPackageSeeds } from './miniapp_marketplace_catalog.js';
import { registerMiniAppMarketplaceRoutes } from './miniapp_marketplace_http.js';
import { installWebMcpMarketplacePolicy } from './miniapp_webmcp_policy.js';
import { standaloneCommerceMiniAppManifest } from './standalone_commerce_miniapp.js';

const patchFlag = Symbol.for('fabushi.miniapp.marketplace.bootstrap.v2');
const registrationFlag = Symbol.for('fabushi.miniapp.marketplace.routes.v2');

installWebMcpMarketplacePolicy(MiniAppMarketplace);

if (!express.application[patchFlag]) {
  const originalListen = express.application.listen;
  Object.defineProperty(express.application, patchFlag, { value: true });
  express.application.listen = function patchedListen(...args) {
    if (!this.locals[registrationFlag]) {
      const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
      const rootDirectory = path.resolve(moduleDirectory, '..');
      const dataDir = process.env.DATA_DIR || path.join(rootDirectory, 'data');
      const store = new MiniAppMarketplace({
        storagePath: path.join(dataDir, 'miniapps', 'marketplace-v2.json'),
        seed: [...officialMiniAppPackageSeeds(), standaloneCommerceMiniAppManifest()],
      });
      this.locals[registrationFlag] = registerMiniAppMarketplaceRoutes(this, { dataDir, store });
    }
    return Reflect.apply(originalListen, this, args);
  };
}
