interface TurnstileResponse {
  success?: boolean;
  "error-codes"?: string[];
}

export async function verifyTurnstile(
  secret: string,
  token: string | undefined,
  remoteIp?: string,
): Promise<void> {
  if (!token) {
    throw new Error("Turnstile token is missing");
  }

  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) {
    body.set("remoteip", remoteIp);
  }

  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      body,
      signal: AbortSignal.timeout(8_000),
    },
  );
  const result = (await response.json()) as TurnstileResponse;
  if (!response.ok || !result.success) {
    throw new Error(
      `Turnstile rejected: ${(result["error-codes"] ?? []).join(",")}`,
    );
  }
}
