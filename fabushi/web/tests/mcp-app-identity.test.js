import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeMcpAppIdentity,
  validateIdentityBoundary,
} from '../src/domain/mcp-app-identity.js';

test('identity schema keeps source custody separate from deployment hosting', () => {
  const identity = normalizeMcpAppIdentity({
    author: 'user',
    sourceHost: 'github.com',
    sourceCustody: 'user',
    repositoryOwner: 'example',
    publisher: 'example',
    officialStatus: 'user',
    sourceProvider: 'github',
    sourceActor: 'user',
    sourceTransport: 'github-mcp',
    hostingProvider: 'none',
    runtimeProfile: 'local-only',
    deploymentTarget: 'local',
  });

  assert.equal(identity.hostingProvider, 'none');
  assert.equal(validateIdentityBoundary(identity), true);
});

test('identity schema rejects fake official publisher', () => {
  assert.throws(() => validateIdentityBoundary({
    publisher: 'user',
    officialStatus: 'official',
  }));
});
