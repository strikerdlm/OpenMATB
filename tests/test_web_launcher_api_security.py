"""Security regression tests for web launcher write endpoints."""

from fastapi.testclient import TestClient

from web_launcher_api import app


def _valid_settings_payload() -> dict[str, object]:
    """Return a syntactically valid settings payload for request parsing."""
    return {
        "language": "english",
        "scenario_path": "includes/scenarios/mwe/blank.scn",
        "screen_index": 0,
        "fullscreen": False,
        "display_session_number": False,
        "hide_on_pause": False,
        "highlight_aoi": False,
        "font_name": "Arial",
    }


def test_post_action_rejects_untrusted_origin() -> None:
    """Cross-site browser requests must be blocked for state-changing actions."""
    client = TestClient(app)

    response = client.post("/api/actions/stop", headers={"Origin": "https://evil.example"})

    assert response.status_code == 403
    assert "Cross-site origin is not allowed" in response.json()["detail"]


def test_put_settings_rejects_untrusted_origin() -> None:
    """Cross-site browser requests must be blocked for settings writes."""
    client = TestClient(app)

    response = client.put(
        "/api/settings",
        headers={"Origin": "https://evil.example"},
        json=_valid_settings_payload(),
    )

    assert response.status_code == 403
    assert "Cross-site origin is not allowed" in response.json()["detail"]


def test_post_action_allows_non_browser_and_trusted_origins() -> None:
    """Non-browser clients and trusted frontend origins should keep working."""
    client = TestClient(app)

    no_origin_response = client.post("/api/actions/stop")
    trusted_origin_response = client.post(
        "/api/actions/stop",
        headers={"Origin": "http://localhost:5173"},
    )

    assert no_origin_response.status_code == 200
    assert trusted_origin_response.status_code == 200
