# Changelog

## 2026-02-26 - Unreleased

### Added
- Added scenario-aware cockpit instrument visuals in the web tactical console with richer dial graphics.
- Added a METAR distraction API endpoint (`/api/distractions/metar`) with per-session caching and bounded refresh behavior.
- Added online METAR retrieval from public station feeds with automatic fallback to generated valid METAR when offline.
- Added frontend METAR panel with decoded weather fields (wind, visibility, ceiling, temperature/dewpoint, altimeter).

### Changed
- Updated tactical console workflow to include automatic METAR refresh and manual refresh control per active session.
- Expanded README documentation for cockpit profiles and METAR distraction operation.
