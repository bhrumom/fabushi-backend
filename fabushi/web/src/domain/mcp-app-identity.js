export const MCP_APP_IDENTITY_FIELDS = [
  'author',
  'sourceHost',
  'sourceCustody',
  'repositoryOwner',
  'publisher',
  'officialStatus',
  'sourceProvider',
  'sourceActor',
  'sourceTransport',
  'hostingProvider',
  'runtimeProfile',
  'deploymentTarget'
];

/**
 * Normalizes the ownership/deployment boundary for MCP Apps.
 * Source hosting is not deployment and hosting never grants publisher trust.
 */
export function normalizeMcpAppIdentity(input) {
  const identity = Object.fromEntries(
    MCP_APP_IDENTITY_FIELDS.map((field) => [field, input?.[field] ?? null])
  );

  if (!identity.sourceCustody) {
    throw new Error('sourceCustody is required');
  }
  if (!identity.publisher) {
    throw new Error('publisher is required');
  }

  return identity;
}

export function isSourceHostedOnly(identity) {
  return Boolean(identity.sourceHost) && identity.hostingProvider === 'none';
}

export function validateIdentityBoundary(identity) {
  if (identity.officialStatus === 'official' && identity.publisher !== 'bhrumom') {
    throw new Error('official publisher boundary violation');
  }
  if (identity.sourceHost && identity.deploymentTarget === 'deployed' && !identity.hostingProvider) {
    throw new Error('deployment requires hosting provider');
  }
  return true;
}
