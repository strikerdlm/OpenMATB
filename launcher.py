#!/usr/bin/env python3
"""Cross-platform desktop launcher for OpenMATB.

This launcher provides a functional interface to:
1) manage runtime configuration values in config.ini,
2) run dependency installation,
3) launch the main OpenMATB application,
4) run the built-in scenario generator,
5) monitor process output in real-time.

It is designed for Windows and Linux with Python 3.9+.
"""

from __future__ import annotations

import argparse
import configparser
import importlib.util
import queue
import re
import subprocess
import sys
import threading
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Deque

import tkinter as tk
from tkinter import filedialog, messagebox, ttk


OPENMATB_SECTION = "Openmatb"
MAX_LOG_LINES = 800
MAX_QUEUE_LINES = 1500
MAX_DRAIN_PER_POLL = 400
POLL_INTERVAL_MS = 150
TERMINATE_TIMEOUT_SECONDS = 3
KILL_TIMEOUT_SECONDS = 3
MAX_SCREEN_INDEX = 16

PACKAGE_TO_MODULE = {
    "pyparallel": "parallel",
}


@dataclass(slots=True, frozen=True)
class LauncherSettings:
    """Configuration values exposed by the launcher UI."""

    language: str
    scenario_path: str
    screen_index: int
    fullscreen: bool
    display_session_number: bool
    hide_on_pause: bool
    highlight_aoi: bool
    font_name: str


@dataclass(slots=True, frozen=True)
class SystemCheckReport:
    """Summary of launcher prerequisites and environment checks."""

    available_languages: tuple[str, ...]
    available_scenarios: tuple[str, ...]
    missing_packages: tuple[str, ...]
    config_exists: bool


class ConfigService:
    """Read/write OpenMATB config and discover launcher choices."""

    def __init__(self, repo_root: Path) -> None:
        if not repo_root.exists():
            raise ValueError(f"Repository root does not exist: {repo_root}")
        self.repo_root = repo_root
        self.config_path = repo_root / "config.ini"
        self.locales_path = repo_root / "locales"
        self.scenarios_path = repo_root / "includes" / "scenarios"

    def discover_languages(self) -> list[str]:
        """Return locale identifiers that contain openmatb translations."""
        if not self.locales_path.exists():
            return []
        locale_names: list[str] = []
        for locale_dir in self.locales_path.iterdir():
            if not locale_dir.is_dir():
                continue
            candidate = locale_dir / "LC_MESSAGES" / "openmatb.po"
            if candidate.is_file():
                locale_names.append(locale_dir.name)
        return sorted(locale_names)

    def discover_scenarios(self) -> list[str]:
        """Return available scenario txt files relative to includes/scenarios."""
        if not self.scenarios_path.exists():
            return []
        relative_paths: list[str] = []
        for scenario_file in self.scenarios_path.rglob("*.txt"):
            if scenario_file.is_file():
                relative_paths.append(scenario_file.relative_to(self.scenarios_path).as_posix())
        return sorted(relative_paths)

    def load_settings(self) -> LauncherSettings:
        """Load launcher-relevant settings from config.ini with safe defaults."""
        parser = configparser.ConfigParser()
        parser.read(self.config_path)
        section = parser[OPENMATB_SECTION] if parser.has_section(OPENMATB_SECTION) else {}

        available_languages = self.discover_languages()
        available_scenarios = self.discover_scenarios()

        language = self._safe_str(section, "language", available_languages[0] if available_languages else "en_EN")
        scenario_path = self._safe_str(
            section,
            "scenario_path",
            available_scenarios[0] if available_scenarios else "default.txt",
        )

        return LauncherSettings(
            language=language,
            scenario_path=scenario_path,
            screen_index=self._safe_int(section, "screen_index", 0, 0, MAX_SCREEN_INDEX),
            fullscreen=self._safe_bool(section, "fullscreen", True),
            display_session_number=self._safe_bool(section, "display_session_number", True),
            hide_on_pause=self._safe_bool(section, "hide_on_pause", False),
            highlight_aoi=self._safe_bool(section, "highlight_aoi", False),
            font_name=self._safe_str(section, "font_name", ""),
        )

    def save_settings(self, settings: LauncherSettings) -> None:
        """Persist launcher settings while preserving comments and file layout."""
        updates = {
            "language": settings.language,
            "scenario_path": settings.scenario_path,
            "screen_index": str(settings.screen_index),
            "fullscreen": self._bool_to_str(settings.fullscreen),
            "display_session_number": self._bool_to_str(settings.display_session_number),
            "hide_on_pause": self._bool_to_str(settings.hide_on_pause),
            "highlight_aoi": self._bool_to_str(settings.highlight_aoi),
            "font_name": settings.font_name,
        }
        update_ini_section(self.config_path, OPENMATB_SECTION, updates)

    @staticmethod
    def _safe_bool(section: object, key: str, default: bool) -> bool:
        value = ConfigService._safe_str(section, key, "")
        normalized = value.strip().lower()
        if normalized == "true":
            return True
        if normalized == "false":
            return False
        return default

    @staticmethod
    def _safe_int(section: object, key: str, default: int, minimum: int, maximum: int) -> int:
        raw = ConfigService._safe_str(section, key, "")
        try:
            value = int(raw)
        except ValueError:
            return default
        if value < minimum:
            return minimum
        if value > maximum:
            return maximum
        return value

    @staticmethod
    def _safe_str(section: object, key: str, default: str) -> str:
        if isinstance(section, configparser.SectionProxy):
            if key in section:
                return section[key].strip()
            return default
        return default

    @staticmethod
    def _bool_to_str(value: bool) -> str:
        return "True" if value else "False"


def update_ini_section(file_path: Path, section_name: str, updates: dict[str, str]) -> None:
    """Update key/value pairs in one INI section without rewriting comments."""
    if not file_path.exists():
        raise FileNotFoundError(f"Config file not found: {file_path}")

    original_text = file_path.read_text(encoding="utf-8")
    original_lines = original_text.splitlines()

    updated_lines: list[str] = []
    in_target_section = False
    section_found = False
    seen_keys: set[str] = set()

    for line in original_lines:
        stripped = line.strip()

        if stripped.startswith("[") and stripped.endswith("]"):
            if in_target_section:
                for key, value in updates.items():
                    if key not in seen_keys:
                        updated_lines.append(f"{key}={value}")
                in_target_section = False
            section_found = section_found or stripped.lower() == f"[{section_name.lower()}]"
            in_target_section = stripped.lower() == f"[{section_name.lower()}]"
            updated_lines.append(line)
            continue

        if in_target_section and "=" in line:
            left, _right = line.split("=", 1)
            key = left.strip()
            if key in updates:
                updated_lines.append(f"{key}={updates[key]}")
                seen_keys.add(key)
                continue

        updated_lines.append(line)

    if in_target_section:
        for key, value in updates.items():
            if key not in seen_keys:
                updated_lines.append(f"{key}={value}")

    if not section_found:
        if len(updated_lines) > 0 and updated_lines[-1].strip():
            updated_lines.append("")
        updated_lines.append(f"[{section_name}]")
        for key, value in updates.items():
            updated_lines.append(f"{key}={value}")

    file_path.write_text("\n".join(updated_lines) + "\n", encoding="utf-8")


def extract_requirement_name(requirement_line: str) -> str | None:
    """Extract package name from one requirements.txt line."""
    stripped = requirement_line.strip()
    if not stripped or stripped.startswith("#"):
        return None

    cleaned = stripped.split(";", 1)[0].strip()
    match = re.match(r"^([A-Za-z0-9_.-]+)", cleaned)
    if match is None:
        return None
    return match.group(1)


def get_missing_packages(requirements_path: Path) -> list[str]:
    """Detect missing Python packages declared in requirements.txt."""
    if not requirements_path.exists():
        return []

    missing: list[str] = []
    for line in requirements_path.read_text(encoding="utf-8").splitlines():
        package_name = extract_requirement_name(line)
        if package_name is None:
            continue

        module_name = PACKAGE_TO_MODULE.get(package_name.lower(), package_name.replace("-", "_"))
        if importlib.util.find_spec(module_name) is None:
            missing.append(package_name)
    return missing


def run_system_check(repo_root: Path) -> SystemCheckReport:
    """Compute an environment report used by --check mode."""
    service = ConfigService(repo_root)
    languages = tuple(service.discover_languages())
    scenarios = tuple(service.discover_scenarios())
    missing_packages = tuple(get_missing_packages(repo_root / "requirements.txt"))
    return SystemCheckReport(
        available_languages=languages,
        available_scenarios=scenarios,
        missing_packages=missing_packages,
        config_exists=service.config_path.exists(),
    )


class LauncherUI:
    """Tkinter-based launcher and process manager."""

    def __init__(self, repo_root: Path) -> None:
        self.repo_root = repo_root
        self.config_service = ConfigService(repo_root)

        self.root = tk.Tk()
        self.root.title("OpenMATB Functional Launcher")
        self.root.geometry("1040x760")
        self.root.minsize(860, 620)
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

        self.process: subprocess.Popen[str] | None = None
        self.output_thread: threading.Thread | None = None
        self.log_queue: queue.Queue[str] = queue.Queue(maxsize=MAX_QUEUE_LINES)
        self.log_buffer: Deque[str] = deque(maxlen=MAX_LOG_LINES)

        self.language_options = self.config_service.discover_languages()
        self.scenario_options = self.config_service.discover_scenarios()

        if not self.language_options:
            raise ValueError("No languages found in locales/*/LC_MESSAGES/openmatb.po.")
        if not self.scenario_options:
            raise ValueError("No scenario files found in includes/scenarios/*.txt.")

        self.language_var = tk.StringVar()
        self.scenario_var = tk.StringVar()
        self.screen_index_var = tk.StringVar(value="0")
        self.font_name_var = tk.StringVar()

        self.fullscreen_var = tk.BooleanVar(value=True)
        self.display_session_var = tk.BooleanVar(value=True)
        self.hide_on_pause_var = tk.BooleanVar(value=False)
        self.highlight_aoi_var = tk.BooleanVar(value=False)

        self.status_var = tk.StringVar(value="Ready.")

        self.save_button: ttk.Button | None = None
        self.launch_button: ttk.Button | None = None
        self.generate_button: ttk.Button | None = None
        self.install_button: ttk.Button | None = None
        self.stop_button: ttk.Button | None = None
        self.log_text: tk.Text | None = None

        self._build_ui()
        self._load_initial_settings()

    def _build_ui(self) -> None:
        root_frame = ttk.Frame(self.root, padding=14)
        root_frame.grid(row=0, column=0, sticky="nsew")
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)
        root_frame.columnconfigure(0, weight=1)
        root_frame.rowconfigure(2, weight=1)

        config_frame = ttk.LabelFrame(root_frame, text="Configuration", padding=12)
        config_frame.grid(row=0, column=0, sticky="ew")
        for col in range(4):
            config_frame.columnconfigure(col, weight=1 if col in (1, 2) else 0)

        ttk.Label(config_frame, text="Language").grid(row=0, column=0, sticky="w", padx=(0, 8), pady=4)
        language_combo = ttk.Combobox(
            config_frame,
            textvariable=self.language_var,
            values=self.language_options,
            state="readonly",
            width=18,
        )
        language_combo.grid(row=0, column=1, sticky="ew", pady=4)

        ttk.Label(config_frame, text="Screen Index").grid(row=0, column=2, sticky="e", padx=(12, 8), pady=4)
        ttk.Entry(config_frame, textvariable=self.screen_index_var, width=10).grid(row=0, column=3, sticky="ew", pady=4)

        ttk.Label(config_frame, text="Scenario").grid(row=1, column=0, sticky="w", padx=(0, 8), pady=4)
        scenario_combo = ttk.Combobox(
            config_frame,
            textvariable=self.scenario_var,
            values=self.scenario_options,
            state="normal",
            width=60,
        )
        scenario_combo.grid(row=1, column=1, columnspan=2, sticky="ew", pady=4)
        ttk.Button(config_frame, text="Browse...", command=self._browse_scenario).grid(row=1, column=3, sticky="ew", pady=4)

        ttk.Label(config_frame, text="Font Name").grid(row=2, column=0, sticky="w", padx=(0, 8), pady=4)
        ttk.Entry(config_frame, textvariable=self.font_name_var).grid(row=2, column=1, columnspan=3, sticky="ew", pady=4)

        ttk.Checkbutton(config_frame, text="Fullscreen", variable=self.fullscreen_var).grid(row=3, column=0, sticky="w", pady=4)
        ttk.Checkbutton(config_frame, text="Display Session ID", variable=self.display_session_var).grid(row=3, column=1, sticky="w", pady=4)
        ttk.Checkbutton(config_frame, text="Hide On Pause", variable=self.hide_on_pause_var).grid(row=3, column=2, sticky="w", pady=4)
        ttk.Checkbutton(config_frame, text="Highlight AOI", variable=self.highlight_aoi_var).grid(row=3, column=3, sticky="w", pady=4)

        action_frame = ttk.LabelFrame(root_frame, text="Actions", padding=12)
        action_frame.grid(row=1, column=0, sticky="ew", pady=(10, 10))
        for col in range(5):
            action_frame.columnconfigure(col, weight=1)

        self.save_button = ttk.Button(action_frame, text="Save Config", command=self._on_save_config)
        self.save_button.grid(row=0, column=0, sticky="ew", padx=4)
        self.launch_button = ttk.Button(action_frame, text="Launch OpenMATB", command=self._on_launch_app)
        self.launch_button.grid(row=0, column=1, sticky="ew", padx=4)
        self.generate_button = ttk.Button(action_frame, text="Generate Scenario", command=self._on_generate_scenario)
        self.generate_button.grid(row=0, column=2, sticky="ew", padx=4)
        self.install_button = ttk.Button(action_frame, text="Install Dependencies", command=self._on_install_dependencies)
        self.install_button.grid(row=0, column=3, sticky="ew", padx=4)
        self.stop_button = ttk.Button(action_frame, text="Stop Process", command=self._on_stop_process, state="disabled")
        self.stop_button.grid(row=0, column=4, sticky="ew", padx=4)

        log_frame = ttk.LabelFrame(root_frame, text="Process Output", padding=12)
        log_frame.grid(row=2, column=0, sticky="nsew")
        log_frame.columnconfigure(0, weight=1)
        log_frame.rowconfigure(0, weight=1)

        self.log_text = tk.Text(log_frame, wrap="none", state="disabled", font=("Courier New", 10))
        self.log_text.grid(row=0, column=0, sticky="nsew")

        y_scroll = ttk.Scrollbar(log_frame, orient="vertical", command=self.log_text.yview)
        y_scroll.grid(row=0, column=1, sticky="ns")
        self.log_text.configure(yscrollcommand=y_scroll.set)

        x_scroll = ttk.Scrollbar(log_frame, orient="horizontal", command=self.log_text.xview)
        x_scroll.grid(row=1, column=0, sticky="ew")
        self.log_text.configure(xscrollcommand=x_scroll.set)

        status_label = ttk.Label(root_frame, textvariable=self.status_var)
        status_label.grid(row=3, column=0, sticky="ew", pady=(8, 0))

    def _load_initial_settings(self) -> None:
        settings = self.config_service.load_settings()
        self.language_var.set(self._coerce_value(settings.language, self.language_options))
        self.scenario_var.set(self._coerce_value(settings.scenario_path, self.scenario_options))
        self.screen_index_var.set(str(settings.screen_index))
        self.font_name_var.set(settings.font_name)

        self.fullscreen_var.set(settings.fullscreen)
        self.display_session_var.set(settings.display_session_number)
        self.hide_on_pause_var.set(settings.hide_on_pause)
        self.highlight_aoi_var.set(settings.highlight_aoi)

    @staticmethod
    def _coerce_value(value: str, allowed_values: list[str]) -> str:
        if value in allowed_values:
            return value
        if allowed_values:
            return allowed_values[0]
        return value

    def _collect_settings(self) -> LauncherSettings:
        language = self.language_var.get().strip()
        scenario = self.scenario_var.get().strip()
        font_name = self.font_name_var.get().strip()

        if not language:
            raise ValueError("Language is required.")
        if language not in self.language_options:
            raise ValueError(f"Unsupported language: {language}")
        if not scenario:
            raise ValueError("Scenario path is required.")

        candidate = self.config_service.scenarios_path / scenario
        if not candidate.exists():
            raise ValueError(f"Scenario file does not exist under includes/scenarios: {scenario}")

        try:
            screen_index = int(self.screen_index_var.get().strip())
        except ValueError as exc:
            raise ValueError("Screen index must be an integer.") from exc

        if screen_index < 0 or screen_index > MAX_SCREEN_INDEX:
            raise ValueError(f"Screen index must be between 0 and {MAX_SCREEN_INDEX}.")

        return LauncherSettings(
            language=language,
            scenario_path=scenario,
            screen_index=screen_index,
            fullscreen=self.fullscreen_var.get(),
            display_session_number=self.display_session_var.get(),
            hide_on_pause=self.hide_on_pause_var.get(),
            highlight_aoi=self.highlight_aoi_var.get(),
            font_name=font_name,
        )

    def _on_save_config(self) -> None:
        try:
            settings = self._collect_settings()
            self.config_service.save_settings(settings)
        except (ValueError, OSError) as exc:
            messagebox.showerror("Config Error", str(exc))
            self.status_var.set("Configuration save failed.")
            return
        self.status_var.set("Configuration saved.")
        self._append_log_line("Configuration saved to config.ini")

    def _browse_scenario(self) -> None:
        selected = filedialog.askopenfilename(
            title="Select scenario file",
            initialdir=str(self.config_service.scenarios_path),
            filetypes=[("Scenario text files", "*.txt"), ("All files", "*.*")],
        )
        if not selected:
            return

        selected_path = Path(selected).resolve()
        scenario_root = self.config_service.scenarios_path.resolve()
        try:
            relative = selected_path.relative_to(scenario_root).as_posix()
        except ValueError:
            messagebox.showerror("Invalid Scenario", "Scenario must be inside includes/scenarios.")
            return

        self.scenario_var.set(relative)
        if relative not in self.scenario_options:
            self.scenario_options.append(relative)
            self.scenario_options.sort()

    def _on_install_dependencies(self) -> None:
        command = [sys.executable, "-m", "pip", "install", "-r", "requirements.txt"]
        self._start_process(command, "Install Dependencies")

    def _on_generate_scenario(self) -> None:
        command = [sys.executable, "scenario_generator.py"]
        self._start_process(command, "Scenario Generator")

    def _on_launch_app(self) -> None:
        command = [sys.executable, "main.py"]
        self._start_process(command, "OpenMATB")

    def _start_process(self, command: list[str], process_name: str) -> None:
        if self.process is not None and self.process.poll() is None:
            messagebox.showwarning("Process Active", "A process is already running. Stop it first.")
            return

        try:
            settings = self._collect_settings()
            self.config_service.save_settings(settings)
        except (ValueError, OSError) as exc:
            messagebox.showerror("Config Error", str(exc))
            self.status_var.set("Process launch aborted due to invalid configuration.")
            return

        self._append_log_line(f"Starting {process_name}: {' '.join(command)}")
        self.status_var.set(f"Running {process_name}...")

        try:
            proc = subprocess.Popen(
                command,
                cwd=str(self.repo_root),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
        except (OSError, ValueError) as exc:
            messagebox.showerror("Launch Error", str(exc))
            self.status_var.set("Process failed to start.")
            return

        self.process = proc
        self._set_running_state(True)
        if proc.stdout is None:
            self._append_log_line("Warning: process output stream is unavailable.")
        else:
            self.output_thread = threading.Thread(
                target=self._read_process_output,
                args=(proc.stdout,),
                daemon=True,
            )
            self.output_thread.start()
        self.root.after(POLL_INTERVAL_MS, self._poll_process)

    def _read_process_output(self, stream: object) -> None:
        if not hasattr(stream, "readline"):
            return

        for raw_line in stream:
            line = raw_line.rstrip("\n")
            self._enqueue_log_line(line)

    def _enqueue_log_line(self, line: str) -> None:
        try:
            self.log_queue.put_nowait(line)
        except queue.Full:
            try:
                _ = self.log_queue.get_nowait()
            except queue.Empty:
                pass
            try:
                self.log_queue.put_nowait(line)
            except queue.Full:
                pass

    def _poll_process(self) -> None:
        updated = False
        for _ in range(MAX_DRAIN_PER_POLL):
            try:
                line = self.log_queue.get_nowait()
            except queue.Empty:
                break
            self.log_buffer.append(line)
            updated = True

        if updated:
            self._render_log_buffer()

        active = self.process is not None and self.process.poll() is None
        if active:
            self.root.after(POLL_INTERVAL_MS, self._poll_process)
            return

        if self.process is not None:
            exit_code = self.process.poll()
            self._append_log_line(f"Process exited with code {exit_code}.")
            self.status_var.set(f"Process finished (exit code {exit_code}).")
        self.process = None
        self.output_thread = None
        self._set_running_state(False)

    def _append_log_line(self, line: str) -> None:
        self.log_buffer.append(line)
        self._render_log_buffer()

    def _render_log_buffer(self) -> None:
        if self.log_text is None:
            return
        self.log_text.configure(state="normal")
        self.log_text.delete("1.0", tk.END)
        if self.log_buffer:
            self.log_text.insert("1.0", "\n".join(self.log_buffer) + "\n")
        self.log_text.configure(state="disabled")
        self.log_text.see(tk.END)

    def _set_running_state(self, running: bool) -> None:
        if self.save_button is not None:
            self.save_button.configure(state="disabled" if running else "normal")
        if self.launch_button is not None:
            self.launch_button.configure(state="disabled" if running else "normal")
        if self.generate_button is not None:
            self.generate_button.configure(state="disabled" if running else "normal")
        if self.install_button is not None:
            self.install_button.configure(state="disabled" if running else "normal")
        if self.stop_button is not None:
            self.stop_button.configure(state="normal" if running else "disabled")

    def _on_stop_process(self) -> None:
        self._stop_process(silent=False)

    def _stop_process(self, silent: bool) -> None:
        if self.process is None or self.process.poll() is not None:
            if not silent:
                self.status_var.set("No running process to stop.")
            self._set_running_state(False)
            return

        self.process.terminate()
        try:
            self.process.wait(timeout=TERMINATE_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            self.process.kill()
            try:
                self.process.wait(timeout=KILL_TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired:
                # This should be rare, but we fail closed and keep an explicit message.
                self._append_log_line("Failed to stop process cleanly within timeout.")
        self._append_log_line("Process stopped by user.")
        self.status_var.set("Process stopped.")
        self.process = None
        self.output_thread = None
        self._set_running_state(False)

    def on_close(self) -> None:
        running = self.process is not None and self.process.poll() is None
        if running:
            should_quit = messagebox.askyesno("Exit Launcher", "A process is running. Stop it and exit?")
            if not should_quit:
                return
            self._stop_process(silent=True)
        self.root.destroy()

    def run(self) -> None:
        """Start the Tkinter main loop."""
        self.root.mainloop()


def print_check_report(report: SystemCheckReport) -> None:
    """Print --check report in a concise and script-friendly format."""
    print("OpenMATB launcher check")
    print("----------------------")
    print(f"config.ini present: {report.config_exists}")
    print(f"languages found: {len(report.available_languages)}")
    print(f"scenarios found: {len(report.available_scenarios)}")

    if report.available_languages:
        print("language options: " + ", ".join(report.available_languages))
    if report.available_scenarios:
        preview = ", ".join(report.available_scenarios[:8])
        suffix = " ..." if len(report.available_scenarios) > 8 else ""
        print("scenario sample: " + preview + suffix)

    if report.missing_packages:
        print("missing packages: " + ", ".join(report.missing_packages))
    else:
        print("missing packages: none")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse launcher command-line options."""
    parser = argparse.ArgumentParser(description="OpenMATB functional launcher")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Run environment/config checks without opening the GUI.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    """Program entrypoint."""
    args = parse_args(argv)
    repo_root = Path(__file__).resolve().parent

    if args.check:
        report = run_system_check(repo_root)
        print_check_report(report)
        if not report.config_exists:
            return 1
        return 0

    try:
        app = LauncherUI(repo_root)
    except (ValueError, tk.TclError) as exc:
        print(f"Launcher startup failed: {exc}", file=sys.stderr)
        return 1

    app.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
