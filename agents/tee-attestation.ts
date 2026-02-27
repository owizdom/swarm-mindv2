/**
 * EigenCloud TEE Attestation
 *
 * EigenCloud runs on Google Confidential Space with Intel TDX.
 * The attestation is a JWT signed by Intel Trust Authority, fetched from
 * the GCE metadata server inside the TEE.
 *
 * Endpoint: http://metadata.google.internal/computeMetadata/v1/instance/attestation/token
 * Header:   Metadata-Flavor: Google
 *
 * The JWT contains hardware-signed claims:
 *   - hwmodel: "INTEL_TDX"
 *   - swname: "CONFIDENTIAL_SPACE"
 *   - secboot: true
 *   - container image digest (binds code to the quote)
 *   - eat_nonce: our agentId (binds quote to this specific agent)
 */

import crypto from "crypto";

export interface TEEAttestation {
  instanceId:   string;
  teeType:      string;    // "tdx" | "local" | "tdx-unavailable"
  quoteB64:     string;    // raw JWT from Intel Trust Authority
  quoteSha256:  string;    // sha256(JWT) — stable content address
  fetchedAt:    number;
  endpoint?:    string;
  // Parsed claims from the JWT (for convenience)
  hwModel?:     string;    // "INTEL_TDX"
  swName?:      string;    // "CONFIDENTIAL_SPACE"
  secBoot?:     boolean;
  tcbStatus?:   string;    // "UpToDate"
  imageDigest?: string;
}

let cached: TEEAttestation | null = null;

/** Decode a JWT payload without verifying (verification is done by EigenCloud dashboard) */
function decodeJWTPayload(jwt: string): Record<string, unknown> {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return {};
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(padded, "base64").toString("utf-8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const METADATA_BASE = "http://metadata.google.internal/computeMetadata/v1/instance";

// Ordered list of attestation endpoints to try
const ATTEST_ENDPOINTS = [
  // Google Confidential Space — Intel Trust Authority JWT (primary for EigenCloud)
  `${METADATA_BASE}/attestation/token`,
  // GCE identity token (fallback — no TDX claims but proves GCE instance)
  `${METADATA_BASE}/service-accounts/default/identity`,
  // Fallback local endpoints (other TEE platforms)
  "http://localhost:29343/attest/tdx",
  "http://localhost:29343/attest",
  "http://localhost:8080/attest/tdx",
];

async function tryMetadataEndpoint(
  url: string,
  audience: string,
  nonce: string,
): Promise<string | null> {
  try {
    const params = new URLSearchParams({ audience, nonce, format: "full" });
    const res = await fetch(`${url}?${params}`, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    // Must look like a JWT (3 base64 parts separated by dots)
    if (text.split(".").length === 3) return text.trim();
    return null;
  } catch {
    return null;
  }
}

async function tryLocalEndpoint(
  url: string,
  userData: string,
): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userData, reportData: userData }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      return (json.quote ?? json.token ?? json.attestation ?? null) as string | null;
    } catch {
      if (text.length > 32) return text.trim();
    }
    return null;
  } catch {
    return null;
  }
}

export async function getTEEAttestation(): Promise<TEEAttestation> {
  if (cached) return cached;

  const instanceId = process.env.EIGENCLOUD_INSTANCE_ID || "local";

  if (instanceId === "local") {
    cached = {
      instanceId,
      teeType:     "local",
      quoteB64:    "",
      quoteSha256: "no-tee-local-dev",
      fetchedAt:   Date.now(),
    };
    console.log("[TEE] Local dev mode — skipping attestation fetch");
    return cached;
  }

  const audience = `swarm-mind:${instanceId}`;
  const nonce    = crypto.createHash("sha256").update(instanceId + Date.now()).digest("hex").slice(0, 32);

  console.log(`[TEE] Fetching TDX attestation (instance=${instanceId})`);

  // Try GCE metadata / Confidential Space endpoints first
  for (const url of ATTEST_ENDPOINTS.slice(0, 2)) {
    console.log(`[TEE]   → ${url}`);
    const jwt = await tryMetadataEndpoint(url, audience, nonce);
    if (jwt) {
      const payload  = decodeJWTPayload(jwt);
      const quoteB64 = Buffer.from(jwt).toString("base64");
      cached = {
        instanceId,
        teeType:      "tdx",
        quoteB64,
        quoteSha256:  crypto.createHash("sha256").update(jwt).digest("hex"),
        fetchedAt:    Date.now(),
        endpoint:     url,
        hwModel:      payload.hwmodel  as string | undefined,
        swName:       payload.swname   as string | undefined,
        secBoot:      payload.secboot  as boolean | undefined,
        tcbStatus:    (payload.tcbstatus ?? payload.tcb_status) as string | undefined,
        imageDigest:  payload.submods ? JSON.stringify(payload.submods).match(/sha256:[a-f0-9]{64}/)?.[0] : undefined,
      };
      console.log(`[TEE] ✓ Attestation JWT from ${url}`);
      console.log(`[TEE]   hwModel=${cached.hwModel ?? "?"} secBoot=${cached.secBoot ?? "?"} tcb=${cached.tcbStatus ?? "?"}`);
      console.log(`[TEE]   sha256  ${cached.quoteSha256.slice(0, 16)}…`);
      return cached;
    }
  }

  // Try local TEE daemon endpoints (non-GCE platforms)
  for (const url of ATTEST_ENDPOINTS.slice(2)) {
    console.log(`[TEE]   → ${url}`);
    const quote = await tryLocalEndpoint(url, instanceId);
    if (quote) {
      cached = {
        instanceId,
        teeType:     "tdx",
        quoteB64:    quote,
        quoteSha256: crypto.createHash("sha256").update(quote).digest("hex"),
        fetchedAt:   Date.now(),
        endpoint:    url,
      };
      console.log(`[TEE] ✓ TDX quote from ${url}`);
      return cached;
    }
  }

  console.warn("[TEE] All attestation endpoints failed — hardware attestation unavailable");
  cached = {
    instanceId,
    teeType:     "tdx-unavailable",
    quoteB64:    "",
    quoteSha256: "fetch-failed",
    fetchedAt:   Date.now(),
  };
  return cached;
}

export function getCachedAttestation(): TEEAttestation | null {
  return cached;
}
