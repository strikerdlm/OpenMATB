import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getProcess, getSettings, getSystemCheck, postAction, saveSettings } from "./api";
import type {
  ProcessSnapshot,
  SettingsPayload,
  SettingsResponse,
  SystemCheckPayload,
} from "./types";

const POLL_INTERVAL_MS = 1500;
const MAX_SCREEN_INDEX = 16;
const MAX_EVENT_COUNT = 12;

type LauncherAction = "install" | "generate" | "launch";
type UiEventKind = "info" | "warning" | "action" | "error";
type ReadinessLevel = "ready" | "active" | "degraded" | "offline" | "invalid";

const ACTION_LABELS: Record<LauncherAction, string> = {
  generate: "Scenario generation",
  install: "Dependency installation",
  launch: "OpenMATB launch",
};

interface UiEvent {
  id: number;
  kind: UiEventKind;
  message: string;
  createdAt: number;
}

interface ScenarioInsight {
  path: string;
  label: string;
  category: string;
  intensity: "Low" | "Moderate" | "High";
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "Unexpected error";
}

function areSettingsEqual(left: SettingsPayload, right: SettingsPayload): boolean {
  return (
    left.language === right.language &&
    left.scenario_path === right.scenario_path &&
    left.screen_index === right.screen_index &&
    left.fullscreen === right.fullscreen &&
    left.display_session_number === right.display_session_number &&
    left.hide_on_pause === right.hide_on_pause &&
    left.highlight_aoi === right.highlight_aoi &&
    left.font_name === right.font_name
  );
}

function validateDraftSettings(
  draftSettings: SettingsPayload,
  settingsResponse: SettingsResponse,
): string[] {
  const errors: string[] = [];

  if (!settingsResponse.available_languages.includes(draftSettings.language)) {
    errors.push("Selected language is not in available locales.");
  }

  const normalizedScenario = draftSettings.scenario_path.trim();
  if (normalizedScenario.length === 0) {
    errors.push("Scenario path is required.");
  } else if (!settingsResponse.available_scenarios.includes(normalizedScenario)) {
    errors.push("Selected scenario does not exist.");
  }

  if (
    !Number.isInteger(draftSettings.screen_index) ||
    draftSettings.screen_index < 0 ||
    draftSettings.screen_index > MAX_SCREEN_INDEX
  ) {
    errors.push(`Screen index must be between 0 and ${MAX_SCREEN_INDEX}.`);
  }

  if (draftSettings.font_name.trim().length === 0) {
    errors.push("Font name cannot be empty.");
  }

  return errors;
}

function formatScenarioLabel(path: string): string {
  const segments = path.split("/");
  const rawName = segments.length > 0 ? segments[segments.length - 1] : path;
  const withoutExtension = rawName.replace(/\.[^.]+$/, "");
  const spaced = withoutExtension.replace(/[_-]+/g, " ").trim();
  if (spaced.length === 0) {
    return rawName;
  }

  return spaced.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function inferScenarioCategory(path: string): string {
  const normalized = path.toLowerCase();
  if (normalized.includes("/mwe/") || normalized.includes("mwe")) {
    return "MWE";
  }
  if (normalized.includes("training")) {
    return "Training";
  }
  if (normalized.includes("combat")) {
    return "Combat";
  }
  if (normalized.includes("night")) {
    return "Night Ops";
  }
  if (normalized.includes("comm")) {
    return "Communications";
  }
  return "General";
}

function inferScenarioIntensity(path: string): "Low" | "Moderate" | "High" {
  const normalized = path.toLowerCase();
  const highKeywords = ["high", "critical", "combat", "stress", "intense", "dense"];
  const moderateKeywords = ["med", "mid", "progressive", "standard", "baseline"];

  if (highKeywords.some((keyword) => normalized.includes(keyword))) {
    return "High";
  }
  if (moderateKeywords.some((keyword) => normalized.includes(keyword))) {
    return "Moderate";
  }
  return "Low";
}

function buildScenarioInsights(paths: string[]): ScenarioInsight[] {
  return paths.map((path) => ({
    path,
    label: formatScenarioLabel(path),
    category: inferScenarioCategory(path),
    intensity: inferScenarioIntensity(path),
  }));
}

function formatClock(timestampMs: number | null): string {
  if (timestampMs === null) {
    return "n/a";
  }
  return new Date(timestampMs).toLocaleTimeString([], { hour12: false });
}

function App() {
  const [settingsResponse, setSettingsResponse] = useState<SettingsResponse | null>(
    null,
  );
  const [draftSettings, setDraftSettings] = useState<SettingsPayload | null>(null);
  const [processSnapshot, setProcessSnapshot] = useState<ProcessSnapshot | null>(
    null,
  );
  const [systemCheck, setSystemCheck] = useState<SystemCheckPayload | null>(null);
  const [isBusy, setIsBusy] = useState<boolean>(false);
  const [isLoaded, setIsLoaded] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [infoMessage, setInfoMessage] = useState<string>("");
  const [isOnline, setIsOnline] = useState<boolean>(() => window.navigator.onLine);
  const [pollFailureCount, setPollFailureCount] = useState<number>(0);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [uiEvents, setUiEvents] = useState<UiEvent[]>([]);
  const eventIdRef = useRef<number>(0);
  const previousPollFailureRef = useRef<number>(0);

  const appendUiEvent = useCallback((kind: UiEventKind, message: string): void => {
    eventIdRef.current += 1;
    const nextEvent: UiEvent = {
      id: eventIdRef.current,
      kind,
      message,
      createdAt: Date.now(),
    };
    setUiEvents((previous) => [nextEvent, ...previous].slice(0, MAX_EVENT_COUNT));
  }, []);

  useEffect(() => {
    const onOnline = (): void => {
      setIsOnline(true);
      appendUiEvent("info", "Network link restored.");
    };
    const onOffline = (): void => {
      setIsOnline(false);
      appendUiEvent("warning", "Browser reports offline mode.");
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [appendUiEvent]);

  const refreshProcess = useCallback(async (): Promise<void> => {
    try {
      const snapshot = await getProcess();
      setProcessSnapshot(snapshot);
      setPollFailureCount(0);
    } catch (error) {
      setPollFailureCount((previous) => Math.min(previous + 1, 8));
      setInfoMessage((previous) =>
        previous.length > 0
          ? previous
          : `Telemetry retry in progress: ${toErrorMessage(error)}`,
      );
    }
  }, []);

  const loadPageData = useCallback(async (): Promise<void> => {
    setIsBusy(true);
    setErrorMessage("");
    setInfoMessage("");

    try {
      const [settings, process, check] = await Promise.all([
        getSettings(),
        getProcess(),
        getSystemCheck(),
      ]);
      setSettingsResponse(settings);
      setDraftSettings(settings.settings);
      setProcessSnapshot(process);
      setSystemCheck(check);
      setIsLoaded(true);
      setPollFailureCount(0);
      setLastSyncedAt(Date.now());
      setInfoMessage("Launcher data synchronized.");
      appendUiEvent("info", "Launcher data synchronized.");
    } catch (error) {
      const detail = `Failed to load launcher data: ${toErrorMessage(error)}`;
      setErrorMessage(detail);
      appendUiEvent("error", detail);
    } finally {
      setIsBusy(false);
    }
  }, [appendUiEvent]);

  useEffect(() => {
    void loadPageData();
  }, [loadPageData]);

  useEffect(() => {
    if (!isLoaded) {
      return;
    }

    const timerId = window.setInterval(() => {
      void refreshProcess();
    }, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(timerId);
    };
  }, [isLoaded, refreshProcess]);

  useEffect(() => {
    const previous = previousPollFailureRef.current;
    if (pollFailureCount > 0 && previous === 0) {
      appendUiEvent("warning", "Process telemetry became unstable.");
    } else if (pollFailureCount === 0 && previous > 0) {
      appendUiEvent("info", "Process telemetry recovered.");
    }
    previousPollFailureRef.current = pollFailureCount;
  }, [appendUiEvent, pollFailureCount]);

  const updateSetting = useCallback(
    <K extends keyof SettingsPayload>(key: K, value: SettingsPayload[K]): void => {
      setDraftSettings((previous) => {
        if (previous === null) {
          return previous;
        }
        return {
          ...previous,
          [key]: value,
        };
      });
    },
    [],
  );

  const hasRunningProcess = processSnapshot?.running ?? false;
  const disableFormControls = isBusy || hasRunningProcess || draftSettings === null;
  const disableRunActions =
    isBusy || hasRunningProcess || draftSettings === null || settingsResponse === null;

  const missingPackagesLabel = useMemo((): string => {
    if (systemCheck === null) {
      return "Not available";
    }
    if (systemCheck.missing_packages.length === 0) {
      return "none";
    }
    return systemCheck.missing_packages.join(", ");
  }, [systemCheck]);

  const validationErrors = useMemo((): string[] => {
    if (draftSettings === null || settingsResponse === null) {
      return [];
    }
    return validateDraftSettings(draftSettings, settingsResponse);
  }, [draftSettings, settingsResponse]);

  const hasValidationErrors = validationErrors.length > 0;
  const hasUnsavedChanges = useMemo((): boolean => {
    if (draftSettings === null || settingsResponse === null) {
      return false;
    }
    return !areSettingsEqual(draftSettings, settingsResponse.settings);
  }, [draftSettings, settingsResponse]);

  const scenarioInsights = useMemo((): ScenarioInsight[] => {
    if (settingsResponse === null) {
      return [];
    }
    return buildScenarioInsights(settingsResponse.available_scenarios);
  }, [settingsResponse]);

  const readinessLevel = useMemo((): ReadinessLevel => {
    if (!isOnline) {
      return "offline";
    }
    if (hasValidationErrors) {
      return "invalid";
    }
    if ((systemCheck?.missing_packages.length ?? 0) > 0) {
      return "degraded";
    }
    if (hasRunningProcess) {
      return "active";
    }
    return "ready";
  }, [hasRunningProcess, hasValidationErrors, isOnline, systemCheck?.missing_packages.length]);

  const readinessLabel = useMemo((): string => {
    if (readinessLevel === "active") {
      return "Active";
    }
    if (readinessLevel === "degraded") {
      return "Degraded";
    }
    if (readinessLevel === "offline") {
      return "Offline";
    }
    if (readinessLevel === "invalid") {
      return "Invalid Config";
    }
    return "Ready";
  }, [readinessLevel]);

  const readinessSummary = useMemo((): string => {
    if (readinessLevel === "active") {
      return "An operation is currently running.";
    }
    if (readinessLevel === "degraded") {
      return "Missing packages or checks require operator attention.";
    }
    if (readinessLevel === "offline") {
      return "Browser network state is offline.";
    }
    if (readinessLevel === "invalid") {
      return "Configuration checks must be resolved before launch.";
    }
    return "System checks and configuration look good.";
  }, [readinessLevel]);

  const saveDraftSettings = useCallback(async (): Promise<void> => {
    if (draftSettings === null || settingsResponse === null) {
      throw new Error("No settings available to save.");
    }

    const errors = validateDraftSettings(draftSettings, settingsResponse);
    if (errors.length > 0) {
      throw new Error(`Configuration check failed: ${errors.join(" ")}`);
    }

    const payload: SettingsPayload = {
      ...draftSettings,
      scenario_path: draftSettings.scenario_path.trim(),
      font_name: draftSettings.font_name.trim(),
    };
    const saved = await saveSettings(payload);
    setSettingsResponse(saved);
    setDraftSettings(saved.settings);
    setLastSyncedAt(Date.now());
    setInfoMessage("Configuration saved.");
    appendUiEvent("info", "Configuration saved.");
  }, [appendUiEvent, draftSettings, settingsResponse]);

  const runAction = useCallback(
    async (action: LauncherAction): Promise<void> => {
      if (draftSettings === null || settingsResponse === null) {
        const detail = "Action blocked: launcher settings are not initialized.";
        setErrorMessage(detail);
        appendUiEvent("error", detail);
        return;
      }

      const errors = validateDraftSettings(draftSettings, settingsResponse);
      if (errors.length > 0) {
        const detail = `Action blocked: ${errors.join(" ")}`;
        setErrorMessage(detail);
        appendUiEvent("warning", detail);
        return;
      }

      setIsBusy(true);
      setErrorMessage("");
      setInfoMessage("");

      try {
        if (hasUnsavedChanges) {
          await saveDraftSettings();
        }
        const snapshot = await postAction(action);
        setProcessSnapshot(snapshot);
        const detail = `${ACTION_LABELS[action]} initiated.`;
        setInfoMessage(detail);
        appendUiEvent("action", detail);
      } catch (error) {
        const detail = `Unable to start action "${action}": ${toErrorMessage(error)}`;
        setErrorMessage(detail);
        appendUiEvent("error", detail);
      } finally {
        setIsBusy(false);
      }
    },
    [appendUiEvent, draftSettings, hasUnsavedChanges, saveDraftSettings, settingsResponse],
  );

  const stopAction = useCallback(async (): Promise<void> => {
    setIsBusy(true);
    setErrorMessage("");
    setInfoMessage("");

    try {
      const snapshot = await postAction("stop");
      setProcessSnapshot(snapshot);
      setInfoMessage("Stop requested.");
      appendUiEvent("action", "Stop requested.");
    } catch (error) {
      const detail = `Unable to stop process: ${toErrorMessage(error)}`;
      setErrorMessage(detail);
      appendUiEvent("error", detail);
    } finally {
      setIsBusy(false);
    }
  }, [appendUiEvent]);

  const onSaveClicked = useCallback(async (): Promise<void> => {
    setIsBusy(true);
    setErrorMessage("");
    setInfoMessage("");

    try {
      await saveDraftSettings();
    } catch (error) {
      const detail = `Unable to save configuration: ${toErrorMessage(error)}`;
      setErrorMessage(detail);
      appendUiEvent("error", detail);
    } finally {
      setIsBusy(false);
    }
  }, [appendUiEvent, saveDraftSettings]);

  const telemetryLabel = useMemo((): string => {
    if (pollFailureCount === 0) {
      return "Telemetry live";
    }
    if (pollFailureCount < 3) {
      return "Telemetry unstable";
    }
    return "Telemetry degraded";
  }, [pollFailureCount]);

  const telemetryClass = useMemo((): string => {
    if (pollFailureCount === 0) {
      return "chip-live";
    }
    if (pollFailureCount < 3) {
      return "chip-warning";
    }
    return "chip-danger";
  }, [pollFailureCount]);

  if (!isLoaded || draftSettings === null || settingsResponse === null) {
    return (
      <main className="ops-page">
        <section className="panel panel-hero loading-panel">
          <h1>OpenMATB Tactical Console</h1>
          <p>Synchronizing launcher services and scenario inventory...</p>
          {errorMessage.length > 0 ? <p className="error">{errorMessage}</p> : null}
          <div className="action-row">
            <button
              type="button"
              disabled={isBusy}
              onClick={() => {
                void loadPageData();
              }}
            >
              Retry Sync
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="ops-page">
      <section className="panel panel-hero">
        <div className="hero-row">
          <div className="hero-copy">
            <h1>OpenMATB Tactical Console</h1>
            <p className="hero-description">
              Mission-ready web control surface for scenario selection, process control,
              and telemetry monitoring.
            </p>
            <p className="hint">Last full sync: {formatClock(lastSyncedAt)}</p>
          </div>
          <div className={`readiness-pill readiness-${readinessLevel}`}>{readinessLabel}</div>
        </div>
        <p className="status">{readinessSummary}</p>
        <div className="action-row">
          <button
            type="button"
            onClick={() => {
              void loadPageData();
            }}
            disabled={isBusy}
          >
            Refresh Console
          </button>
          <button
            type="button"
            onClick={() => {
              void refreshProcess();
            }}
            disabled={isBusy}
          >
            Refresh Telemetry
          </button>
        </div>
      </section>

      {infoMessage.length > 0 ? <p className="banner info">{infoMessage}</p> : null}
      {errorMessage.length > 0 ? <p className="banner error">{errorMessage}</p> : null}
      {pollFailureCount > 0 ? (
        <p className="banner warning">
          Live process telemetry is delayed. Automatic retry is active.
        </p>
      ) : null}

      <section className="metric-grid">
        <article className="metric-card">
          <p className="metric-label">Scenarios Indexed</p>
          <p className="metric-value">{settingsResponse.available_scenarios.length}</p>
        </article>
        <article className="metric-card">
          <p className="metric-label">Locales Available</p>
          <p className="metric-value">{settingsResponse.available_languages.length}</p>
        </article>
        <article className="metric-card">
          <p className="metric-label">Missing Packages</p>
          <p className="metric-value">{systemCheck?.missing_packages.length ?? 0}</p>
        </article>
        <article className="metric-card">
          <p className="metric-label">Network</p>
          <p className="metric-value">{isOnline ? "Online" : "Offline"}</p>
        </article>
      </section>

      <section className="workspace-grid">
        <article className="panel">
          <div className="panel-header">
            <h2>Scenario Intelligence</h2>
            <span className="hint">{scenarioInsights.length} scenarios detected</span>
          </div>
          <p className="hint">
            Missing Python packages: <strong>{missingPackagesLabel}</strong>
          </p>
          <div className="scenario-grid">
            {scenarioInsights.map((scenario) => {
              const isSelected = scenario.path === draftSettings.scenario_path;
              return (
                <button
                  key={scenario.path}
                  type="button"
                  className={`scenario-card${isSelected ? " selected" : ""}`}
                  disabled={disableFormControls}
                  onClick={() => {
                    updateSetting("scenario_path", scenario.path);
                  }}
                >
                  <span className="scenario-path">{scenario.path}</span>
                  <strong>{scenario.label}</strong>
                  <span className="hint">
                    Category: {scenario.category} | Intensity: {scenario.intensity}
                  </span>
                </button>
              );
            })}
          </div>
        </article>

        <article className="panel">
          <h2>Configuration Controls</h2>
          <p className="hint">
            {hasUnsavedChanges ? "Unsaved changes pending." : "Configuration is synchronized."}
          </p>

          <div className="form-grid">
            <label>
              Language
              <select
                value={draftSettings.language}
                onChange={(event) => {
                  updateSetting("language", event.target.value);
                }}
                disabled={disableFormControls}
              >
                {settingsResponse.available_languages.map((languageOption) => (
                  <option key={languageOption} value={languageOption}>
                    {languageOption}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Scenario
              <select
                value={draftSettings.scenario_path}
                onChange={(event) => {
                  updateSetting("scenario_path", event.target.value);
                }}
                disabled={disableFormControls}
              >
                {settingsResponse.available_scenarios.map((scenarioOption) => (
                  <option key={scenarioOption} value={scenarioOption}>
                    {scenarioOption}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Screen Index
              <input
                type="number"
                min={0}
                max={MAX_SCREEN_INDEX}
                value={draftSettings.screen_index}
                onChange={(event) => {
                  const parsed = Number.parseInt(event.target.value, 10);
                  if (Number.isNaN(parsed)) {
                    return;
                  }
                  const bounded = Math.max(0, Math.min(MAX_SCREEN_INDEX, parsed));
                  updateSetting("screen_index", bounded);
                }}
                disabled={disableFormControls}
              />
            </label>

            <label>
              Font Name
              <input
                type="text"
                value={draftSettings.font_name}
                onChange={(event) => {
                  updateSetting("font_name", event.target.value);
                }}
                disabled={disableFormControls}
              />
            </label>
          </div>

          <div className="check-grid">
            <label className="check-option">
              <input
                type="checkbox"
                checked={draftSettings.fullscreen}
                onChange={(event) => {
                  updateSetting("fullscreen", event.target.checked);
                }}
                disabled={disableFormControls}
              />
              <span>Fullscreen</span>
            </label>
            <label className="check-option">
              <input
                type="checkbox"
                checked={draftSettings.display_session_number}
                onChange={(event) => {
                  updateSetting("display_session_number", event.target.checked);
                }}
                disabled={disableFormControls}
              />
              <span>Display Session ID</span>
            </label>
            <label className="check-option">
              <input
                type="checkbox"
                checked={draftSettings.hide_on_pause}
                onChange={(event) => {
                  updateSetting("hide_on_pause", event.target.checked);
                }}
                disabled={disableFormControls}
              />
              <span>Hide On Pause</span>
            </label>
            <label className="check-option">
              <input
                type="checkbox"
                checked={draftSettings.highlight_aoi}
                onChange={(event) => {
                  updateSetting("highlight_aoi", event.target.checked);
                }}
                disabled={disableFormControls}
              />
              <span>Highlight AOI</span>
            </label>
          </div>

          {hasValidationErrors ? (
            <div className="validation-box">
              <h3>Configuration checks</h3>
              <ul>
                {validationErrors.map((validationError, index) => (
                  <li key={`${validationError}-${index}`}>{validationError}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="hint success-hint">Configuration checks passed.</p>
          )}

          <div className="action-row">
            <button
              type="button"
              onClick={() => {
                void onSaveClicked();
              }}
              disabled={disableFormControls || !hasUnsavedChanges || hasValidationErrors}
            >
              Save Config
            </button>
            <button
              type="button"
              className="action-primary"
              onClick={() => {
                void runAction("launch");
              }}
              disabled={disableRunActions || hasValidationErrors}
            >
              Launch OpenMATB
            </button>
            <button
              type="button"
              onClick={() => {
                void runAction("generate");
              }}
              disabled={disableRunActions || hasValidationErrors}
            >
              Generate Scenario
            </button>
            <button
              type="button"
              onClick={() => {
                void runAction("install");
              }}
              disabled={disableRunActions || hasValidationErrors}
            >
              Install Dependencies
            </button>
            <button
              type="button"
              className="action-danger"
              onClick={() => {
                void stopAction();
              }}
              disabled={isBusy || !hasRunningProcess}
            >
              Stop Process
            </button>
          </div>
        </article>
      </section>

      <section className="workspace-grid">
        <article className="panel">
          <div className="panel-header">
            <h2>Process Telemetry</h2>
            <div className="chip-row">
              <span className={`chip ${hasRunningProcess ? "chip-live" : "chip-neutral"}`}>
                {hasRunningProcess ? "Running" : "Idle"}
              </span>
              <span className={`chip ${telemetryClass}`}>{telemetryLabel}</span>
            </div>
          </div>
          <p className="status">
            <strong>Status:</strong>{" "}
            {processSnapshot?.status_message ?? "No process status available."}
          </p>
          <p className="hint">
            Current action: {processSnapshot?.current_action ?? "none"} | Last exit code:{" "}
            {processSnapshot?.last_exit_code ?? "n/a"}
          </p>
          <p className="hint">Latest {processSnapshot?.logs.length ?? 0} log lines retained.</p>
          <pre className="log-area">
            {processSnapshot !== null && processSnapshot.logs.length > 0
              ? processSnapshot.logs.join("\n")
              : "No process logs yet."}
          </pre>
        </article>

        <article className="panel">
          <h2>Command Timeline</h2>
          {uiEvents.length > 0 ? (
            <ul className="event-list">
              {uiEvents.map((event) => (
                <li key={event.id} className={`event-item ${event.kind}`}>
                  <span className="event-time">{formatClock(event.createdAt)}</span>
                  <span>{event.message}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">No events recorded yet.</p>
          )}
        </article>
      </section>

      <section className="panel">
        <h2>Scenario Readback</h2>
        <p className="hint">
          Selected scenario path: <strong>{draftSettings.scenario_path}</strong>
        </p>
        <p className="hint">
          Scenario selection should match mission profile, workload targets, and operator
          training stage.
        </p>
      </section>
    </main>
  );
}

export default App;
