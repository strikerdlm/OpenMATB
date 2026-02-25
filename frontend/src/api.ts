import type {
  ProcessSnapshot,
  SettingsPayload,
  SettingsResponse,
  SystemCheckPayload,
} from "./types";

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const textBody = await response.text();
  const parsed = textBody.length > 0 ? (JSON.parse(textBody) as unknown) : null;

  if (!response.ok) {
    const detail = extractErrorDetail(parsed);
    throw new Error(detail ?? `Request failed (${response.status})`);
  }
  return parsed as T;
}

function extractErrorDetail(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.detail === "string" && candidate.detail.length > 0) {
    return candidate.detail;
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
