"""Security regression tests for web launcher API mutating endpoints."""

from __future__ import annotations

from fastapi.testclient import TestClient

import web_launcher_api


TRUSTED_CLIENT_HEADER = {
    "X-OpenMATB-Client": "web-launcher-ui",
}

VALID_SETTINGS_PAYLOAD = {
    "language": "en_EN",
    "scenario_path": "default.txt",
    "screen_index": 0,
    "fullscreen": True,
    "display_session_number": True,
    "hide_on_pause": False,
    "highlight_aoi": False,
    "font_name": "",
}


def test_mutating_endpoints_require_trusted_client_header(monkeypatch) -> None:
    """Mutating endpoints must reject requests without trusted marker header."""
    client = TestClient(web_launcher_api.app)
    monkeypatch.setattr(web_launcher_api.config_service, "discover_languages", lambda: ["en_EN"])
    monkeypatch.setattr(
        web_launcher_api.config_service,
        "discover_scenarios",
        lambda: ["default.txt"],
    )

    put_response = client.put("/api/settings", json=VALID_SETTINGS_PAYLOAD)
    assert put_response.status_code == 403
    assert "trusted client marker" in put_response.json()["detail"].lower()

    post_response = client.post("/api/actions/stop")
    assert post_response.status_code == 403
    assert "trusted client marker" in post_response.json()["detail"].lower()


def test_mutating_endpoints_accept_valid_trusted_client_header(monkeypatch) -> None:
    """Mutating endpoints continue to work for trusted web UI requests."""
    client = TestClient(web_launcher_api.app)
    monkeypatch.setattr(web_launcher_api.config_service, "discover_languages", lambda: ["en_EN"])
    monkeypatch.setattr(
        web_launcher_api.config_service,
        "discover_scenarios",
        lambda: ["default.txt"],
    )
    monkeypatch.setattr(
        web_launcher_api.config_service,
        "save_settings",
        lambda _settings: None,
    )
    monkeypatch.setattr(
        web_launcher_api.config_service,
        "load_settings",
        lambda: web_launcher_api.LauncherSettings(
            language="en_EN",
            scenario_path="default.txt",
            screen_index=0,
            fullscreen=True,
            display_session_number=True,
            hide_on_pause=False,
            highlight_aoi=False,
            font_name="",
        ),
    )

    put_response = client.put(
        "/api/settings",
        json=VALID_SETTINGS_PAYLOAD,
        headers=TRUSTED_CLIENT_HEADER,
    )
    assert put_response.status_code == 200

    post_response = client.post("/api/actions/stop", headers=TRUSTED_CLIENT_HEADER)
    assert post_response.status_code == 200
