export class RequestTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = "RequestTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const rec = err as Record<string, unknown>;
  if (rec.name === "AbortError") return true;
  if (typeof rec.message === "string" && rec.message.toLowerCase().includes("signal is aborted")) return true;
  return false;
}

function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const filtered = signals.filter(Boolean) as AbortSignal[];
  if (filtered.length === 0) return undefined;
  const anyFn = (globalThis.AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal })?.any;
  if (typeof anyFn === "function") return anyFn(filtered);
  return undefined;
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: (RequestInit & { timeoutMs?: number }),
): Promise<Response> {
  const timeoutMs = init?.timeoutMs ?? 15000;
  const externalSignal: AbortSignal | undefined = init?.signal ?? undefined;
  const timeoutController = new AbortController();
  const combinedSignal = anySignal([externalSignal, timeoutController.signal]) ?? timeoutController.signal;
  const onExternalAbort = externalSignal && combinedSignal === timeoutController.signal ? () => timeoutController.abort() : null;
  if (externalSignal && onExternalAbort) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  let timedOut = false;
  const onTimeout = () => {
    timedOut = true;
    timeoutController.abort();
  };
  const timeout = setTimeout(onTimeout, timeoutMs);

  try {
    const res = await fetch(input, { ...init, signal: combinedSignal });
    return res;
  } catch (err) {
    if (timedOut && isAbortError(err)) {
      throw new RequestTimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    if (externalSignal && onExternalAbort) {
      try {
        externalSignal.removeEventListener("abort", onExternalAbort);
      } catch {
      }
    }
  }
}
