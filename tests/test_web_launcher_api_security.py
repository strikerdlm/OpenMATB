"""Security regression tests for web launcher API mutating endpoints."""

from __future__ import annotations

from fastapi.testclient import TestClient

import web_launcher_api


TRUSTED_CLIENT_HEADER = {
    "X-OpenMATB-Client": "web-launcher-ui",
}


def test_mutating_endpoints_require_trusted_client_header() -> None:
    """Mutating endpoints must reject requests without trusted marker header."""
    client = TestClient(web_launcher_api.app)
    settings_response = client.get("/api/settings")
    assert settings_response.status_code == 200
    settings_payload = settings_response.json()["settings"]

    put_response = client.put("/api/settings", json=settings_payload)
    assert put_response.status_code == 403
    assert "trusted client marker" in put_response.json()["detail"].lower()

    post_response = client.post("/api/actions/stop")
    assert post_response.status_code == 403
    assert "trusted client marker" in post_response.json()["detail"].lower()


def test_mutating_endpoints_accept_valid_trusted_client_header() -> None:
    """Mutating endpoints continue to work for trusted web UI requests."""
    client = TestClient(web_launcher_api.app)
    settings_response = client.get("/api/settings")
    assert settings_response.status_code == 200
    settings_payload = settings_response.json()["settings"]

    put_response = client.put(
        "/api/settings",
        json=settings_payload,
        headers=TRUSTED_CLIENT_HEADER,
    )
    assert put_response.status_code == 200

    post_response = client.post("/api/actions/stop", headers=TRUSTED_CLIENT_HEADER)
    assert post_response.status_code == 200
