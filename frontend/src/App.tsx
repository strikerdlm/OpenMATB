import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getProcess,
  getSettings,
  getSystemCheck,
  postAction,
  saveSettings,
} from "./api";
import type {
  ProcessSnapshot,
  SettingsPayload,
  SettingsResponse,
  SystemCheckPayload,
} from "./types";

const POLL_INTERVAL_MS = 1500;

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "Unexpected error";
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

  const refreshProcess = useCallback(async (): Promise<void> => {
    try {
      const snapshot = await getProcess();
      setProcessSnapshot(snapshot);
    } catch (error) {
      setErrorMessage(`Failed to refresh process state: ${toErrorMessage(error)}`);
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
      setInfoMessage("Launcher data loaded.");
    } catch (error) {
      setErrorMessage(`Failed to load launcher data: ${toErrorMessage(error)}`);
    } finally {
      setIsBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadPageData();
  }, [loadPageData]);

  useEffect(() => {
    const timerId = window.setInterval(() => {
      void refreshProcess();
    }, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(timerId);
    };
  }, [refreshProcess]);

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

  const missingPackagesLabel = useMemo((): string => {
    if (systemCheck === null) {
      return "Not available";
    }
    if (systemCheck.missing_packages.length === 0) {
      return "none";
    }
    return systemCheck.missing_packages.join(", ");
  }, [systemCheck]);

  const saveDraftSettings = useCallback(async (): Promise<void> => {
    if (draftSettings === null) {
      throw new Error("No settings available to save.");
    }

    const saved = await saveSettings(draftSettings);
    setSettingsResponse(saved);
    setDraftSettings(saved.settings);
    setInfoMessage("Configuration saved.");
  }, [draftSettings]);

  const runAction = useCallback(
    async (action: "install" | "generate" | "launch"): Promise<void> => {
      setIsBusy(true);
      setErrorMessage("");
      setInfoMessage("");

      try {
        await saveDraftSettings();
        const snapshot = await postAction(action);
        setProcessSnapshot(snapshot);
        setInfoMessage(`Action started: ${action}`);
      } catch (error) {
        setErrorMessage(`Unable to start action "${action}": ${toErrorMessage(error)}`);
      } finally {
        setIsBusy(false);
      }
    },
    [saveDraftSettings],
  );

  const stopAction = useCallback(async (): Promise<void> => {
    setIsBusy(true);
    setErrorMessage("");
    setInfoMessage("");

    try {
      const snapshot = await postAction("stop");
      setProcessSnapshot(snapshot);
      setInfoMessage("Stop requested.");
    } catch (error) {
      setErrorMessage(`Unable to stop process: ${toErrorMessage(error)}`);
    } finally {
      setIsBusy(false);
    }
  }, []);

  const onSaveClicked = useCallback(async (): Promise<void> => {
    setIsBusy(true);
    setErrorMessage("");
    setInfoMessage("");

    try {
      await saveDraftSettings();
    } catch (error) {
      setErrorMessage(`Unable to save configuration: ${toErrorMessage(error)}`);
    } finally {
      setIsBusy(false);
    }
  }, [saveDraftSettings]);

  if (!isLoaded || draftSettings === null || settingsResponse === null) {
    return (
      <main className="page">
        <section className="panel">
          <h1>OpenMATB Web Launcher</h1>
          <p>Loading launcher data...</p>
          {errorMessage.length > 0 ? <p className="error">{errorMessage}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="page">
      <section className="panel">
        <header className="panel-header">
          <h1>OpenMATB Web Launcher</h1>
          <button
            type="button"
            onClick={() => {
              void loadPageData();
            }}
            disabled={isBusy}
          >
            Refresh
          </button>
        </header>

        <p className="status">
          <strong>Status:</strong>{" "}
          {processSnapshot?.status_message ?? "No process status available."}
        </p>

        {infoMessage.length > 0 ? <p className="info">{infoMessage}</p> : null}
        {errorMessage.length > 0 ? <p className="error">{errorMessage}</p> : null}

        <div className="meta-grid">
          <div>
            <strong>Config file:</strong>{" "}
            {systemCheck?.config_exists ? "present" : "missing"}
          </div>
          <div>
            <strong>Languages found:</strong> {systemCheck?.available_languages.length ?? 0}
          </div>
          <div>
            <strong>Scenarios found:</strong> {systemCheck?.available_scenarios.length ?? 0}
          </div>
          <div>
            <strong>Missing Python packages:</strong> {missingPackagesLabel}
          </div>
        </div>
      </section>

      <section className="panel">
        <h2>Configuration</h2>
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
              max={16}
              value={draftSettings.screen_index}
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10);
                if (Number.isNaN(parsed)) {
                  return;
                }
                updateSetting("screen_index", parsed);
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
          <label>
            <input
              type="checkbox"
              checked={draftSettings.fullscreen}
              onChange={(event) => {
                updateSetting("fullscreen", event.target.checked);
              }}
              disabled={disableFormControls}
            />
            Fullscreen
          </label>
          <label>
            <input
              type="checkbox"
              checked={draftSettings.display_session_number}
              onChange={(event) => {
                updateSetting("display_session_number", event.target.checked);
              }}
              disabled={disableFormControls}
            />
            Display Session ID
          </label>
          <label>
            <input
              type="checkbox"
              checked={draftSettings.hide_on_pause}
              onChange={(event) => {
                updateSetting("hide_on_pause", event.target.checked);
              }}
              disabled={disableFormControls}
            />
            Hide On Pause
          </label>
          <label>
            <input
              type="checkbox"
              checked={draftSettings.highlight_aoi}
              onChange={(event) => {
                updateSetting("highlight_aoi", event.target.checked);
              }}
              disabled={disableFormControls}
            />
            Highlight AOI
          </label>
        </div>

        <div className="action-row">
          <button
            type="button"
            onClick={() => {
              void onSaveClicked();
            }}
            disabled={disableFormControls}
          >
            Save Config
          </button>
          <button
            type="button"
            onClick={() => {
              void runAction("launch");
            }}
            disabled={isBusy || hasRunningProcess}
          >
            Launch OpenMATB
          </button>
          <button
            type="button"
            onClick={() => {
              void runAction("generate");
            }}
            disabled={isBusy || hasRunningProcess}
          >
            Generate Scenario
          </button>
          <button
            type="button"
            onClick={() => {
              void runAction("install");
            }}
            disabled={isBusy || hasRunningProcess}
          >
            Install Dependencies
          </button>
          <button
            type="button"
            onClick={() => {
              void stopAction();
            }}
            disabled={isBusy || !hasRunningProcess}
          >
            Stop Process
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>Process Output</h2>
        <p className="hint">Latest {processSnapshot?.logs.length ?? 0} log lines retained.</p>
        <pre className="log-area">
          {processSnapshot !== null && processSnapshot.logs.length > 0
            ? processSnapshot.logs.join("\n")
            : "No process logs yet."}
        </pre>
      </section>
    </main>
  );
}

export default App;
