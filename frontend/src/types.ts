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
