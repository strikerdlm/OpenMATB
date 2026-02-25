#!/usr/bin/env python3
"""FastAPI-based web launcher backend for OpenMATB.

This module exposes JSON endpoints to:
1) read and update launcher settings in config.ini,
2) run one launcher action process at a time,
3) stream bounded process logs through polling,
4) report environment check information.
"""

from __future__ import annotations

import queue
import subprocess
import sys
import threading
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Final

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from launcher import ConfigService, LauncherSettings, run_system_check

MAX_LOG_LINES: Final[int] = 800
MAX_QUEUE_LINES: Final[int] = 1500
MAX_DRAIN_PER_REQUEST: Final[int] = 500
MAX_SCREEN_INDEX: Final[int] = 16
TERMINATE_TIMEOUT_SECONDS: Final[float] = 3.0
KILL_TIMEOUT_SECONDS: Final[float] = 3.0

REPO_ROOT: Final[Path] = Path(__file__).resolve().parent
ACTION_COMMANDS: Final[dict[str, tuple[str, ...]]] = {
    "install": (sys.executable, "-m", "pip", "install", "-r", "requirements.txt"),
    "generate": (sys.executable, "scenario_generator.py"),
    "launch": (sys.executable, "main.py"),
}

ALLOWED_DEV_ORIGINS: Final[tuple[str, ...]] = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
)


class SettingsPayload(BaseModel):
    """Settings accepted from and returned to the frontend."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    language: str = Field(min_length=1, max_length=64)
    scenario_path: str = Field(min_length=1, max_length=256)
    screen_index: int
    fullscreen: bool
    display_session_number: bool
    hide_on_pause: bool
    highlight_aoi: bool
    font_name: str = Field(default="", max_length=120)


class SettingsResponse(BaseModel):
    """Settings payload with available options."""

    model_config = ConfigDict(extra="forbid")

    available_languages: list[str]
    available_scenarios: list[str]
    settings: SettingsPayload


class ProcessSnapshot(BaseModel):
    """Current launcher process state and bounded logs."""

    model_config = ConfigDict(extra="forbid")

    running: bool
    current_action: str | None
    last_exit_code: int | None
    status_message: str
    logs: list[str]


class SystemCheckPayload(BaseModel):
    """Summary from the existing launcher system check."""

    model_config = ConfigDict(extra="forbid")

    config_exists: bool
    available_languages: list[str]
    available_scenarios: list[str]
    missing_packages: list[str]


@dataclass(slots=True)
class _ProcessState:
    """Mutable process state stored behind a lock."""

    process: subprocess.Popen[str] | None
    output_thread: threading.Thread | None
    current_action: str | None
    last_exit_code: int | None
    status_message: str


class ProcessManager:
    """Manage one child process and keep bounded logs."""

    def __init__(self, repo_root: Path) -> None:
        if not repo_root.exists():
            raise ValueError(f"Repository root does not exist: {repo_root}")
        self._repo_root = repo_root
        self._log_queue: queue.Queue[str] = queue.Queue(maxsize=MAX_QUEUE_LINES)
        self._logs: deque[str] = deque(maxlen=MAX_LOG_LINES)
        self._lock = threading.Lock()
        self._state = _ProcessState(
            process=None,
            output_thread=None,
            current_action=None,
            last_exit_code=None,
            status_message="Ready.",
        )

    def start_process(self, action: str, command: tuple[str, ...]) -> ProcessSnapshot:
        """Start an action process if no other process is running."""
        if action not in ACTION_COMMANDS:
            raise ValueError(f"Unsupported action: {action}")
        if len(command) == 0:
            raise ValueError("Command must not be empty.")

        with self._lock:
            self._refresh_state_unlocked()
            running = self._state.process is not None and self._state.process.poll() is None
            if running:
                raise RuntimeError("Another process is already running.")

            command_text = " ".join(command)
            self._logs.append(f"Starting {action}: {command_text}")
            try:
                process = subprocess.Popen(
                    list(command),
                    cwd=str(self._repo_root),
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    bufsize=1,
                )
            except (OSError, ValueError) as exc:
                self._logs.append(f"Failed to start {action}: {exc}")
                self._state.status_message = f"Failed to start {action}."
                raise RuntimeError(f"Failed to start action '{action}'.") from exc

            self._state.process = process
            self._state.output_thread = None
            self._state.current_action = action
            self._state.last_exit_code = None
            self._state.status_message = f"Running {action}..."

            if process.stdout is None:
                self._logs.append("Warning: process output stream is unavailable.")
            else:
                output_thread = threading.Thread(
                    target=self._read_process_output,
                    args=(process.stdout,),
                    daemon=True,
                )
                output_thread.start()
                self._state.output_thread = output_thread

            return self._build_snapshot_unlocked()

    def stop_process(self) -> ProcessSnapshot:
        """Stop the running process with bounded timeouts."""
        with self._lock:
            self._refresh_state_unlocked()
            process = self._state.process
            if process is None or process.poll() is not None:
                self._state.status_message = "No running process to stop."
                return self._build_snapshot_unlocked()

            process.terminate()
            try:
                process.wait(timeout=TERMINATE_TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired:
                process.kill()
                try:
                    process.wait(timeout=KILL_TIMEOUT_SECONDS)
                except subprocess.TimeoutExpired:
                    self._logs.append("Failed to stop process cleanly within timeout.")

            self._logs.append("Process stopped by user.")
            self._state.last_exit_code = process.poll()
            self._state.current_action = None
            self._state.status_message = "Process stopped."
            self._state.process = None
            self._state.output_thread = None
            self._drain_queue_unlocked(MAX_DRAIN_PER_REQUEST)
            return self._build_snapshot_unlocked()

    def get_snapshot(self) -> ProcessSnapshot:
        """Return current process state with drained logs."""
        with self._lock:
            self._refresh_state_unlocked()
            self._drain_queue_unlocked(MAX_DRAIN_PER_REQUEST)
            return self._build_snapshot_unlocked()

    def _read_process_output(self, stream: IO[str]) -> None:
        for raw_line in stream:
            line = raw_line.rstrip("\n")
            self._enqueue_log_line(line)

    def _enqueue_log_line(self, line: str) -> None:
        if len(line) > 5000:
            truncated = f"{line[:5000]}... [truncated]"
        else:
            truncated = line
        try:
            self._log_queue.put_nowait(truncated)
        except queue.Full:
            try:
                _ = self._log_queue.get_nowait()
            except queue.Empty:
                return
            try:
                self._log_queue.put_nowait(truncated)
            except queue.Full:
                return

    def _drain_queue_unlocked(self, max_items: int) -> None:
        if max_items <= 0:
            raise ValueError("max_items must be > 0.")
        for _ in range(max_items):
            try:
                line = self._log_queue.get_nowait()
            except queue.Empty:
                break
            self._logs.append(line)

    def _refresh_state_unlocked(self) -> None:
        process = self._state.process
        if process is None:
            return

        exit_code = process.poll()
        if exit_code is None:
            return

        self._drain_queue_unlocked(MAX_DRAIN_PER_REQUEST)
        self._logs.append(f"Process exited with code {exit_code}.")
        self._state.last_exit_code = exit_code
        self._state.current_action = None
        self._state.status_message = f"Process finished (exit code {exit_code})."
        self._state.process = None
        self._state.output_thread = None

    def _build_snapshot_unlocked(self) -> ProcessSnapshot:
        process = self._state.process
        running = process is not None and process.poll() is None
        return ProcessSnapshot(
            running=running,
            current_action=self._state.current_action,
            last_exit_code=self._state.last_exit_code,
            status_message=self._state.status_message,
            logs=list(self._logs),
        )


def _settings_to_payload(settings: LauncherSettings) -> SettingsPayload:
    return SettingsPayload(
        language=settings.language,
        scenario_path=settings.scenario_path,
        screen_index=settings.screen_index,
        fullscreen=settings.fullscreen,
        display_session_number=settings.display_session_number,
        hide_on_pause=settings.hide_on_pause,
        highlight_aoi=settings.highlight_aoi,
        font_name=settings.font_name,
    )


def _validate_settings(
    settings: SettingsPayload,
    available_languages: list[str],
    available_scenarios: list[str],
    scenario_root: Path,
) -> LauncherSettings:
    if len(available_languages) == 0:
        raise HTTPException(status_code=500, detail="No languages are available.")
    if len(available_scenarios) == 0:
        raise HTTPException(status_code=500, detail="No scenarios are available.")

    if settings.language not in available_languages:
        raise HTTPException(status_code=400, detail=f"Unsupported language: {settings.language}")

    scenario_path = settings.scenario_path.strip()
    if len(scenario_path) == 0:
        raise HTTPException(status_code=400, detail="Scenario path is required.")

    scenario_candidate = (scenario_root / scenario_path).resolve()
    scenario_root_resolved = scenario_root.resolve()
    try:
        _ = scenario_candidate.relative_to(scenario_root_resolved)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Scenario must stay under includes/scenarios.") from exc

    if not scenario_candidate.exists() or not scenario_candidate.is_file():
        raise HTTPException(status_code=400, detail=f"Scenario file does not exist: {scenario_path}")

    if settings.screen_index < 0 or settings.screen_index > MAX_SCREEN_INDEX:
        raise HTTPException(
            status_code=400,
            detail=f"Screen index must be between 0 and {MAX_SCREEN_INDEX}.",
        )

    return LauncherSettings(
        language=settings.language,
        scenario_path=scenario_path,
        screen_index=settings.screen_index,
        fullscreen=settings.fullscreen,
        display_session_number=settings.display_session_number,
        hide_on_pause=settings.hide_on_pause,
        highlight_aoi=settings.highlight_aoi,
        font_name=settings.font_name,
    )


def _build_settings_response(config_service: ConfigService) -> SettingsResponse:
    available_languages = config_service.discover_languages()
    available_scenarios = config_service.discover_scenarios()
    current_settings = config_service.load_settings()
    return SettingsResponse(
        available_languages=available_languages,
        available_scenarios=available_scenarios,
        settings=_settings_to_payload(current_settings),
    )


app = FastAPI(title="OpenMATB Web Launcher API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(ALLOWED_DEV_ORIGINS),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

config_service = ConfigService(REPO_ROOT)
process_manager = ProcessManager(REPO_ROOT)


@app.get("/api/health")
def health() -> dict[str, str]:
    """Simple readiness endpoint."""
    return {"status": "ok"}


@app.get("/api/settings", response_model=SettingsResponse)
def get_settings() -> SettingsResponse:
    """Return launcher settings and available choices."""
    return _build_settings_response(config_service)


@app.put("/api/settings", response_model=SettingsResponse)
def put_settings(settings: SettingsPayload) -> SettingsResponse:
    """Validate and persist launcher settings."""
    available_languages = config_service.discover_languages()
    available_scenarios = config_service.discover_scenarios()
    validated = _validate_settings(
        settings=settings,
        available_languages=available_languages,
        available_scenarios=available_scenarios,
        scenario_root=config_service.scenarios_path,
    )
    try:
        config_service.save_settings(validated)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Unable to write config.ini: {exc}") from exc
    return _build_settings_response(config_service)


@app.get("/api/system-check", response_model=SystemCheckPayload)
def get_system_check() -> SystemCheckPayload:
    """Return the same environment report used by launcher --check."""
    report = run_system_check(REPO_ROOT)
    return SystemCheckPayload(
        config_exists=report.config_exists,
        available_languages=list(report.available_languages),
        available_scenarios=list(report.available_scenarios),
        missing_packages=list(report.missing_packages),
    )


@app.get("/api/process", response_model=ProcessSnapshot)
def get_process() -> ProcessSnapshot:
    """Return current process state and logs."""
    return process_manager.get_snapshot()


@app.post("/api/actions/{action}", response_model=ProcessSnapshot)
def post_action(action: str) -> ProcessSnapshot:
    """Start a launcher action or stop the running process."""
    normalized = action.strip().lower()
    if normalized == "stop":
        return process_manager.stop_process()
    if normalized not in ACTION_COMMANDS:
        raise HTTPException(status_code=404, detail=f"Unknown action: {normalized}")

    command = ACTION_COMMANDS[normalized]
    try:
        return process_manager.start_process(normalized, command)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def main() -> None:
    """Run the API with uvicorn."""
    import uvicorn

    uvicorn.run("web_launcher_api:app", host="127.0.0.1", port=8000, reload=False)


if __name__ == "__main__":
    main()
