import type {
  MetarPayload,
  ProcessSnapshot,
  SettingsPayload,
  SettingsResponse,
  SystemCheckPayload,
} from "./types";

const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;
const GET_REQUEST_RETRY_COUNT = 2;
const RETRY_BACKOFF_MS = 350;

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

function isRetriableStatus(statusCode: number): boolean {
  return statusCode === 429 || statusCode >= 500;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function parseResponseBody(payload: string, contentType: string, path: string): unknown {
  const trimmedPayload = payload.trim();
  if (trimmedPayload.length === 0) {
    return null;
  }

  const normalizedContentType = contentType.toLowerCase();
  const expectsJson =
    normalizedContentType.includes("application/json") ||
    trimmedPayload.startsWith("{") ||
    trimmedPayload.startsWith("[");
  if (!expectsJson) {
    return trimmedPayload;
  }

  try {
    return JSON.parse(trimmedPayload) as unknown;
  } catch {
    throw new Error(`Received malformed JSON from ${path}`);
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method?.toUpperCase() ?? "GET";
  const maxRetries = method === "GET" ? GET_REQUEST_RETRY_COUNT : 0;
  const timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  let attempt = 0;

  while (attempt <= maxRetries) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(path, {
        ...init,
        signal: controller.signal,
      });
      const textBody = await response.text();
      const parsed = parseResponseBody(
        textBody,
        response.headers.get("content-type") ?? "",
        path,
      );

      if (!response.ok) {
        const detail = extractErrorDetail(parsed);
        const fallback = `Request failed (${response.status})`;
        if (attempt < maxRetries && isRetriableStatus(response.status)) {
          attempt += 1;
          await sleep(RETRY_BACKOFF_MS * attempt);
          continue;
        }
        throw new Error(detail ?? fallback);
      }

      if (parsed === null || typeof parsed !== "object") {
        throw new Error(`Received unexpected response format from ${path}`);
      }

      return parsed as T;
    } catch (error) {
      if (attempt < maxRetries) {
        if (isAbortError(error) || error instanceof TypeError) {
          attempt += 1;
          await sleep(RETRY_BACKOFF_MS * attempt);
          continue;
        }
      }

      if (isAbortError(error)) {
        throw new Error(`Request timed out after ${timeoutMs}ms: ${path}`);
      }
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Request failed for ${path}`);
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  throw new Error(`Request failed after retries: ${path}`);
}

function extractErrorDetail(payload: unknown): string | null {
  if (typeof payload === "string" && payload.length > 0) {
    return payload;
  }
  if (payload === null || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.detail === "string" && candidate.detail.length > 0) {
    return candidate.detail;
  }
  if (typeof candidate.error === "string" && candidate.error.length > 0) {
    return candidate.error;
  }
  if (typeof candidate.message === "string" && candidate.message.length > 0) {
    return candidate.message;
  }
  return null;
}

export async function getSettings(): Promise<SettingsResponse> {
  return requestJson<SettingsResponse>("/api/settings");
}

export async function saveSettings(
  settings: SettingsPayload,
): Promise<SettingsResponse> {
  return requestJson<SettingsResponse>("/api/settings", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(settings),
  });
}

export async function getSystemCheck(): Promise<SystemCheckPayload> {
  return requestJson<SystemCheckPayload>("/api/system-check");
}

export async function getProcess(): Promise<ProcessSnapshot> {
  return requestJson<ProcessSnapshot>("/api/process");
}

export async function postAction(action: string): Promise<ProcessSnapshot> {
  return requestJson<ProcessSnapshot>(`/api/actions/${action}`, {
    method: "POST",
  });
}

export async function getMetar(
  sessionId: string,
  scenarioPath: string,
  forceRefresh: boolean,
): Promise<MetarPayload> {
  const queryParams = new URLSearchParams({
    session_id: sessionId,
    scenario_path: scenarioPath,
    force_refresh: String(forceRefresh),
  });
  return requestJson<MetarPayload>(`/api/distractions/metar?${queryParams.toString()}`);
}
