export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: (RequestInit & { timeoutMs?: number })
): Promise<Response> {
  const timeoutMs = init?.timeoutMs ?? 15000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(input, { ...init, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

