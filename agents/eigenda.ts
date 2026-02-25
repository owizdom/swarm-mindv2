/**
 * EigenDA Client
 *
 * Talks to an EigenDA Proxy sidecar (REST → gRPC bridge).
 * Each blob dispersed to EigenDA is attested by a quorum of EigenLayer
 * operators who have restaked ETH — making the commitment a real
 * cryptographic attestation, not just a local hash.
 *
 * Infrastructure needed:
 *   docker run -p 4242:4242 ghcr.io/layr-labs/eigenda-proxy:latest \
 *     --memstore.enabled                         ← local dev / no wallet needed
 *
 *   Or against Holesky testnet (needs a funded private key):
 *     --eigenda-disperser-rpc=disperser-holesky.eigenda.xyz:443 \
 *     --eigenda-eth-rpc=https://ethereum-holesky-rpc.publicnode.com \
 *     --eigenda-svc-manager-addr=0xD4A7E1Bd8015057293f0D0A557088c286942e84b \
 *     --eigenda-signer-private-key-hex=<YOUR_KEY>
 *
 * Set EIGENDA_PROXY_URL=http://localhost:4242 to enable.
 * Leave unset to skip DA and fall back to local hash attestation.
 */

import crypto from "crypto";

const PROXY = process.env.EIGENDA_PROXY_URL;
const TIMEOUT_MS = 30_000;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  return ["1", "true", "yes", "on", "enabled"].includes(v);
}

const EIGENDA_ENABLED = parseBoolean(process.env.EIGENDA_ENABLED, false) && !!PROXY;

export interface DAResult {
  commitment: string;          // hex-encoded KZG commitment from EigenDA
  size: number;                // blob bytes dispersed
  attestedAt: number;          // unix ms when commitment returned
  batchId: string;             // EigenDA batch identifier (simulated for memstore)
  referenceBlockNumber: number; // Ethereum block when batch was anchored (simulated for memstore)
}

export function isEnabled(): boolean {
  return EIGENDA_ENABLED;
}

/**
 * Disperse a JSON-serialisable payload to EigenDA.
 * Returns a DAResult whose `commitment` replaces the SHA-256 hash
 * in Pheromone.attestation — it is signed by restaked ETH operators.
 */
export async function disperseBlob(payload: unknown): Promise<DAResult> {
  if (!EIGENDA_ENABLED) throw new Error("EigenDA disabled or proxy not configured");

  const body = Buffer.from(JSON.stringify(payload), "utf-8");

  const res = await fetch(`${PROXY}/put/`, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/octet-stream" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`EigenDA disperser error ${res.status}: ${text.slice(0, 120)}`);
  }

  const now = Date.now();

  // EigenDA proxy returns raw binary cert bytes — convert to 0x-prefixed hex for URL-safe storage
  let commitment: string;
  let batchId: string | null = null;
  let referenceBlockNumber: number | null = null;

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const json = await res.json() as Record<string, unknown>;
    commitment = (json.commitment ?? json.cert) as string;
    if (!commitment) throw new Error("EigenDA response missing commitment field");
    batchId = (json.batchId ?? json.batch_id ?? null) as string | null;
    referenceBlockNumber = (json.referenceBlockNumber ?? json.reference_block_number ?? null) as number | null;
  } else {
    // Binary cert response — encode as 0x-prefixed hex
    const buf = Buffer.from(await res.arrayBuffer());
    commitment = "0x" + buf.toString("hex");
  }

  // For memstore / local: derive simulated batch info from commitment + current time.
  // In production, these come from the actual EigenDA batch header.
  if (!batchId) {
    batchId = crypto
      .createHash("sha256")
      .update(commitment + Math.floor(now / 60_000)) // changes each minute
      .digest("hex")
      .slice(0, 32);
  }
  if (referenceBlockNumber === null) {
    referenceBlockNumber = Math.floor(now / 12_000); // ~12s Ethereum slot time
  }

  return { commitment, size: body.length, attestedAt: now, batchId, referenceBlockNumber };
}

/**
 * Retrieve a blob from EigenDA by its commitment.
 * Returns the original JSON payload, or null if unavailable.
 */
export async function retrieveBlob<T = unknown>(commitment: string): Promise<T | null> {
  if (!PROXY) return null;

  try {
    const res = await fetch(`${PROXY}/get/${commitment}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return JSON.parse(buf.toString("utf-8")) as T;
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget disperse — submits in background, calls onSuccess with
 * the commitment when done. Used so agent steps are not blocked.
 */
export function disperseAsync(
  payload: unknown,
  onSuccess: (result: DAResult) => void,
  label = "blob"
): void {
  if (!EIGENDA_ENABLED) return;

  disperseBlob(payload)
    .then((result) => {
      console.log(`  [EigenDA] attested ${label}: ${result.commitment.slice(0, 20)}… (${result.size}B)`);
      onSuccess(result);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  [EigenDA] disperse failed for ${label}: ${msg.slice(0, 80)}`);
    });
}
