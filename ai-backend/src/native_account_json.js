import express from 'express';

export const MAX_AGENT_OBJECT_BYTES = 8 * 1024 * 1024;
const MAX_AGENT_JSON_BYTES = Math.ceil(MAX_AGENT_OBJECT_BYTES / 3) * 4 + 16 * 1024;

// Shared by the outer server and router: an earlier generic parser must not
// reject a valid file before the owning account route receives it.
export function createNativeAccountJsonParser() {
  const ordinary = express.json({ limit: '1mb' });
  const object = express.json({ limit: MAX_AGENT_JSON_BYTES });
  return (req, res, next) => {
    const filePut = req.method === 'PUT'
      && /^\/v1\/account\/agents\/[^/]+\/store\/?$/i.test(req.path);
    return (filePut ? object : ordinary)(req, res, next);
  };
}
