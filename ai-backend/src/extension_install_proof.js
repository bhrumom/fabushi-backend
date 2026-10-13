import crypto from 'node:crypto';
import { ExtensionRegistryError } from './extension_registry.js';

function unavailable() {
  throw new ExtensionRegistryError('EXTENSION_NOT_FOUND', 'Approved install proof is unavailable');
}
export function readExtensionInstallProof({ releaseStore, artifactStore, signingStore }, key) {
  if (key.kind !== 'web-miniapp') return unavailable();
  const release = releaseStore.getRelease(key);
  if (!release || release.state !== 'approved' || release.descriptor?.release?.revoked === true) return unavailable();
  const signature = signingStore.getTrustedSignature(key);
  if (!signature) return unavailable();
  let artifacts, signed;
  try {
    artifacts = artifactStore.approvalGate(key);
    signed = JSON.parse(signature.payload);
  } catch { return unavailable(); }
  const descriptor = release.descriptor;
  const descriptorPayload = JSON.stringify(descriptor);
  const digest = crypto.createHash('sha256').update(descriptorPayload, 'utf8').digest('hex');
  if (digest !== release.descriptorDigest || digest !== signed.descriptorDigest
    || signed.identity?.kind !== key.kind || signed.identity?.namespace !== key.namespace
    || signed.identity?.name !== key.name || signed.version !== key.version
    || descriptor?.identity?.kind !== key.kind || descriptor.identity.namespace !== key.namespace
    || descriptor.identity.name !== key.name || descriptor.release?.version !== key.version) return unavailable();
  const bound = artifacts.map((artifact) => ({
    artifactId: String(artifact.artifactId), digest: String(artifact.digest),
    sizeBytes: Number(artifact.sizeBytes), platform: String(artifact.platform),
    architecture: String(artifact.architecture), format: String(artifact.format),
  })).sort((a, b) => a.artifactId.localeCompare(b.artifactId));
  if (JSON.stringify(bound) !== JSON.stringify(signed.artifacts)
    || !/^[0-9a-f]{64}$/.test(descriptor.release.bundleDigest ?? '')
    || !bound.some((artifact) => artifact.digest === descriptor.release.bundleDigest && artifact.format === 'fabapp')) return unavailable();
  return { protocol: 'fabushi.extension-install-proof.v1', descriptor,
    descriptorPayload, releaseSignature: signature, trust: signingStore.trustFeed() };
}
