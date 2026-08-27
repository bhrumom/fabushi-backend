export const FABUSHI_WEBMCP_CONTRACT = 'fabushi.webmcp.v1';

function webMcpError(message) {
  const error = new Error(message);
  error.code = 'WEBMCP_CONTRACT_REQUIRED';
  return error;
}

export function assertMiniAppWebMcpReady(manifest) {
  if (!manifest || typeof manifest !== 'object') throw webMcpError('MiniApp manifest is required');
  if (!Array.isArray(manifest.commands) || manifest.commands.length === 0) {
    throw webMcpError(`MiniApp ${manifest.id ?? '<unknown>'} must expose at least one Tool for WebMCP`);
  }
  const seen = new Set();
  for (const command of manifest.commands) {
    const tool = String(command?.tool ?? command?.name ?? '').trim();
    if (!tool) throw webMcpError(`MiniApp ${manifest.id ?? '<unknown>'} has a command without a Tool`);
    if (seen.has(tool)) continue;
    seen.add(tool);
  }
  return {
    protocol: FABUSHI_WEBMCP_CONTRACT,
    required: true,
    toolSource: 'runtime-tool-catalog',
    foreground: 'document.modelContext',
    fallback: 'window.__fabushiWebMcp',
    tools: [...seen],
  };
}

export function webMcpMarketplaceProjection(manifest) {
  return {
    ...manifest,
    webmcp: assertMiniAppWebMcpReady(manifest),
  };
}

export function installWebMcpMarketplacePolicy(MarketplaceClass) {
  if (!MarketplaceClass?.prototype) return;
  const marker = Symbol.for('fabushi.webmcp.marketplace-policy.v1');
  if (MarketplaceClass.prototype[marker]) return;
  Object.defineProperty(MarketplaceClass.prototype, marker, { value: true });

  const originalCreateDraft = MarketplaceClass.prototype.createDraft;
  MarketplaceClass.prototype.createDraft = function createWebMcpDraft(input) {
    const draft = originalCreateDraft.call(this, input);
    assertMiniAppWebMcpReady(draft);
    return draft;
  };

  const originalSubmit = MarketplaceClass.prototype.submit;
  MarketplaceClass.prototype.submit = function submitWebMcpMiniApp(id, publisherId) {
    const manifest = this.get(id, { includeUnapproved: true });
    assertMiniAppWebMcpReady(manifest);
    return originalSubmit.call(this, id, publisherId);
  };

  const originalReview = MarketplaceClass.prototype.review;
  MarketplaceClass.prototype.review = function reviewWebMcpMiniApp(id, options = {}) {
    if (options?.approved === true) {
      const manifest = this.get(id, { includeUnapproved: true });
      assertMiniAppWebMcpReady(manifest);
    }
    return originalReview.call(this, id, options);
  };

  const originalGenerationWorkflow = MarketplaceClass.prototype.generationWorkflow;
  MarketplaceClass.prototype.generationWorkflow = function generationWorkflowWithWebMcp(input = {}) {
    const workflow = originalGenerationWorkflow.call(this, input);
    return {
      ...workflow,
      webmcp: {
        protocol: FABUSHI_WEBMCP_CONTRACT,
        required: true,
        toolSource: 'runtime-tool-catalog',
      },
      acceptance: [
        ...(workflow.acceptance ?? []),
        'every MiniApp exposes its runtime Tool catalog through WebMCP when its page is open',
        'WebMCP teardown never terminates an already-started Rust/native background job',
      ],
    };
  };
}
