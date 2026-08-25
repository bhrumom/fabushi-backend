import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { registerMiniAppMarketplaceRoutes } from './miniapp_marketplace_http.js';

const patchFlag = Symbol.for('fabushi.miniapp.marketplace.bootstrap.v2');
const registrationFlag = Symbol.for('fabushi.miniapp.marketplace.routes.v2');

if (!express.application[patchFlag]) {
  const originalListen = express.application.listen;
  Object.defineProperty(express.application, patchFlag, { value: true });
  express.application.listen = function patchedListen(...args) {
    if (!this.locals[registrationFlag]) {
      const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
      const rootDirectory = path.resolve(moduleDirectory, '..');
      const dataDir = process.env.DATA_DIR || path.join(rootDirectory, 'data');
      this.locals[registrationFlag] = registerMiniAppMarketplaceRoutes(this, { dataDir });
    }
    return Reflect.apply(originalListen, this, args);
  };
}
