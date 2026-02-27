/**
 * EigenCompute TEE Attestation
 *
 * Fetches the Intel TDX quote from EigenCloud's local metadata endpoint.
 * The quote is a hardware-signed proof that:
 *   - This exact container image is running inside a genuine Intel TDX VM
 *   - The TEE measurements (MRTD, RTMRs) bind to the specific code loaded
 *   - The enclave memory is isolated — no other process can read it
 *
 * For Swarm Mind, each agent runs in its own EigenCloud instance, so each
 * gets its own TDX quote. Together the three quotes prove hardware-level
 * isolation — a much stronger independence claim than process isolation.
 *
 * When running locally (no TEE), returns a graceful stub so dev works normally.
 */

import crypto from "crypto";

export interface TEEAttestation {
  instanceId:  string;   // EIGENCLOUD_INSTANCE_ID or "local"
  teeType:     string;   // "tdx" | "local" | "tdx-unavailable"
  quoteB64:    string;   // base64-encoded TDX DCAP quote (empty when local)
  quoteSha256: string;   // sha256(quoteB64) — stable content address of the quote
  fetchedAt:   number;   // unix ms when the quote was fetched
}

let cached: TEEAttestation | null = null;

/**
 * Fetch (and cache) the TDX attestation quote from EigenCloud.
 * Safe to call multiple times — result is cached after first call.
 */
export async function getTEEAttestation(): Promise<TEEAttestation> {
  if (cached) return cached;

  const instanceId = process.env.EIGENCLOUD_INSTANCE_ID || "local";
  // EigenCloud exposes the TDX quote via a local HTTP endpoint inside the TEE
  const attestUrl  = process.env.EIGENCLOUD_ATTESTATION_URL
                  || "http://localhost:29343/attest/tdx";

  if (instanceId === "local") {
    cached = {
      instanceId,
      teeType:     "local",
      quoteB64:    "",
      quoteSha256: "no-tee-local-dev",
      fetchedAt:   Date.now(),
    };
    console.log("[TEE] Local dev mode — no TDX quote");
    return cached;
  }

  try {
    // userData binds the quote to this specific agent instance
    const res = await fetch(attestUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ userData: instanceId }),
      signal:  AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data  = await res.json() as { quote?: string };
    const quoteB64 = data.quote ?? "";
    cached = {
      instanceId,
      teeType:     "tdx",
      quoteB64,
      quoteSha256: crypto.createHash("sha256").update(quoteB64).digest("hex"),
      fetchedAt:   Date.now(),
    };
    console.log(`[TEE] TDX quote fetched  instance=${instanceId}`);
    console.log(`[TEE] quote sha256       ${cached.quoteSha256.slice(0, 16)}…`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[TEE] Quote fetch failed (${msg}) — running without hardware attestation`);
    cached = {
      instanceId,
      teeType:     "tdx-unavailable",
      quoteB64:    "",
      quoteSha256: "fetch-failed",
      fetchedAt:   Date.now(),
    };
  }

  return cached;
}

/** Returns the cached quote, or null if getTEEAttestation() hasn't been called yet. */
export function getCachedAttestation(): TEEAttestation | null {
  return cached;
}
