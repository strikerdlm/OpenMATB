# OpenMATB Web Tactical Console Manual

This manual complements:
- `README.md` for setup and overview,
- `CHANGELOG.md` for release-level history.

## Feature list

### 1) Scenario intelligence and configuration safety
- Scenario cards are generated from detected files under `includes/scenarios`.
- Category and intensity hints are inferred from scenario names.
- Pre-save and pre-launch validation prevents invalid paths/settings from being executed.

### 2) Cockpit instrument cluster
- The tactical console renders a pilot-style gauge cluster with richer dial graphics.
- Gauge presets are scenario-aware:
  - training/MWE scenarios: lighter aircraft profile,
  - communications-heavy scenarios: IFR/radio-focused profile,
  - combat/high-reliability scenarios: high-energy intercept profile,
  - night scenarios: stabilized night-approach profile.
- METAR values are mapped into dedicated gauges (wind, visibility, ceiling, altimeter).

### 3) METAR distraction feed
- A session-scoped METAR report is produced by the backend.
- Source priority:
  1. live METAR from web station feeds,
  2. generated valid METAR fallback when web access fails.
- The UI displays both:
  - raw METAR line,
  - decoded weather values and flight category.

## Usage examples

### Example A: Typical connected session
1. Start API and frontend (see `README.md`).
2. Select a scenario from the scenario grid.
3. Observe:
   - instrument cluster profile update,
   - METAR source chip showing **Live Web METAR**,
   - decoded weather values reflected in METAR gauges.

### Example B: Offline / restricted network session
1. Run the same workflow without internet connectivity.
2. The METAR panel should automatically switch to **Generated Fallback**.
3. A valid synthetic METAR remains available so distraction behavior is preserved.

### Example C: Session refresh behavior
1. Keep the same browser tab open: METAR is tied to that session ID.
2. Use **Refresh METAR** to force a new fetch/generation.
3. Open a new tab/session to receive a different session ID and METAR context.

## Additional ideas for future iterations

1. **ATC phraseology distraction channel**  
   Add realistic phrase snippets with increasing ambiguity by scenario intensity.

2. **NOTAM/ATIS ticker lane**  
   Add a secondary textual stream with occasionally conflicting operational hints.

3. **Environment stress overlays**  
   Add icing/turbulence crosswind indicators that modulate gauge noise and alerts.

4. **Adaptive distraction scheduler**  
   Increase METAR/ATC interruption frequency when user misses key scenario events.

5. **Instructor control hooks**  
   Provide API toggles to force weather shifts or synthetic comms spikes during live sessions.

## Security reminder

- Do not put API keys or secrets in source files.
- Use environment variables (`.env` / deployment environment injection) for sensitive values before committing.
