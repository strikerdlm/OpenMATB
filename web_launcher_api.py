#!/usr/bin/env python3
"""FastAPI-based web launcher backend for OpenMATB.

This module exposes JSON endpoints to:
1) read and update launcher settings in config.ini,
2) run one launcher action process at a time,
3) stream bounded process logs through polling,
4) report environment check information.
"""

from __future__ import annotations

import hashlib
import queue
import random
import re
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from collections import OrderedDict, deque
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import IO, Final, Literal

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
METAR_CACHE_SIZE: Final[int] = 96
METAR_MAX_WEB_ATTEMPTS: Final[int] = 3
METAR_HTTP_TIMEOUT_SECONDS: Final[float] = 2.5
METAR_SESSION_ID_PATTERN: Final[re.Pattern[str]] = re.compile(r"^[A-Za-z0-9_-]{6,64}$")
METAR_MAX_SCENARIO_PATH_LENGTH: Final[int] = 256
METAR_DEFAULT_VISIBILITY_SM: Final[float] = 10.0

METAR_WIND_PATTERN: Final[re.Pattern[str]] = re.compile(r"\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b")
METAR_VISIBILITY_MIXED_PATTERN: Final[re.Pattern[str]] = re.compile(r"\b(\d+)\s+(\d/\d)SM\b")
METAR_VISIBILITY_FRACTION_PATTERN: Final[re.Pattern[str]] = re.compile(r"\b(\d/\d)SM\b")
METAR_VISIBILITY_INTEGER_PATTERN: Final[re.Pattern[str]] = re.compile(r"\b(\d{1,2})SM\b")
METAR_CEILING_PATTERN: Final[re.Pattern[str]] = re.compile(r"\b(BKN|OVC|VV)(\d{3})\b")
METAR_TEMP_PATTERN: Final[re.Pattern[str]] = re.compile(r"\b(M?\d{2})/(M?\d{2})\b")
METAR_ALTIMETER_PATTERN: Final[re.Pattern[str]] = re.compile(r"\bA(\d{4})\b")
METAR_ISSUED_PATTERN: Final[re.Pattern[str]] = re.compile(r"\b(\d{6})Z\b")

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


class MetarPayload(BaseModel):
    """Session-scoped METAR payload for distraction instrumentation."""

    model_config = ConfigDict(extra="forbid")

    session_id: str
    source: Literal["web", "generated"]
    station: str
    scenario_profile: str
    flight_category: Literal["VFR", "MVFR", "IFR", "LIFR"]
    metar: str
    issued_at: str
    fetched_at: str
    wind_degrees: int
    wind_speed_kt: int
    gust_kt: int | None
    visibility_sm: float
    ceiling_ft: int | None
    temperature_c: int
    dewpoint_c: int
    altimeter_inhg: float


@dataclass(frozen=True, slots=True)
class _MetarObservation:
    """Structured METAR observation, from web or local generation."""

    source: Literal["web", "generated"]
    station: str
    scenario_profile: str
    flight_category: Literal["VFR", "MVFR", "IFR", "LIFR"]
    metar: str
    issued_at: str
    fetched_at: str
    wind_degrees: int
    wind_speed_kt: int
    gust_kt: int | None
    visibility_sm: float
    ceiling_ft: int | None
    temperature_c: int
    dewpoint_c: int
    altimeter_inhg: float

    def to_payload(self, session_id: str) -> MetarPayload:
        """Convert internal observation into transport payload."""
        return MetarPayload(
            session_id=session_id,
            source=self.source,
            station=self.station,
            scenario_profile=self.scenario_profile,
            flight_category=self.flight_category,
            metar=self.metar,
            issued_at=self.issued_at,
            fetched_at=self.fetched_at,
            wind_degrees=self.wind_degrees,
            wind_speed_kt=self.wind_speed_kt,
            gust_kt=self.gust_kt,
            visibility_sm=self.visibility_sm,
            ceiling_ft=self.ceiling_ft,
            temperature_c=self.temperature_c,
            dewpoint_c=self.dewpoint_c,
            altimeter_inhg=self.altimeter_inhg,
        )


class MetarService:
    """Provide bounded, session-scoped METAR observations."""

    def __init__(
        self,
        cache_size: int = METAR_CACHE_SIZE,
        web_attempts: int = METAR_MAX_WEB_ATTEMPTS,
        http_timeout_seconds: float = METAR_HTTP_TIMEOUT_SECONDS,
    ) -> None:
        if cache_size <= 0:
            raise ValueError("cache_size must be > 0.")
        if web_attempts <= 0:
            raise ValueError("web_attempts must be > 0.")
        if http_timeout_seconds <= 0:
            raise ValueError("http_timeout_seconds must be > 0.")

        self._cache_size = cache_size
        self._web_attempts = web_attempts
        self._http_timeout_seconds = http_timeout_seconds
        self._lock = threading.Lock()
        self._cache: OrderedDict[str, _MetarObservation] = OrderedDict()
        self._profile_to_stations: dict[str, tuple[str, ...]] = {
            "trainer": ("KPAO", "KSAN", "KPDX"),
            "night_approach": ("KSEA", "KBOS", "KDEN"),
            "fighter_intercept": ("KNLC", "KLSV", "KEND"),
            "ifr_radios": ("KORD", "KATL", "KDFW"),
            "general_ops": ("KJFK", "KLAX", "KPHX"),
        }

    def get_metar(self, session_id: str, scenario_path: str, force_refresh: bool) -> MetarPayload:
        """Return one METAR report per session, with optional forced refresh."""
        normalized_session = self._normalize_session_id(session_id)
        normalized_scenario = self._normalize_scenario_path(scenario_path)

        if not force_refresh:
            with self._lock:
                cached = self._cache.get(normalized_session)
                if cached is not None:
                    self._cache.move_to_end(normalized_session)
                    return cached.to_payload(normalized_session)

        observation = self._build_observation(normalized_session, normalized_scenario)
        with self._lock:
            self._cache[normalized_session] = observation
            self._cache.move_to_end(normalized_session)
            while len(self._cache) > self._cache_size:
                self._cache.popitem(last=False)
        return observation.to_payload(normalized_session)

    def _normalize_session_id(self, session_id: str) -> str:
        normalized = session_id.strip()
        if not METAR_SESSION_ID_PATTERN.match(normalized):
            raise ValueError("session_id must match [A-Za-z0-9_-] and be 6-64 chars long.")
        return normalized

    def _normalize_scenario_path(self, scenario_path: str) -> str:
        normalized = scenario_path.strip()
        if len(normalized) == 0:
            return "default"
        if len(normalized) > METAR_MAX_SCENARIO_PATH_LENGTH:
            raise ValueError(
                f"scenario_path must be <= {METAR_MAX_SCENARIO_PATH_LENGTH} characters."
            )
        return normalized

    def _build_observation(self, session_id: str, scenario_path: str) -> _MetarObservation:
        profile_name, stations = self._select_profile_and_stations(scenario_path)
        station_order = self._build_station_order(session_id, scenario_path, stations)
        web_observation = self._fetch_live_observation(profile_name, station_order)
        if web_observation is not None:
            return web_observation
        return self._generate_observation(profile_name, station_order[0], session_id, scenario_path)

    def _select_profile_and_stations(self, scenario_path: str) -> tuple[str, tuple[str, ...]]:
        scenario_lower = scenario_path.lower()
        if "combat" in scenario_lower or "high_reliability" in scenario_lower:
            profile_name = "fighter_intercept"
        elif "night" in scenario_lower:
            profile_name = "night_approach"
        elif "comm" in scenario_lower or "radio" in scenario_lower:
            profile_name = "ifr_radios"
        elif "mwe" in scenario_lower or "training" in scenario_lower or "basic" in scenario_lower:
            profile_name = "trainer"
        else:
            profile_name = "general_ops"

        stations = self._profile_to_stations[profile_name]
        if len(stations) == 0:
            raise ValueError("No stations are configured for METAR profile.")
        return profile_name, stations

    def _build_station_order(
        self,
        session_id: str,
        scenario_path: str,
        stations: tuple[str, ...],
    ) -> list[str]:
        if len(stations) == 0:
            raise ValueError("stations must not be empty.")
        seed_hex = hashlib.sha256(f"{session_id}|{scenario_path}".encode("utf-8")).hexdigest()
        seed_value = int(seed_hex[:16], 16)
        start_index = seed_value % len(stations)
        return [stations[(start_index + offset) % len(stations)] for offset in range(len(stations))]

    def _fetch_live_observation(
        self,
        profile_name: str,
        station_order: list[str],
    ) -> _MetarObservation | None:
        attempts = min(self._web_attempts, len(station_order))
        for index in range(attempts):
            station = station_order[index]
            try:
                metar_line = self._download_live_metar(station)
                return self._parse_observation(
                    source="web",
                    profile_name=profile_name,
                    station=station,
                    metar_line=metar_line,
                )
            except (OSError, TimeoutError, urllib.error.URLError, ValueError):
                continue
        return None

    def _download_live_metar(self, station: str) -> str:
        url = f"https://tgftp.nws.noaa.gov/data/observations/metar/stations/{station}.TXT"
        request = urllib.request.Request(url, headers={"User-Agent": "OpenMATB-WebLauncher/1.0"})
        with urllib.request.urlopen(request, timeout=self._http_timeout_seconds) as response:
            payload = response.read(4096).decode("utf-8", errors="replace")
        for line in payload.splitlines()[:8]:
            candidate = line.strip().upper()
            if candidate.startswith(f"{station} "):
                return candidate
        raise ValueError(f"Live METAR response missing station line for {station}.")

    def _parse_observation(
        self,
        source: Literal["web", "generated"],
        profile_name: str,
        station: str,
        metar_line: str,
    ) -> _MetarObservation:
        issued_at = self._extract_issued_token(metar_line)
        wind_degrees, wind_speed_kt, gust_kt = self._extract_wind(metar_line)
        visibility_sm = self._extract_visibility(metar_line)
        ceiling_ft = self._extract_ceiling(metar_line)
        temperature_c, dewpoint_c = self._extract_temperatures(metar_line)
        altimeter_inhg = self._extract_altimeter(metar_line)
        flight_category = self._compute_flight_category(visibility_sm, ceiling_ft)
        fetched_at = datetime.now(UTC).isoformat()
        return _MetarObservation(
            source=source,
            station=station,
            scenario_profile=profile_name,
            flight_category=flight_category,
            metar=metar_line,
            issued_at=issued_at,
            fetched_at=fetched_at,
            wind_degrees=wind_degrees,
            wind_speed_kt=wind_speed_kt,
            gust_kt=gust_kt,
            visibility_sm=visibility_sm,
            ceiling_ft=ceiling_ft,
            temperature_c=temperature_c,
            dewpoint_c=dewpoint_c,
            altimeter_inhg=altimeter_inhg,
        )

    def _generate_observation(
        self,
        profile_name: str,
        station: str,
        session_id: str,
        scenario_path: str,
    ) -> _MetarObservation:
        seed_payload = hashlib.sha256(f"generated|{session_id}|{scenario_path}".encode("utf-8"))
        randomizer = random.Random(int(seed_payload.hexdigest()[:16], 16))
        now = datetime.now(UTC)
        issued_at = f"{now.day:02d}{now.hour:02d}{now.minute:02d}Z"

        wind_degrees = randomizer.randrange(0, 36) * 10
        wind_speed_kt = randomizer.randint(5, 28)
        gust_kt = None
        if randomizer.random() > 0.5:
            gust_kt = wind_speed_kt + randomizer.randint(4, 14)

        visibility_sm = randomizer.choice([1.5, 2.0, 3.0, 4.0, 5.0, 6.0, 10.0])
        cloud_token, ceiling_ft = self._generate_cloud_token(randomizer)
        temperature_c = randomizer.randint(-8, 33)
        dewpoint_c = temperature_c - randomizer.randint(0, 9)
        altimeter_inhg = round(randomizer.uniform(29.45, 30.35), 2)

        weather_tokens: list[str] = []
        if visibility_sm <= 2.0:
            weather_tokens.append("BR")
        elif visibility_sm <= 4.0:
            weather_tokens.append("-RA")
        elif wind_speed_kt >= 22:
            weather_tokens.append("-SHRA")

        wind_block = (
            f"{wind_degrees:03d}{wind_speed_kt:02d}G{gust_kt:02d}KT"
            if gust_kt is not None
            else f"{wind_degrees:03d}{wind_speed_kt:02d}KT"
        )
        visibility_block = self._format_visibility_token(visibility_sm)
        temperature_block = (
            f"{self._format_signed_temperature(temperature_c)}"
            f"/{self._format_signed_temperature(dewpoint_c)}"
        )
        weather_block = " ".join(weather_tokens).strip()
        altimeter_block = f"A{int(round(altimeter_inhg * 100)):04d}"

        metar_parts = [
            station,
            issued_at,
            wind_block,
            visibility_block,
        ]
        if len(weather_block) > 0:
            metar_parts.append(weather_block)
        metar_parts.extend([cloud_token, temperature_block, altimeter_block, "RMK", "AO2", "SIM"])
        metar_line = " ".join(metar_parts)

        return self._parse_observation(
            source="generated",
            profile_name=profile_name,
            station=station,
            metar_line=metar_line,
        )

    def _generate_cloud_token(self, randomizer: random.Random) -> tuple[str, int | None]:
        layer_count = 2 + randomizer.randint(0, 1)
        first_height = randomizer.randint(8, 25)
        second_height = first_height + randomizer.randint(12, 48)
        third_height = second_height + randomizer.randint(18, 72)
        heights = [first_height, second_height, third_height]

        coverages = [
            randomizer.choice(["FEW", "SCT", "BKN"]),
            randomizer.choice(["SCT", "BKN", "OVC"]),
            randomizer.choice(["BKN", "OVC"]),
        ]

        layers: list[str] = []
        ceiling_ft: int | None = None
        for index in range(layer_count):
            coverage = coverages[index]
            height_hundreds = heights[index]
            layers.append(f"{coverage}{height_hundreds:03d}")
            if coverage in {"BKN", "OVC"} and ceiling_ft is None:
                ceiling_ft = height_hundreds * 100

        return " ".join(layers), ceiling_ft

    def _extract_issued_token(self, metar_line: str) -> str:
        issued_match = METAR_ISSUED_PATTERN.search(metar_line)
        if issued_match is None:
            now = datetime.now(UTC)
            return f"{now.day:02d}{now.hour:02d}{now.minute:02d}Z"
        return f"{issued_match.group(1)}Z"

    def _extract_wind(self, metar_line: str) -> tuple[int, int, int | None]:
        wind_match = METAR_WIND_PATTERN.search(metar_line)
        if wind_match is None:
            return 0, 0, None
        wind_dir_token = wind_match.group(1)
        wind_speed_kt = int(wind_match.group(2))
        gust_group = wind_match.group(3)
        gust_kt = int(gust_group) if gust_group is not None else None
        wind_degrees = 0 if wind_dir_token == "VRB" else int(wind_dir_token)
        return wind_degrees, wind_speed_kt, gust_kt

    def _extract_visibility(self, metar_line: str) -> float:
        if "P6SM" in metar_line:
            return 6.0
        mixed_match = METAR_VISIBILITY_MIXED_PATTERN.search(metar_line)
        if mixed_match is not None:
            whole = int(mixed_match.group(1))
            fraction = self._parse_fraction(mixed_match.group(2))
            return round(whole + fraction, 1)
        fraction_match = METAR_VISIBILITY_FRACTION_PATTERN.search(metar_line)
        if fraction_match is not None:
            return round(self._parse_fraction(fraction_match.group(1)), 1)
        integer_match = METAR_VISIBILITY_INTEGER_PATTERN.search(metar_line)
        if integer_match is not None:
            return float(int(integer_match.group(1)))
        return METAR_DEFAULT_VISIBILITY_SM

    def _parse_fraction(self, token: str) -> float:
        numerator_denominator = token.split("/")
        if len(numerator_denominator) != 2:
            raise ValueError(f"Invalid fraction token: {token}")
        numerator = int(numerator_denominator[0])
        denominator = int(numerator_denominator[1])
        if denominator == 0:
            raise ValueError("Fraction denominator must not be zero.")
        return numerator / denominator

    def _extract_ceiling(self, metar_line: str) -> int | None:
        ceiling_matches = METAR_CEILING_PATTERN.findall(metar_line)
        if len(ceiling_matches) == 0:
            return None
        candidate_values = [int(match[1]) * 100 for match in ceiling_matches]
        return min(candidate_values)

    def _extract_temperatures(self, metar_line: str) -> tuple[int, int]:
        temp_match = METAR_TEMP_PATTERN.search(metar_line)
        if temp_match is None:
            return 15, 9
        temp_token = temp_match.group(1)
        dew_token = temp_match.group(2)
        return self._parse_signed_temperature(temp_token), self._parse_signed_temperature(dew_token)

    def _parse_signed_temperature(self, token: str) -> int:
        if token.startswith("M"):
            return -int(token[1:])
        return int(token)

    def _format_signed_temperature(self, value: int) -> str:
        if value < 0:
            return f"M{abs(value):02d}"
        return f"{value:02d}"

    def _extract_altimeter(self, metar_line: str) -> float:
        altimeter_match = METAR_ALTIMETER_PATTERN.search(metar_line)
        if altimeter_match is None:
            return 29.92
        altimeter_hundredths = int(altimeter_match.group(1))
        return round(altimeter_hundredths / 100.0, 2)

    def _compute_flight_category(
        self,
        visibility_sm: float,
        ceiling_ft: int | None,
    ) -> Literal["VFR", "MVFR", "IFR", "LIFR"]:
        effective_ceiling = ceiling_ft if ceiling_ft is not None else 99999
        if visibility_sm < 1.0 or effective_ceiling < 500:
            return "LIFR"
        if visibility_sm < 3.0 or effective_ceiling < 1000:
            return "IFR"
        if visibility_sm <= 5.0 or effective_ceiling <= 3000:
            return "MVFR"
        return "VFR"

    def _format_visibility_token(self, visibility_sm: float) -> str:
        if visibility_sm >= 6.0:
            return "P6SM"
        whole = int(visibility_sm)
        fractional = round(visibility_sm - whole, 2)
        if fractional == 0:
            return f"{whole}SM"
        if fractional == 0.5:
            if whole == 0:
                return "1/2SM"
            return f"{whole} 1/2SM"
        return f"{max(1, whole)}SM"


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
metar_service = MetarService()


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


@app.get("/api/distractions/metar", response_model=MetarPayload)
def get_metar_distraction(
    session_id: str,
    scenario_path: str = "",
    force_refresh: bool = False,
) -> MetarPayload:
    """Return a per-session METAR feed with online fallback generation."""
    try:
        return metar_service.get_metar(
            session_id=session_id,
            scenario_path=scenario_path,
            force_refresh=force_refresh,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


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
