import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getMetar,
  getProcess,
  getSettings,
  getSystemCheck,
  postAction,
  saveSettings,
} from "./api";
import type {
  MetarPayload,
  ProcessSnapshot,
  SettingsPayload,
  SettingsResponse,
  SystemCheckPayload,
} from "./types";

const POLL_INTERVAL_MS = 1500;
const METAR_REFRESH_INTERVAL_MS = 90_000;
const MAX_SCREEN_INDEX = 16;
const MAX_EVENT_COUNT = 12;
const DIAL_START_ANGLE = -130;
const DIAL_SWEEP_ANGLE = 260;
const ALL_SCENARIO_CATEGORIES = "All categories";
const TELEMETRY_RETRY_PREFIX = "Telemetry retry in progress:";

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

interface GaugeBand {
  startRatio: number;
  endRatio: number;
  className: string;
}

interface CockpitGauge {
  key: string;
  label: string;
  units: string;
  min: number;
  max: number;
  value: number;
  precision?: number;
  bands: GaugeBand[];
}

interface CockpitProfile {
  aircraftName: string;
  missionMode: string;
  gauges: CockpitGauge[];
}

function clamp(value: number, minValue: number, maxValue: number): number {
  if (value < minValue) {
    return minValue;
  }
  if (value > maxValue) {
    return maxValue;
  }
  return value;
}

function createSessionId(): string {
  if (typeof window.crypto?.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `${timestamp}-${randomPart}`;
}

function polarPoint(radius: number, angleDegrees: number): { x: number; y: number } {
  const radians = ((angleDegrees - 90) * Math.PI) / 180;
  return {
    x: 90 + radius * Math.cos(radians),
    y: 90 + radius * Math.sin(radians),
  };
}

function dialArcPath(startRatio: number, endRatio: number, radius: number): string {
  const startAngle = DIAL_START_ANGLE + DIAL_SWEEP_ANGLE * startRatio;
  const endAngle = DIAL_START_ANGLE + DIAL_SWEEP_ANGLE * endRatio;
  const startPoint = polarPoint(radius, startAngle);
  const endPoint = polarPoint(radius, endAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return [
    "M",
    startPoint.x.toFixed(2),
    startPoint.y.toFixed(2),
    "A",
    radius,
    radius,
    0,
    largeArc,
    1,
    endPoint.x.toFixed(2),
    endPoint.y.toFixed(2),
  ].join(" ");
}

function formatDialValue(value: number, precision: number | undefined): string {
  const digits = precision ?? 0;
  return value.toFixed(digits);
}

function normalizeScenarioSeed(path: string): number {
  let hash = 0;
  for (let index = 0; index < path.length; index += 1) {
    hash = (hash * 31 + path.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function defaultGaugeBands(): GaugeBand[] {
  return [
    { startRatio: 0, endRatio: 0.68, className: "dial-band-safe" },
    { startRatio: 0.68, endRatio: 0.87, className: "dial-band-caution" },
    { startRatio: 0.87, endRatio: 1, className: "dial-band-danger" },
  ];
}

function metarDrivenBands(): GaugeBand[] {
  return [
    { startRatio: 0, endRatio: 0.55, className: "dial-band-danger" },
    { startRatio: 0.55, endRatio: 0.8, className: "dial-band-caution" },
    { startRatio: 0.8, endRatio: 1, className: "dial-band-safe" },
  ];
}

function buildCockpitProfile(
  selectedScenario: ScenarioInsight | null,
  metarPayload: MetarPayload | null,
): CockpitProfile {
  const category = selectedScenario?.category ?? "General";
  const intensity = selectedScenario?.intensity ?? "Low";
  const seed = normalizeScenarioSeed(selectedScenario?.path ?? "default");

  let aircraftName = "C172 Training Deck";
  let missionMode = "Baseline handling and instrument scan.";
  let baseAirspeed = 105;
  let baseAltitude = 3200;
  let baseVerticalSpeed = 200;

  if (category === "Combat") {
    aircraftName = "F16 Intercept Deck";
    missionMode = "High-energy intercept and rapid scan transitions.";
    baseAirspeed = 390;
    baseAltitude = 19000;
    baseVerticalSpeed = 1800;
  } else if (category === "Night Ops") {
    aircraftName = "B737 Night Approach";
    missionMode = "Stabilized descent under reduced visual cues.";
    baseAirspeed = 165;
    baseAltitude = 7800;
    baseVerticalSpeed = -700;
  } else if (category === "Communications") {
    aircraftName = "A320 IFR Radio Workload";
    missionMode = "Avionics and ATC prioritization under workload.";
    baseAirspeed = 245;
    baseAltitude = 11200;
    baseVerticalSpeed = 350;
  } else if (category === "MWE") {
    aircraftName = "C152 Familiarization";
    missionMode = "Fundamental workload balancing for beginners.";
    baseAirspeed = 92;
    baseAltitude = 2500;
    baseVerticalSpeed = 120;
  }

  const intensityMultiplier = intensity === "High" ? 1.22 : intensity === "Moderate" ? 1 : 0.86;
  const heading = (seed % 360) + (metarPayload?.wind_degrees ?? 0) * 0.08;
  const windComponent = metarPayload?.wind_speed_kt ?? 8;
  const visibilitySm = metarPayload?.visibility_sm ?? 10;
  const ceilingFt = metarPayload?.ceiling_ft ?? 9000;

  const gauges: CockpitGauge[] = [
    {
      key: "airspeed",
      label: "Airspeed",
      units: "KT",
      min: 40,
      max: 520,
      value: clamp(baseAirspeed * intensityMultiplier + windComponent * 0.7, 40, 520),
      bands: defaultGaugeBands(),
    },
    {
      key: "altitude",
      label: "Altitude",
      units: "FT",
      min: 0,
      max: 42000,
      value: clamp(baseAltitude + (seed % 1700) + windComponent * 35, 0, 42000),
      bands: defaultGaugeBands(),
    },
    {
      key: "vertical-speed",
      label: "V/S",
      units: "FT/MIN",
      min: -3000,
      max: 3000,
      value: clamp(baseVerticalSpeed + (seed % 500) - 250, -3000, 3000),
      bands: [
        { startRatio: 0, endRatio: 0.2, className: "dial-band-danger" },
        { startRatio: 0.2, endRatio: 0.35, className: "dial-band-caution" },
        { startRatio: 0.35, endRatio: 0.65, className: "dial-band-safe" },
        { startRatio: 0.65, endRatio: 0.8, className: "dial-band-caution" },
        { startRatio: 0.8, endRatio: 1, className: "dial-band-danger" },
      ],
    },
    {
      key: "heading",
      label: "Heading",
      units: "DEG",
      min: 0,
      max: 360,
      value: clamp(heading, 0, 360),
      bands: defaultGaugeBands(),
    },
    {
      key: "metar-wind",
      label: "METAR Wind",
      units: "KT",
      min: 0,
      max: 60,
      value: clamp(windComponent, 0, 60),
      bands: defaultGaugeBands(),
    },
    {
      key: "metar-visibility",
      label: "Visibility",
      units: "SM",
      min: 0,
      max: 12,
      value: clamp(visibilitySm, 0, 12),
      precision: 1,
      bands: metarDrivenBands(),
    },
    {
      key: "metar-ceiling",
      label: "Ceiling",
      units: "FT",
      min: 0,
      max: 12000,
      value: clamp(ceilingFt, 0, 12000),
      bands: metarDrivenBands(),
    },
    {
      key: "metar-altimeter",
      label: "Altimeter",
      units: "INHG",
      min: 28,
      max: 31,
      value: clamp(metarPayload?.altimeter_inhg ?? 29.92, 28, 31),
      precision: 2,
      bands: defaultGaugeBands(),
    },
  ];

  return {
    aircraftName,
    missionMode,
    gauges,
  };
}

function InstrumentDial({ gauge }: { gauge: CockpitGauge }) {
  const ratio = clamp((gauge.value - gauge.min) / (gauge.max - gauge.min), 0, 1);
  const needleAngle = DIAL_START_ANGLE + ratio * DIAL_SWEEP_ANGLE;
  const ticks = Array.from({ length: 11 }, (_, index) => {
    const tickRatio = index / 10;
    const angle = DIAL_START_ANGLE + tickRatio * DIAL_SWEEP_ANGLE;
    const outer = polarPoint(73, angle);
    const inner = polarPoint(index % 2 === 0 ? 56 : 62, angle);
    return {
      key: index,
      className: index % 2 === 0 ? "dial-tick-major" : "dial-tick-minor",
      inner,
      outer,
    };
  });
  const needleTip = polarPoint(52, needleAngle);

  return (
    <article className="instrument-dial">
      <div className="dial-face">
        <svg viewBox="0 0 180 180" aria-hidden="true">
          <circle className="dial-ring" cx="90" cy="90" r="74" />
          {gauge.bands.map((band) => (
            <path
              key={`${gauge.key}-${band.className}-${band.startRatio}`}
              className={`dial-band ${band.className}`}
              d={dialArcPath(band.startRatio, band.endRatio, 66)}
            />
          ))}
          {ticks.map((tick) => (
            <line
              key={`${gauge.key}-tick-${tick.key}`}
              className={tick.className}
              x1={tick.inner.x}
              y1={tick.inner.y}
              x2={tick.outer.x}
              y2={tick.outer.y}
            />
          ))}
          <line className="dial-needle" x1="90" y1="90" x2={needleTip.x} y2={needleTip.y} />
          <circle className="dial-hub" cx="90" cy="90" r="5.5" />
        </svg>
      </div>
      <p className="dial-label">{gauge.label}</p>
      <p className="dial-value">
        {formatDialValue(gauge.value, gauge.precision)} <span>{gauge.units}</span>
      </p>
    </article>
  );
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
  return paths
    .map((path) => ({
      path,
      label: formatScenarioLabel(path),
      category: inferScenarioCategory(path),
      intensity: inferScenarioIntensity(path),
    }))
    .sort((left, right) => {
      const categoryOrder = left.category.localeCompare(right.category);
      if (categoryOrder !== 0) {
        return categoryOrder;
      }
      return left.label.localeCompare(right.label);
    });
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
  const [metarErrorMessage, setMetarErrorMessage] = useState<string>("");
  const [metarPayload, setMetarPayload] = useState<MetarPayload | null>(null);
  const [isMetarBusy, setIsMetarBusy] = useState<boolean>(false);
  const [lastMetarSyncAt, setLastMetarSyncAt] = useState<number | null>(null);
  const [sessionId] = useState<string>(createSessionId);
  const [isOnline, setIsOnline] = useState<boolean>(() => window.navigator.onLine);
  const [pollFailureCount, setPollFailureCount] = useState<number>(0);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [uiEvents, setUiEvents] = useState<UiEvent[]>([]);
  const [scenarioQuery, setScenarioQuery] = useState<string>("");
  const [scenarioCategoryFilter, setScenarioCategoryFilter] =
    useState<string>(ALL_SCENARIO_CATEGORIES);
  const eventIdRef = useRef<number>(0);
  const previousPollFailureRef = useRef<number>(0);
  const processRequestInFlightRef = useRef<boolean>(false);
  const metarRequestIdRef = useRef<number>(0);
  const metarSourceRef = useRef<MetarPayload["source"] | null>(null);

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
    if (processRequestInFlightRef.current) {
      return;
    }

    processRequestInFlightRef.current = true;
    try {
      const snapshot = await getProcess();
      setProcessSnapshot(snapshot);
      setPollFailureCount(0);
      setInfoMessage((previous) =>
        previous.startsWith(TELEMETRY_RETRY_PREFIX) ? "Telemetry feed restored." : previous,
      );
    } catch (error) {
      setPollFailureCount((previous) => Math.min(previous + 1, 8));
      setInfoMessage((previous) =>
        previous.length > 0
          ? previous
          : `${TELEMETRY_RETRY_PREFIX} ${toErrorMessage(error)}`,
      );
    } finally {
      processRequestInFlightRef.current = false;
    }
  }, []);

  const refreshMetar = useCallback(
    async (scenarioPath: string, forceRefresh: boolean): Promise<void> => {
      const requestId = metarRequestIdRef.current + 1;
      metarRequestIdRef.current = requestId;
      setIsMetarBusy(true);
      setMetarErrorMessage("");
      try {
        const payload = await getMetar(sessionId, scenarioPath, forceRefresh);
        if (requestId !== metarRequestIdRef.current) {
          return;
        }
        setMetarPayload(payload);
        setLastMetarSyncAt(Date.now());
        const previousSource = metarSourceRef.current;
        metarSourceRef.current = payload.source;
        if (previousSource !== payload.source || forceRefresh) {
          if (payload.source === "web") {
            appendUiEvent("info", `Live METAR loaded from ${payload.station}.`);
          } else {
            appendUiEvent(
              "warning",
              `Network METAR unavailable. Generated fallback issued for ${payload.station}.`,
            );
          }
        }
      } catch (error) {
        if (requestId !== metarRequestIdRef.current) {
          return;
        }
        const detail = `METAR update failed: ${toErrorMessage(error)}`;
        setMetarErrorMessage(detail);
        appendUiEvent("error", detail);
      } finally {
        if (requestId === metarRequestIdRef.current) {
          setIsMetarBusy(false);
        }
      }
    },
    [appendUiEvent, sessionId],
  );

  const loadPageData = useCallback(async (): Promise<void> => {
    setIsBusy(true);
    setErrorMessage("");
    setInfoMessage("");

    try {
      const [settingsResult, processResult, checkResult] = await Promise.allSettled([
        getSettings(),
        getProcess(),
        getSystemCheck(),
      ]);

      if (settingsResult.status !== "fulfilled") {
        throw settingsResult.reason;
      }

      const settings = settingsResult.value;
      setSettingsResponse(settings);
      setDraftSettings(settings.settings);

      if (processResult.status === "fulfilled") {
        setProcessSnapshot(processResult.value);
        setPollFailureCount(0);
      } else {
        const processDetail = toErrorMessage(processResult.reason);
        setPollFailureCount((previous) => Math.min(previous + 1, 8));
        setProcessSnapshot((previous) => {
          if (previous !== null) {
            return previous;
          }
          return {
            running: false,
            current_action: null,
            last_exit_code: null,
            status_message: `Process telemetry unavailable: ${processDetail}`,
            logs: [],
          };
        });
        appendUiEvent("warning", `Process telemetry unavailable during sync: ${processDetail}`);
      }

      if (checkResult.status === "fulfilled") {
        setSystemCheck(checkResult.value);
      } else {
        const checkDetail = toErrorMessage(checkResult.reason);
        setSystemCheck({
          config_exists: false,
          available_languages: settings.available_languages,
          available_scenarios: settings.available_scenarios,
          missing_packages: [],
        });
        appendUiEvent("warning", `System check unavailable during sync: ${checkDetail}`);
      }

      setIsLoaded(true);
      setLastSyncedAt(Date.now());
      if (processResult.status === "fulfilled" && checkResult.status === "fulfilled") {
        setInfoMessage("Launcher data synchronized.");
      } else {
        setInfoMessage("Launcher data synchronized with partial diagnostics.");
      }
      appendUiEvent("info", "Launcher data synchronized.");
    } catch (error) {
      const detail = `Failed to load launcher data: ${toErrorMessage(error)}`;
      setErrorMessage(detail);
      appendUiEvent("error", detail);
    } finally {
      setIsBusy(false);
    }
  }, [appendUiEvent]);

  const selectedScenarioPath = draftSettings?.scenario_path ?? "";

  useEffect(() => {
    metarRequestIdRef.current += 1;
    metarSourceRef.current = null;
    setMetarPayload(null);
    setMetarErrorMessage("");
    setLastMetarSyncAt(null);
  }, [selectedScenarioPath]);

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
    if (!isLoaded || selectedScenarioPath.length === 0) {
      return;
    }
    void refreshMetar(selectedScenarioPath, false);
  }, [isLoaded, refreshMetar, selectedScenarioPath]);

  useEffect(() => {
    if (!isLoaded || selectedScenarioPath.length === 0) {
      return;
    }
    const timerId = window.setInterval(() => {
      void refreshMetar(selectedScenarioPath, true);
    }, METAR_REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(timerId);
    };
  }, [isLoaded, refreshMetar, selectedScenarioPath]);

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

  const scenarioCategoryOptions = useMemo((): string[] => {
    const categories = new Set<string>();
    scenarioInsights.forEach((scenario) => {
      categories.add(scenario.category);
    });
    return [ALL_SCENARIO_CATEGORIES, ...Array.from(categories).sort((left, right) => left.localeCompare(right))];
  }, [scenarioInsights]);

  useEffect(() => {
    if (!scenarioCategoryOptions.includes(scenarioCategoryFilter)) {
      setScenarioCategoryFilter(ALL_SCENARIO_CATEGORIES);
    }
  }, [scenarioCategoryFilter, scenarioCategoryOptions]);

  const normalizedScenarioQuery = useMemo((): string => {
    return scenarioQuery.trim().toLowerCase();
  }, [scenarioQuery]);

  const visibleScenarioInsights = useMemo((): ScenarioInsight[] => {
    return scenarioInsights.filter((scenario) => {
      const categoryMatches =
        scenarioCategoryFilter === ALL_SCENARIO_CATEGORIES ||
        scenario.category === scenarioCategoryFilter;
      if (!categoryMatches) {
        return false;
      }
      if (normalizedScenarioQuery.length === 0) {
        return true;
      }
      const searchable = `${scenario.path} ${scenario.label} ${scenario.category} ${scenario.intensity}`.toLowerCase();
      return searchable.includes(normalizedScenarioQuery);
    });
  }, [normalizedScenarioQuery, scenarioCategoryFilter, scenarioInsights]);

  const selectedScenarioInsight = useMemo((): ScenarioInsight | null => {
    if (selectedScenarioPath.length === 0) {
      return null;
    }
    return scenarioInsights.find((scenario) => scenario.path === selectedScenarioPath) ?? null;
  }, [scenarioInsights, selectedScenarioPath]);

  const cockpitProfile = useMemo((): CockpitProfile => {
    return buildCockpitProfile(selectedScenarioInsight, metarPayload);
  }, [metarPayload, selectedScenarioInsight]);

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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const isSaveShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s";
      if (!isSaveShortcut) {
        return;
      }
      event.preventDefault();
      if (disableFormControls || !hasUnsavedChanges || hasValidationErrors) {
        return;
      }
      void onSaveClicked();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [disableFormControls, hasUnsavedChanges, hasValidationErrors, onSaveClicked]);

  useEffect(() => {
    if (infoMessage.length === 0) {
      return;
    }
    const timerId = window.setTimeout(() => {
      setInfoMessage("");
    }, 5200);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [infoMessage]);

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

  const metarSourceLabel = useMemo((): string => {
    if (metarPayload === null) {
      return "Pending";
    }
    if (metarPayload.source === "web") {
      return "Live Web METAR";
    }
    return "Generated Fallback";
  }, [metarPayload]);

  const metarSourceClass = useMemo((): string => {
    if (metarPayload === null) {
      return "chip-neutral";
    }
    return metarPayload.source === "web" ? "chip-live" : "chip-warning";
  }, [metarPayload]);

  if (!isLoaded || draftSettings === null || settingsResponse === null) {
    return (
      <main className="ops-page">
        <section className="panel panel-hero loading-panel">
          <h1>OpenMATB Tactical Console</h1>
          <p>Synchronizing launcher services and scenario inventory...</p>
          {errorMessage.length > 0 ? (
            <p className="error" role="alert">
              {errorMessage}
            </p>
          ) : null}
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

      {infoMessage.length > 0 ? (
        <p className="banner info" role="status" aria-live="polite">
          {infoMessage}
        </p>
      ) : null}
      {errorMessage.length > 0 ? (
        <p className="banner error" role="alert" aria-live="assertive">
          {errorMessage}
        </p>
      ) : null}
      {pollFailureCount > 0 ? (
        <p className="banner warning" role="status" aria-live="polite">
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

      <section className="workspace-grid cockpit-grid">
        <article className="panel">
          <div className="panel-header">
            <h2>Pilot Instrument Cluster</h2>
            <span className="hint">{cockpitProfile.aircraftName}</span>
          </div>
          <p className="status">{cockpitProfile.missionMode}</p>
          <div className="instrument-grid">
            {cockpitProfile.gauges.map((gauge) => (
              <InstrumentDial key={gauge.key} gauge={gauge} />
            ))}
          </div>
        </article>

        <article className="panel metar-panel">
          <div className="panel-header">
            <h2>METAR Distraction Feed</h2>
            <div className="chip-row">
              <span className={`chip ${metarSourceClass}`}>{metarSourceLabel}</span>
            </div>
          </div>
          <p className="hint">
            Session ID: <span className="session-id">{sessionId}</span>
          </p>
          <p className="hint">
            Last METAR sync: {formatClock(lastMetarSyncAt)} | Auto-refresh every{" "}
            {METAR_REFRESH_INTERVAL_MS / 1000} seconds
          </p>
          {metarErrorMessage.length > 0 ? <p className="hint error">{metarErrorMessage}</p> : null}
          {metarPayload !== null ? (
            <div className="metar-feed">
              <p className="metar-raw">{metarPayload.metar}</p>
              <div className="metar-grid">
                <p>
                  <strong>Station:</strong> {metarPayload.station}
                </p>
                <p>
                  <strong>Profile:</strong> {metarPayload.scenario_profile}
                </p>
                <p>
                  <strong>Category:</strong> {metarPayload.flight_category}
                </p>
                <p>
                  <strong>Issued:</strong> {metarPayload.issued_at}
                </p>
                <p>
                  <strong>Wind:</strong> {metarPayload.wind_degrees} deg /{" "}
                  {metarPayload.wind_speed_kt} kt
                  {metarPayload.gust_kt !== null ? ` G${metarPayload.gust_kt}` : ""}
                </p>
                <p>
                  <strong>Visibility:</strong> {metarPayload.visibility_sm.toFixed(1)} SM
                </p>
                <p>
                  <strong>Ceiling:</strong>{" "}
                  {metarPayload.ceiling_ft !== null ? `${metarPayload.ceiling_ft} ft` : "none"}
                </p>
                <p>
                  <strong>Temperature:</strong> {metarPayload.temperature_c}C /{" "}
                  {metarPayload.dewpoint_c}C
                </p>
                <p>
                  <strong>Altimeter:</strong> {metarPayload.altimeter_inhg.toFixed(2)} inHg
                </p>
              </div>
            </div>
          ) : (
            <p className="hint">Waiting for METAR input from backend service.</p>
          )}
          <div className="action-row">
            <button
              type="button"
              disabled={isBusy || isMetarBusy || selectedScenarioPath.length === 0}
              onClick={() => {
                void refreshMetar(selectedScenarioPath, true);
              }}
            >
              {isMetarBusy ? "Refreshing METAR..." : "Refresh METAR"}
            </button>
          </div>
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
          <div className="scenario-toolbar">
            <label>
              Search
              <input
                type="search"
                value={scenarioQuery}
                onChange={(event) => {
                  setScenarioQuery(event.target.value);
                }}
                placeholder="Find scenario by name or path..."
                spellCheck={false}
              />
            </label>
            <label>
              Category
              <select
                value={scenarioCategoryFilter}
                onChange={(event) => {
                  setScenarioCategoryFilter(event.target.value);
                }}
              >
                {scenarioCategoryOptions.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="text-action"
              onClick={() => {
                setScenarioQuery("");
                setScenarioCategoryFilter(ALL_SCENARIO_CATEGORIES);
              }}
              disabled={
                scenarioQuery.length === 0 &&
                scenarioCategoryFilter === ALL_SCENARIO_CATEGORIES
              }
            >
              Clear filters
            </button>
          </div>
          <p className="hint">
            Showing {visibleScenarioInsights.length} of {scenarioInsights.length} scenarios.
          </p>
          <div className="scenario-grid">
            {visibleScenarioInsights.length > 0 ? (
              visibleScenarioInsights.map((scenario) => {
                const isSelected = scenario.path === draftSettings.scenario_path;
                return (
                  <button
                    key={scenario.path}
                    type="button"
                    className={`scenario-card${isSelected ? " selected" : ""}`}
                    aria-pressed={isSelected}
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
              })
            ) : (
              <p className="scenario-empty hint">
                No scenarios match the current search and category filters.
              </p>
            )}
          </div>
        </article>

        <article className="panel">
          <h2>Configuration Controls</h2>
          <p className="hint">
            {hasUnsavedChanges
              ? "Unsaved changes pending. Press Ctrl/Cmd + S to save quickly."
              : "Configuration is synchronized. Press Ctrl/Cmd + S for quick save."}
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
          <pre className="log-area" tabIndex={0} aria-label="Process log output">
            {processSnapshot !== null && processSnapshot.logs.length > 0
              ? processSnapshot.logs.join("\n")
              : "No process logs yet."}
          </pre>
        </article>

        <article className="panel">
          <h2>Command Timeline</h2>
          {uiEvents.length > 0 ? (
            <ul className="event-list" aria-live="polite">
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
          Aircraft gauge preset: <strong>{cockpitProfile.aircraftName}</strong> | METAR source:{" "}
          <strong>{metarSourceLabel}</strong>
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
