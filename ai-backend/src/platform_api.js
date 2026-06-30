import crypto from 'node:crypto';

import { publicManifestSummary, validateAgentManifest } from './agent_manifest.js';

function ok(res, status, requestId, data, extra = {}) {
  res.status(status).json({ ok: true, requestId, data, ...extra });
}

function fail(res, status, requestId, code, message, details = {}, recoverable = true) {
  res.status(status).json({
    ok: false,
    requestId,
    error: { code, message, recoverable, retryAfterMs: 0, details },
  });
}

function readText(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).replace(/\u0000/g, '').trim() || fallback;
}

function readJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  if (!value) return fallback;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function asJson(value) {
  return JSON.stringify(value ?? null);
}

function requestId(req) {
  return readText(req.get('x-request-id')) || `req_${crypto.randomUUID().replaceAll('-', '')}`;
}

function idempotencyKey(req, fallback) {
  return readText(req.get('idempotency-key')) || fallback;
}

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString();
}

function ensurePlatformSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS developers (
      developer_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      kyc_level TEXT NOT NULL DEFAULT 'none',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_developers_user ON developers (user_id);

    CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      latest_version TEXT,
      visibility TEXT NOT NULL DEFAULT 'private',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agents_developer ON agents (developer_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agents_status_visibility ON agents (status, visibility, updated_at DESC);

    CREATE TABLE IF NOT EXISTS agent_versions (
      version_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      version TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      package_sha256 TEXT,
      review_status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(agent_id, version)
    );

    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      device_type TEXT NOT NULL,
      platform TEXT NOT NULL,
      name TEXT NOT NULL,
      public_key TEXT NOT NULL,
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      last_seen_at TEXT,
      status TEXT NOT NULL DEFAULT 'offline',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_devices_user_seen ON devices (user_id, last_seen_at DESC);

    CREATE TABLE IF NOT EXISTS device_pairings (
      pairing_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      pairing_token_hash TEXT NOT NULL UNIQUE,
      desktop_device_id TEXT NOT NULL,
      mobile_device_id TEXT,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      confirmed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_pairings_desktop ON device_pairings (desktop_device_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS agent_installs (
      install_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      version TEXT NOT NULL,
      status TEXT NOT NULL,
      permissions_snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, agent_id, device_id)
    );

    CREATE TABLE IF NOT EXISTS agent_sessions (
      session_id TEXT PRIMARY KEY,
      install_id TEXT NOT NULL,
      conversation_id TEXT,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_messages (
      message_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_messages_session_created ON agent_messages (session_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS wallets (
      wallet_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      balance INTEGER NOT NULL DEFAULT 0,
      locked_balance INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ledger_entries (
      entry_id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL,
      type TEXT NOT NULL,
      direction TEXT NOT NULL,
      amount INTEGER NOT NULL,
      ref_type TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      balance_after INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invoices (
      invoice_id TEXT PRIMARY KEY,
      seller_id TEXT NOT NULL,
      buyer_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      description TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      paid_at TEXT,
      idempotency_key TEXT UNIQUE
    );

    CREATE INDEX IF NOT EXISTS idx_invoices_buyer_created ON invoices (buyer_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS purchases (
      purchase_id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL UNIQUE,
      deliver_status TEXT NOT NULL,
      entitlement_id TEXT,
      created_at TEXT NOT NULL,
      delivered_at TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      audit_id TEXT PRIMARY KEY,
      actor_user_id TEXT,
      actor_device_id TEXT,
      agent_id TEXT,
      install_id TEXT,
      task_id TEXT,
      event_type TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      decision TEXT NOT NULL,
      summary TEXT NOT NULL,
      request_hash TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_actor_created ON audit_logs (actor_user_id, created_at DESC);
  `);
}

function createStatements(db) {
  return {
    upsertDevice: db.prepare(`
      INSERT INTO devices (
        device_id, user_id, device_type, platform, name, public_key,
        capabilities_json, last_seen_at, status, created_at, updated_at
      ) VALUES (
        @deviceId, @userId, @deviceType, @platform, @name, @publicKey,
        @capabilitiesJson, @seenAt, @status, @createdAt, @updatedAt
      )
      ON CONFLICT(device_id) DO UPDATE SET
        user_id = excluded.user_id,
        device_type = excluded.device_type,
        platform = excluded.platform,
        name = excluded.name,
        public_key = excluded.public_key,
        capabilities_json = excluded.capabilities_json,
        last_seen_at = excluded.last_seen_at,
        status = excluded.status,
        updated_at = excluded.updated_at
    `),
    listDevices: db.prepare(`
      SELECT device_id AS deviceId, device_type AS deviceType, platform, name,
        capabilities_json AS capabilitiesJson, last_seen_at AS lastSeenAt, status, created_at AS createdAt
      FROM devices WHERE user_id = ? ORDER BY COALESCE(last_seen_at, created_at) DESC
    `),
    getDevice: db.prepare('SELECT * FROM devices WHERE device_id = ? AND user_id = ? LIMIT 1'),
    insertPairing: db.prepare(`
      INSERT INTO device_pairings (
        pairing_id, user_id, pairing_token_hash, desktop_device_id,
        expires_at, status, created_at
      ) VALUES (@pairingId, @userId, @tokenHash, @desktopDeviceId, @expiresAt, 'pending', @createdAt)
    `),
    getPairingByHash: db.prepare('SELECT * FROM device_pairings WHERE pairing_token_hash = ? LIMIT 1'),
    confirmPairing: db.prepare(`
      UPDATE device_pairings SET mobile_device_id = @mobileDeviceId, status = 'confirmed', confirmed_at = @confirmedAt
      WHERE pairing_id = @pairingId AND status = 'pending'
    `),
    upsertDeveloper: db.prepare(`
      INSERT INTO developers (developer_id, user_id, status, kyc_level, created_at, updated_at)
      VALUES (@developerId, @userId, 'active', 'none', @now, @now)
      ON CONFLICT(developer_id) DO UPDATE SET updated_at = excluded.updated_at
    `),
    insertAgent: db.prepare(`
      INSERT INTO agents (agent_id, developer_id, name, status, latest_version, visibility, created_at, updated_at)
      VALUES (@agentId, @developerId, @name, @status, @latestVersion, @visibility, @now, @now)
    `),
    listDeveloperAgents: db.prepare(`
      SELECT agent_id AS agentId, developer_id AS developerId, name, status, latest_version AS latestVersion,
        visibility, created_at AS createdAt, updated_at AS updatedAt
      FROM agents WHERE developer_id = ? ORDER BY updated_at DESC
    `),
    getAgent: db.prepare('SELECT * FROM agents WHERE agent_id = ? LIMIT 1'),
    insertAgentVersion: db.prepare(`
      INSERT INTO agent_versions (
        version_id, agent_id, version, manifest_json, manifest_hash, package_sha256, review_status, created_at
      ) VALUES (@versionId, @agentId, @version, @manifestJson, @manifestHash, @packageSha256, @reviewStatus, @createdAt)
    `),
    updateAgentLatest: db.prepare(`
      UPDATE agents SET latest_version = @version, name = COALESCE(@name, name), updated_at = @updatedAt WHERE agent_id = @agentId
    `),
    updateAgentStatus: db.prepare('UPDATE agents SET status = @status, visibility = @visibility, updated_at = @updatedAt WHERE agent_id = @agentId'),
    listPublicAgents: db.prepare(`
      SELECT a.agent_id AS agentId, a.developer_id AS developerId, a.name, a.status,
        a.latest_version AS latestVersion, a.visibility, v.manifest_json AS manifestJson
      FROM agents a
      LEFT JOIN agent_versions v ON v.agent_id = a.agent_id AND v.version = a.latest_version
      WHERE a.status IN ('approved', 'published') OR a.visibility = 'public'
      ORDER BY a.updated_at DESC LIMIT ?
    `),
    upsertInstall: db.prepare(`
      INSERT INTO agent_installs (
        install_id, user_id, agent_id, device_id, version, status, permissions_snapshot_json, created_at, updated_at
      ) VALUES (@installId, @userId, @agentId, @deviceId, @version, @status, @permissionsSnapshotJson, @now, @now)
      ON CONFLICT(user_id, agent_id, device_id) DO UPDATE SET
        version = excluded.version,
        status = excluded.status,
        permissions_snapshot_json = excluded.permissions_snapshot_json,
        updated_at = excluded.updated_at
    `),
    getWallet: db.prepare('SELECT * FROM wallets WHERE user_id = ? LIMIT 1'),
    createWallet: db.prepare('INSERT INTO wallets (wallet_id, user_id, balance, locked_balance, updated_at) VALUES (@walletId, @userId, 0, 0, @now)'),
    updateWalletBalance: db.prepare('UPDATE wallets SET balance = @balance, updated_at = @now WHERE wallet_id = @walletId'),
    insertLedger: db.prepare(`
      INSERT INTO ledger_entries (entry_id, wallet_id, type, direction, amount, ref_type, ref_id, balance_after, idempotency_key, created_at)
      VALUES (@entryId, @walletId, @type, @direction, @amount, @refType, @refId, @balanceAfter, @idempotencyKey, @createdAt)
    `),
    listLedger: db.prepare(`
      SELECT entry_id AS entryId, type, direction, amount, ref_type AS refType, ref_id AS refId,
        balance_after AS balanceAfter, created_at AS createdAt
      FROM ledger_entries WHERE wallet_id = ? ORDER BY created_at DESC LIMIT 20
    `),
    getInvoiceByIdempotency: db.prepare('SELECT * FROM invoices WHERE idempotency_key = ? LIMIT 1'),
    insertInvoice: db.prepare(`
      INSERT INTO invoices (invoice_id, seller_id, buyer_id, sku, amount, currency, description, metadata_json, status, expires_at, created_at, idempotency_key)
      VALUES (@invoiceId, @sellerId, @buyerId, @sku, @amount, @currency, @description, @metadataJson, 'created', @expiresAt, @createdAt, @idempotencyKey)
    `),
    getInvoice: db.prepare('SELECT * FROM invoices WHERE invoice_id = ? LIMIT 1'),
    markInvoicePaid: db.prepare('UPDATE invoices SET status = @status, paid_at = @paidAt WHERE invoice_id = @invoiceId'),
    insertPurchase: db.prepare(`
      INSERT INTO purchases (purchase_id, invoice_id, deliver_status, entitlement_id, created_at)
      VALUES (@purchaseId, @invoiceId, @deliverStatus, @entitlementId, @createdAt)
      ON CONFLICT(invoice_id) DO UPDATE SET deliver_status = purchases.deliver_status
    `),
    getPurchase: db.prepare('SELECT * FROM purchases WHERE purchase_id = ? LIMIT 1'),
    markPurchaseDelivered: db.prepare('UPDATE purchases SET deliver_status = @status, delivered_at = @deliveredAt WHERE purchase_id = @purchaseId'),
    insertAgentSession: db.prepare(`
      INSERT INTO agent_sessions (session_id, install_id, conversation_id, status, started_at, updated_at)
      VALUES (@sessionId, @installId, @conversationId, @status, @now, @now)
    `),
    getAgentSession: db.prepare('SELECT * FROM agent_sessions WHERE session_id = ? LIMIT 1'),
    insertAgentMessage: db.prepare(`
      INSERT INTO agent_messages (message_id, session_id, direction, payload_json, status, created_at)
      VALUES (@messageId, @sessionId, @direction, @payloadJson, @status, @createdAt)
    `),
    listAgentMessages: db.prepare(`
      SELECT message_id AS messageId, direction, payload_json AS payloadJson, status, created_at AS createdAt
      FROM agent_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?
    `),
    insertAudit: db.prepare(`
      INSERT INTO audit_logs (
        audit_id, actor_user_id, actor_device_id, agent_id, install_id, task_id,
        event_type, risk_level, decision, summary, request_hash, created_at
      ) VALUES (@auditId, @actorUserId, @actorDeviceId, @agentId, @installId, @taskId,
        @eventType, @riskLevel, @decision, @summary, @requestHash, @createdAt)
    `),
  };
}

function serializeDevice(row) {
  return {
    ...row,
    capabilities: readJson(row.capabilitiesJson, []),
    capabilitiesJson: undefined,
  };
}

function serializeInvoice(row) {
  if (!row) return null;
  return {
    invoiceId: row.invoice_id,
    sellerId: row.seller_id,
    buyerId: row.buyer_id,
    sku: row.sku,
    amount: row.amount,
    currency: row.currency,
    description: row.description,
    metadata: readJson(row.metadata_json, {}),
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    paidAt: row.paid_at,
  };
}

function insertAudit(s, payload) {
  s.insertAudit.run({
    auditId: createId('audit'),
    actorUserId: payload.actorUserId || null,
    actorDeviceId: payload.actorDeviceId || null,
    agentId: payload.agentId || null,
    installId: payload.installId || null,
    taskId: payload.taskId || null,
    eventType: payload.eventType,
    riskLevel: payload.riskLevel || 'low',
    decision: payload.decision || 'allowed',
    summary: payload.summary,
    requestHash: payload.requestHash || null,
    createdAt: payload.createdAt,
  });
}

function ensureWallet(s, userId, now) {
  let wallet = s.getWallet.get(userId);
  if (!wallet) {
    s.createWallet.run({ walletId: createId('wal'), userId, now });
    wallet = s.getWallet.get(userId);
  }
  return wallet;
}

export function registerPlatformApi({ app, db, resolveUser, asyncHandler }) {
  ensurePlatformSchema(db);
  const s = createStatements(db);

  app.post('/api/devices/register', asyncHandler(async (req, res) => {
    const reqId = requestId(req);
    const user = await resolveUser(req, req.body || {});
    const deviceId = readText(req.body?.deviceId) || createId(`dev_${readText(req.body?.deviceType, 'device')}`);
    const deviceType = readText(req.body?.deviceType, 'desktop');
    const platform = readText(req.body?.platform, 'unknown');
    const name = readText(req.body?.name, platform);
    const publicKey = readText(req.body?.publicKey);
    if (!publicKey) return fail(res, 400, reqId, 'device_public_key_required', 'publicKey is required');
    const now = new Date().toISOString();
    s.upsertDevice.run({
      deviceId,
      userId: user.userId,
      deviceType,
      platform,
      name,
      publicKey,
      capabilitiesJson: asJson(Array.isArray(req.body?.capabilities) ? req.body.capabilities : []),
      seenAt: now,
      status: 'online',
      createdAt: now,
      updatedAt: now,
    });
    insertAudit(s, { actorUserId: user.userId, actorDeviceId: deviceId, eventType: 'device.register', summary: `${deviceType} ${name} registered`, createdAt: now });
    return ok(res, 200, reqId, { deviceId, status: 'online', registeredAt: now });
  }));

  app.get('/api/devices', asyncHandler(async (req, res) => {
    const reqId = requestId(req);
    const user = await resolveUser(req, {});
    return ok(res, 200, reqId, { devices: s.listDevices.all(user.userId).map(serializeDevice) });
  }));

  app.post('/api/devices/pairing', asyncHandler(async (req, res) => {
    const reqId = requestId(req);
    const user = await resolveUser(req, req.body || {});
    const desktopDeviceId = readText(req.body?.desktopDeviceId);
    const device = s.getDevice.get(desktopDeviceId, user.userId);
    if (!device || device.device_type !== 'desktop') return fail(res, 404, reqId, 'desktop_device_not_found', 'desktop device not found');
    const now = new Date();
    const ttlSeconds = Math.min(Math.max(Number(req.body?.ttlSeconds || 180), 30), 600);
    const pairingToken = `pair_${crypto.randomBytes(24).toString('base64url')}`;
    const pairingId = createId('pair');
    s.insertPairing.run({
      pairingId,
      userId: user.userId,
      tokenHash: crypto.createHash('sha256').update(pairingToken).digest('hex'),
      desktopDeviceId,
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
      createdAt: now.toISOString(),
    });
    return ok(res, 200, reqId, {
      pairingId,
      pairingToken,
      qrPayload: `fabushi://pair?token=${encodeURIComponent(pairingToken)}`,
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    });
  }));

  app.post('/api/devices/pairing/confirm', asyncHandler(async (req, res) => {
    const reqId = requestId(req);
    const user = await resolveUser(req, req.body || {});
    const pairingToken = readText(req.body?.pairingToken);
    const mobileDeviceId = readText(req.body?.mobileDeviceId);
    if (!pairingToken || !mobileDeviceId) return fail(res, 400, reqId, 'invalid_pairing_confirm', 'pairingToken and mobileDeviceId are required');
    const pairing = s.getPairingByHash.get(crypto.createHash('sha256').update(pairingToken).digest('hex'));
    if (!pairing || pairing.user_id !== user.userId) return fail(res, 404, reqId, 'pairing_not_found', 'pairing token not found');
    if (pairing.status !== 'pending') return fail(res, 409, reqId, 'pairing_already_used', 'pairing token has already been used');
    if (new Date(pairing.expires_at).getTime() < Date.now()) return fail(res, 410, reqId, 'pairing_expired', 'pairing token has expired');
    const mobile = s.getDevice.get(mobileDeviceId, user.userId);
    if (!mobile) return fail(res, 404, reqId, 'mobile_device_not_found', 'mobile device not found');
    const confirmedAt = new Date().toISOString();
    s.confirmPairing.run({ pairingId: pairing.pairing_id, mobileDeviceId, confirmedAt });
    insertAudit(s, { actorUserId: user.userId, actorDeviceId: mobileDeviceId, eventType: 'device.pairing.confirm', summary: `paired ${mobileDeviceId} to ${pairing.desktop_device_id}`, createdAt: confirmedAt });
    return ok(res, 200, reqId, { pairingId: pairing.pairing_id, status: 'confirmed', desktopDeviceId: pairing.desktop_device_id, mobileDeviceId });
  }));

  app.post('/api/developer/agents', asyncHandler(async (req, res) => {
    const reqId = requestId(req);
    const user = await resolveUser(req, req.body || {});
    const developerId = readText(req.body?.developerId) || `dev_${user.userId}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const agentId = readText(req.body?.agentId) || createId('agent');
    const name = readText(req.body?.name, 'Untitled Agent');
    const now = new Date().toISOString();
    s.upsertDeveloper.run({ developerId, userId: user.userId, now });
    s.insertAgent.run({ agentId, developerId, name, status: 'draft', latestVersion: null, visibility: 'private', now });
    return ok(res, 201, reqId, { agentId, developerId, name, status: 'draft' });
  }));

  app.get('/api/developer/agents', asyncHandler(async (req, res) => {
    const reqId = requestId(req);
    const user = await resolveUser(req, {});
    const developerId = readText(req.query.developerId) || `dev_${user.userId}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return ok(res, 200, reqId, { agents: s.listDeveloperAgents.all(developerId) });
  }));

  app.post('/api/developer/agents/:agentId/versions', asyncHandler(async (req, res) => {
    const reqId = requestId(req);
    const user = await resolveUser(req, req.body || {});
    const agent = s.getAgent.get(req.params.agentId);
    if (!agent) return fail(res, 404, reqId, 'agent_not_found', 'agent not found');
    const expectedDeveloperId = `dev_${user.userId}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
    if (agent.developer_id !== expectedDeveloperId && readText(req.body?.developerId) !== agent.developer_id) {
      return fail(res, 403, reqId, 'permission_denied', 'only the developer can submit versions');
    }
    const manifest = req.body?.manifest && typeof req.body.manifest === 'object' ? req.body.manifest : req.body || {};
    const validation = validateAgentManifest(manifest, { verifiedOrigins: req.body?.verifiedOrigins || [] });
    if (!validation.valid) return fail(res, 422, reqId, 'manifest_validation_failed', 'manifest validation failed', validation, true);
    const now = new Date().toISOString();
    const version = readText(manifest.version);
    s.insertAgentVersion.run({
      versionId: createId('ver'),
      agentId: agent.agent_id,
      version,
      manifestJson: asJson(manifest),
      manifestHash: validation.manifestHash,
      packageSha256: readText(manifest.package?.sha256),
      reviewStatus: 'validated',
      createdAt: now,
    });
    s.updateAgentLatest.run({ agentId: agent.agent_id, version, name: readText(manifest.name), updatedAt: now });
    return ok(res, 201, reqId, { agentId: agent.agent_id, version, validation, manifest: publicManifestSummary(manifest) });
  }));

  app.post('/api/developer/agents/:agentId/submit', asyncHandler(async (req, res) => {
    const reqId = requestId(req);
    const user = await resolveUser(req, req.body || {});
    const agent = s.getAgent.get(req.params.agentId);
    if (!agent) return fail(res, 404, reqId, 'agent_not_found', 'agent not found');
    const expectedDeveloperId = `dev_${user.userId}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
    if (agent.developer_id !== expectedDeveloperId && readText(req.body?.developerId) !== agent.developer_id) {
      return fail(res, 403, reqId, 'permission_denied', 'only the developer can submit this agent');
    }
    const now = new Date().toISOString();
    s.updateAgentStatus.run({ agentId: agent.agent_id, status: 'review_pending', visibility: 'private', updatedAt: now });
    return ok(res, 202, reqId, { agentId: agent.agent_id, status: 'review_pending', reviewTaskId: createId('review') });
  }));

  app.get('/api/agents', asyncHandler(async (req, res) => {
    const reqId = requestId(req);
    const limit = Math.min(Math.max(Number(req.query.limit || 30), 1), 100);
    const agents = s.listPublicAgents.all(limit).map((row) => ({
      agentId: row.agentId,
      developerId: row.developerId,
      name: row.name,
      status: row.status,
      latestVersion: row.latestVersion,
      visibility: row.visibility,
      manifest: readJson(row.manifestJson, null),
    }));
    return ok(res, 200, reqId, { agents });
  }));

  app.post('/api/agents/:agentId/install', asyncHandler(async (req, res) => {
    const reqId = requestId(req);
    const user = await resolveUser(req, req.body || {});
    const agent = s.getAgent.get(req.params.agentId);
    if (!agent) return fail(res, 404, reqId, 'agent_not_found', 'agent not found');
    const deviceId = readText(req.body?.deviceId);
    const device = s.getDevice.get(deviceId, user.userId);
    if (!device || device.device_type !== 'desktop') return fail(res, 404, reqId, 'desktop_device_not_found', 'desktop device not found');
    const installId = createId('ins');
    const now = new Date().toISOString();
    s.upsertInstall.run({
      installId,
      userId: user.userId,
      agentId: agent.agent_id,
      deviceId,
      version: readText(req.body?.version, agent.latest_version || '0.0.0'),
      status: device.status === 'online' ? 'queued' : 'queued_offline',
      permissionsSnapshotJson: asJson(req.body?.acceptedPermissions || []),
      now,
    });
    insertAudit(s, { actorUserId: user.userId, actorDeviceId: deviceId, agentId: agent.agent_id, installId, eventType: 'agent.install', riskLevel: 'medium', summary: `install ${agent.agent_id} on ${deviceId}`, createdAt: now });
    return ok(res, 202, reqId, { installId, status: device.status === 'online' ? 'queued' : 'queued_offline', targetDeviceOnline: device.status === 'online' });
  }));

  app.get('/api/wallet/balance', asyncHandler(async (req, res) => {
    const reqId = requestId(req);
    const user = await resolveUser(req, {});
    const now = new Date().toISOString();
    const wallet = ensureWallet(s, user.userId, now);
    return ok(res, 200, reqId, {
      walletId: wallet.wallet_id,
      balance: wallet.balance,
      lockedBalance: wallet.locked_balance,
      currency: 'FUDE_JIN',
      ledger: s.listLedger.all(wallet.wallet_id),
    });
  }));

  app.post('/api/invoices', asyncHandler(async (req, res) => {
    const reqId = requestId(req);
    const user = await resolveUser(req, req.body || {});
    const key = idempotencyKey(req, `invoice:${user.userId}:${readText(req.body?.sku)}:${readText(req.body?.metadata?.taskId)}:${readText(req.body?.amount)}`);
    const existing = s.getInvoiceByIdempotency.get(key);
    if (existing) return ok(res, 200, reqId, serializeInvoice(existing));
    const amount = Number(req.body?.amount);
    if (!Number.isInteger(amount) || amount <= 0) return fail(res, 400, reqId, 'invoice_invalid_amount', 'amount must be a positive integer');
    const currency = readText(req.body?.currency, 'FUDE_JIN');
    if (!['FUDE_JIN', 'CNY'].includes(currency)) return fail(res, 400, reqId, 'invoice_unsupported_currency', 'currency is unsupported');
    const now = new Date().toISOString();
    const invoiceId = createId('inv');
    s.insertInvoice.run({
      invoiceId,
      sellerId: readText(req.body?.sellerId, 'official.fabushi'),
      buyerId: readText(req.body?.buyerId, user.userId),
      sku: readText(req.body?.sku, readText(req.body?.productId, 'unknown_sku')),
      amount,
      currency,
      description: readText(req.body?.description, readText(req.body?.title, '')),
      metadataJson: asJson(req.body?.metadata || {}),
      expiresAt: addDays(now, 1),
      createdAt: now,
      idempotencyKey: key,
    });
    return ok(res, 201, reqId, serializeInvoice(s.getInvoice.get(invoiceId)));
  }));

  app.get('/api/invoices/:invoiceId', asyncHandler(async (req, res) => {
    const reqId = requestId(req);
    const user = await resolveUser(req, {});
    const invoice = s.getInvoice.get(req.params.invoiceId);
    if (!invoice) return fail(res, 404, reqId, 'invoice_not_found', 'invoice not found');
    if (![invoice.buyer_id, invoice.seller_id].includes(user.userId) && invoice.buyer_id !== 'current_user') {
      return fail(res, 403, reqId, 'permission_denied', 'not allowed to read this invoice');
    }
    return ok(res, 200, reqId, serializeInvoice(invoice));
  }));

  app.post('/api/invoices/:invoiceId/pay', asyncHandler(async (req, res) => {
    const reqId = requestId(req);
    const user = await resolveUser(req, req.body || {});
    const key = idempotencyKey(req, `pay:${req.params.invoiceId}:${user.userId}`);
    const now = new Date().toISOString();
    const result = db.transaction(() => {
      const invoice = s.getInvoice.get(req.params.invoiceId);
      if (!invoice) return { error: ['invoice_not_found', 'invoice not found', 404] };
      if (invoice.status === 'paid') return { invoice, purchase: null, alreadyPaid: true };
      if (invoice.status !== 'created') return { error: ['invoice_not_payable', `invoice is ${invoice.status}`, 409] };
      if (new Date(invoice.expires_at).getTime() < Date.now()) return { error: ['invoice_expired', 'invoice has expired', 410] };
      if (invoice.currency === 'FUDE_JIN') {
        const wallet = ensureWallet(s, user.userId, now);
        const nextBalance = Number(wallet.balance) - Number(invoice.amount);
        if (nextBalance < 0) return { error: ['wallet_insufficient_balance', '福德金余额不足，请先充值', 402] };
        s.updateWalletBalance.run({ walletId: wallet.wallet_id, balance: nextBalance, now });
        try {
          s.insertLedger.run({
            entryId: createId('led'),
            walletId: wallet.wallet_id,
            type: 'invoice_pay',
            direction: 'debit',
            amount: invoice.amount,
            refType: 'invoice',
            refId: invoice.invoice_id,
            balanceAfter: nextBalance,
            idempotencyKey: key,
            createdAt: now,
          });
        } catch (error) {
          const paid = s.getInvoice.get(req.params.invoiceId);
          return { invoice: paid, purchase: null, alreadyPaid: paid?.status === 'paid' };
        }
      }
      s.markInvoicePaid.run({ invoiceId: invoice.invoice_id, status: 'paid', paidAt: now });
      const purchaseId = createId('pur');
      s.insertPurchase.run({ purchaseId, invoiceId: invoice.invoice_id, deliverStatus: 'pending', entitlementId: readJson(invoice.metadata_json, {}).entitlementId || null, createdAt: now });
      return { invoice: s.getInvoice.get(invoice.invoice_id), purchase: { purchaseId, deliverStatus: 'pending' } };
    })();
    if (result.error) return fail(res, result.error[2], reqId, result.error[0], result.error[1]);
    insertAudit(s, { actorUserId: user.userId, eventType: 'payment.consume', riskLevel: 'medium', decision: 'allowed', summary: `paid invoice ${req.params.invoiceId}`, createdAt: now });
    return ok(res, 200, reqId, { invoice: serializeInvoice(result.invoice), purchase: result.purchase, alreadyPaid: result.alreadyPaid === true });
  }));

  app.post('/api/purchases/:purchaseId/deliver', asyncHandler(async (req, res) => {
    const reqId = requestId(req);
    const user = await resolveUser(req, req.body || {});
    const purchase = s.getPurchase.get(req.params.purchaseId);
    if (!purchase) return fail(res, 404, reqId, 'purchase_not_found', 'purchase not found');
    const now = new Date().toISOString();
    s.markPurchaseDelivered.run({ purchaseId: purchase.purchase_id, status: 'delivered', deliveredAt: now });
    insertAudit(s, { actorUserId: user.userId, eventType: 'purchase.deliver', riskLevel: 'low', summary: `delivered purchase ${purchase.purchase_id}`, createdAt: now });
    return ok(res, 200, reqId, { purchaseId: purchase.purchase_id, deliverStatus: 'delivered', deliveredAt: now });
  }));

  app.post('/api/agent-sessions/:sessionId/messages', asyncHandler(async (req, res) => {
    const reqId = requestId(req);
    await resolveUser(req, req.body || {});
    const session = s.getAgentSession.get(req.params.sessionId);
    if (!session) return fail(res, 404, reqId, 'agent_session_not_found', 'agent session not found');
    const now = new Date().toISOString();
    const messageId = readText(req.body?.messageId) || createId('msg');
    s.insertAgentMessage.run({
      messageId,
      sessionId: session.session_id,
      direction: readText(req.body?.direction, 'mobile_to_desktop'),
      payloadJson: asJson(req.body?.payload || {}),
      status: readText(req.body?.status, 'queued'),
      createdAt: now,
    });
    return ok(res, 202, reqId, { messageId, sessionId: session.session_id, status: 'queued' });
  }));

  app.get('/api/agent-sessions/:sessionId/messages', asyncHandler(async (req, res) => {
    const reqId = requestId(req);
    await resolveUser(req, {});
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500);
    const rows = s.listAgentMessages.all(req.params.sessionId, limit).map((row) => ({ ...row, payload: readJson(row.payloadJson, {}), payloadJson: undefined }));
    return ok(res, 200, reqId, { messages: rows });
  }));
}
