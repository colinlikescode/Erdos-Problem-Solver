import type { TabsApi } from "../electron/preload";

declare global {
  interface Window {
    tabs: TabsApi;
  }
}

export function api(): TabsApi {
  return window.tabs;
}

export type { AppSettings, TabsApi } from "../electron/preload";

export type {
  ConnectionProfile,
  ProfileInput,
  Problem,
  CreateRunInput,
  SavedRunManifest,
  SessionState,
  SessionStatus,
  SessionLog,
  AgentKind,
  DirEntry,
} from "../shared/types";
