/**
 * Agent Keystore
 *
 * Each agent generates an Ed25519 keypair on startup.
 * Every pheromone is signed with the agent's private key.
 * Anyone can verify a pheromone came from a specific agent — no central authority.
 *
 * On EigenCompute (TEE), this keypair is hardware-generated inside the enclave.
 * The enclave's attestation quote binds the public key to the exact code running.
 * That makes the identity unforgeable — not just cryptographic, but hardware-rooted.
 */

import crypto from "crypto";

export interface AgentKeypair {
  publicKey: string;   // hex-encoded DER SPKI
  privateKey: string;  // hex-encoded DER PKCS8 (never leave the agent)
  fingerprint: string; // sha256(pubkey).slice(0,16) — shown in dashboard
}

export function generateKeypair(): AgentKeypair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding:  { type: "spki",  format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

  const pubHex  = (publicKey  as unknown as Buffer).toString("hex");
  const privHex = (privateKey as unknown as Buffer).toString("hex");
  const fingerprint = crypto.createHash("sha256").update(pubHex).digest("hex").slice(0, 16);

  return { publicKey: pubHex, privateKey: privHex, fingerprint };
}

/** Sign arbitrary content — returns hex signature */
export function signContent(content: string, privateKeyHex: string): string {
  const key = crypto.createPrivateKey({
    key:    Buffer.from(privateKeyHex, "hex"),
    format: "der",
    type:   "pkcs8",
  });
  return crypto.sign(null, Buffer.from(content, "utf-8"), key).toString("hex");
}

/** Verify a signature. Returns true if valid. */
export function verifySignature(
  content: string,
  signatureHex: string,
  publicKeyHex: string
): boolean {
  try {
    const key = crypto.createPublicKey({
      key:    Buffer.from(publicKeyHex, "hex"),
      format: "der",
      type:   "spki",
    });
    return crypto.verify(
      null,
      Buffer.from(content, "utf-8"),
      key,
      Buffer.from(signatureHex, "hex")
    );
  } catch {
    return false;
  }
}

/** Build the attestation string stored on every pheromone */
export function buildAttestation(
  content: string,
  agentId: string,
  timestamp: number,
  privateKeyHex: string,
  publicKeyHex: string
): string {
  const payload = `${content}|${agentId}|${timestamp}`;
  const sig = signContent(payload, privateKeyHex);
  return `ed25519:${sig}:${publicKeyHex}`;
}

/** Parse and verify an attestation string */
export function verifyAttestation(
  attestation: string,
  content: string,
  agentId: string,
  timestamp: number
): { valid: boolean; publicKey?: string; fingerprint?: string } {
  if (!attestation.startsWith("ed25519:")) {
    return { valid: false };
  }
  const parts = attestation.slice(8).split(":");
  if (parts.length < 2) return { valid: false };
  const [sig, pubKey] = parts;
  const payload = `${content}|${agentId}|${timestamp}`;
  const valid = verifySignature(payload, sig, pubKey);
  const fingerprint = crypto.createHash("sha256").update(pubKey).digest("hex").slice(0, 16);
  return { valid, publicKey: pubKey, fingerprint };
}
