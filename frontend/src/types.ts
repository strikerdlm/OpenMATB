export interface SettingsPayload {
  language: string;
  scenario_path: string;
  screen_index: number;
  fullscreen: boolean;
  display_session_number: boolean;
  hide_on_pause: boolean;
  highlight_aoi: boolean;
  font_name: string;
}

export interface SettingsResponse {
  available_languages: string[];
  available_scenarios: string[];
  settings: SettingsPayload;
}

export interface ProcessSnapshot {
  running: boolean;
  current_action: string | null;
  last_exit_code: number | null;
  status_message: string;
  logs: string[];
}

export interface SystemCheckPayload {
  config_exists: boolean;
  available_languages: string[];
  available_scenarios: string[];
  missing_packages: string[];
}

export type MetarSource = "web" | "generated";
export type FlightCategory = "VFR" | "MVFR" | "IFR" | "LIFR";

export interface MetarPayload {
  session_id: string;
  source: MetarSource;
  station: string;
  scenario_profile: string;
  flight_category: FlightCategory;
  metar: string;
  issued_at: string;
  fetched_at: string;
  wind_degrees: number;
  wind_speed_kt: number;
  gust_kt: number | null;
  visibility_sm: number;
  ceiling_ft: number | null;
  temperature_c: number;
  dewpoint_c: number;
  altimeter_inhg: number;
}
