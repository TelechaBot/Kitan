interface SiteverifyResponse {
  success?: boolean;
  hostname?: string;
  "error-codes"?: string[];
}

// Returns null on success, otherwise the failure reason (recorded for measurement).
export async function verifyTurnstile(
  secret: string,
  token: string | undefined,
  remoteIp: string | null,
  expectedHostname: string,
): Promise<string | null> {
  if (!token) {
    return "missing-token";
  }
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) {
    body.set("remoteip", remoteIp);
  }
  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body, signal: AbortSignal.timeout(8_000) },
  );
  const result = (await response.json().catch(() => ({}))) as SiteverifyResponse;
  if (!response.ok || !result.success) {
    return (result["error-codes"] ?? [`http-${response.status}`]).join(",") || "rejected";
  }
  if (result.hostname !== expectedHostname) {
    return `hostname-mismatch:${result.hostname}`;
  }
  return null;
}
