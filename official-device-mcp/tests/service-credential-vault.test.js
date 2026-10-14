import assert from "node:assert/strict";
import test from "node:test";
import { createServiceCredentialVault, ServiceCredentialVaultError } from "../lib/service-credential-vault.js";

const key = Buffer.alloc(32, 7).toString("base64url");
const otherKey = Buffer.alloc(32, 8).toString("base64url");
const binding = Object.freeze({
  accountId: "account-1",
  connectionId: "official-mcp:connection-1",
  delegationId: "service-delegation-1",
  externalClientId: "chatgpt-client-1",
  resource: "https://api.ombhrum.com/mcp",
});
const token = "msr_" + "x".repeat(64);

test("service refresh credential is AES-GCM sealed without plaintext persistence", () => {
  const vault = createServiceCredentialVault({ key });
  const envelope = vault.seal(token, binding);
  assert.equal(envelope.version, 1);
  assert.equal(envelope.algorithm, "A256GCM");
  assert.equal(typeof envelope.keyId, "string");
  assert.equal(JSON.stringify(envelope).includes(token), false);
  assert.equal(vault.open(envelope, binding), token);
});

test("service credential envelope is bound to account connection delegation client and resource", () => {
  const vault = createServiceCredentialVault({ key });
  const envelope = vault.seal(token, binding);
  for (const [field, value] of [
    ["accountId", "account-2"],
    ["connectionId", "official-mcp:connection-2"],
    ["delegationId", "service-delegation-2"],
    ["externalClientId", "chatgpt-client-2"],
    ["resource", "https://api.ombhrum.com/other"],
  ]) {
    assert.throws(
      () => vault.open(envelope, { ...binding, [field]: value }),
      (error) => error instanceof ServiceCredentialVaultError && error.code === "service_credential_decrypt_failed",
      field,
    );
  }
});

test("tamper and wrong vault key fail closed", () => {
  const vault = createServiceCredentialVault({ key });
  const envelope = vault.seal(token, binding);
  assert.throws(
    () => createServiceCredentialVault({ key: otherKey }).open(envelope, binding),
    (error) => error instanceof ServiceCredentialVaultError && error.code === "vault_key_mismatch",
  );
  const tampered = { ...envelope, ciphertext: envelope.ciphertext.slice(0, -1) + (envelope.ciphertext.endsWith("A") ? "B" : "A") };
  assert.throws(
    () => vault.open(tampered, binding),
    (error) => error instanceof ServiceCredentialVaultError && error.code === "service_credential_decrypt_failed",
  );
});

test("missing or malformed deployment vault key never falls back to plaintext", () => {
  for (const invalid of ["", "not-a-32-byte-key", Buffer.alloc(31)]) {
    assert.throws(
      () => createServiceCredentialVault({ key: invalid }),
      (error) => error instanceof ServiceCredentialVaultError && ["missing_vault_key", "invalid_vault_key"].includes(error.code),
    );
  }
});
