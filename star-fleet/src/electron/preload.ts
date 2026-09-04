import { contextBridge, ipcRenderer } from "electron";
import type {
  ConnectionProfile,
  CreateRunInput,
  DirEntry,
  Problem,
  SavedRunManifest,
  SessionLog,
  SessionState,
  SessionStatus,
} from "../shared/types";

export interface AppSettings {
  openaiApiKey: string;
}

export interface TabsApi {
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  listProfiles(): Promise<ConnectionProfile[]>;
  listProblems(): Promise<Problem[]>;
  addProblem(
    name: string,
    description: string,
    category?: import("../shared/types").ProblemCategory,
    sourceUrl?: string
  ): Promise<Problem>;
  removeProblem(id: string): Promise<void>;
  createRun(input: CreateRunInput): Promise<ConnectionProfile>;
  saveRun(profileId: string, note?: string): Promise<SavedRunManifest>;
  listSavedRuns(problemId?: string): Promise<SavedRunManifest[]>;
  onSpinupProgress(cb: (msg: { message: string }) => void): () => void;
  renameProfile(id: string, name: string): Promise<void>;
  setRemotePath(id: string, remotePath: string): Promise<void>;
  removeProfile(id: string): Promise<void>;
  open(profileId: string): Promise<void>;
  disconnect(profileId: string): Promise<void>;
  getSessionState(profileId: string): Promise<{ status: SessionStatus; message: string }>;
  pingHost(profileId: string): Promise<boolean>;
  startThinking(profileId: string): void;
  stopThinking(profileId: string): void;
  sendToAgent(profileId: string, text: string): Promise<void>;
  killAll(): Promise<{ id: string; name: string; ok: boolean; error?: string }[]>;
  onThinkingLine(cb: (msg: { profileId: string; line: string }) => void): () => void;
  listFiles(profileId: string, dir: string): Promise<DirEntry[]>;
  readFile(profileId: string, file: string): Promise<{ content: string; truncated: boolean }>;
  writeFile(profileId: string, file: string, content: string): Promise<void>;
  onSessionState(cb: (state: SessionState) => void): () => void;
  onSessionLog(cb: (log: SessionLog) => void): () => void;
}

const api: TabsApi = {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch) => ipcRenderer.invoke("settings:update", patch),
  listProfiles: () => ipcRenderer.invoke("profiles:list"),
  listProblems: () => ipcRenderer.invoke("problems:list"),
  addProblem: (name, description, category, sourceUrl) =>
    ipcRenderer.invoke("problems:add", name, description, category, sourceUrl),
  removeProblem: (id) => ipcRenderer.invoke("problems:remove", id),
  createRun: (input) => ipcRenderer.invoke("runs:create", input),
  saveRun: (profileId, note) => ipcRenderer.invoke("runs:save", profileId, note),
  listSavedRuns: (problemId) => ipcRenderer.invoke("runs:listSaved", problemId),
  onSpinupProgress: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, msg: { message: string }) => cb(msg);
    ipcRenderer.on("do:progress", handler);
    return () => ipcRenderer.removeListener("do:progress", handler);
  },
  renameProfile: (id, name) => ipcRenderer.invoke("profiles:rename", id, name),
  setRemotePath: (id, remotePath) => ipcRenderer.invoke("profiles:setPath", id, remotePath),
  removeProfile: (id) => ipcRenderer.invoke("profiles:remove", id),
  open: (profileId) => ipcRenderer.invoke("session:open", profileId),
  disconnect: (profileId) => ipcRenderer.invoke("session:disconnect", profileId),
  getSessionState: (profileId) => ipcRenderer.invoke("session:state", profileId),
  pingHost: (profileId) => ipcRenderer.invoke("session:ping", profileId),
  startThinking: (profileId) => ipcRenderer.send("agent:think:start", profileId),
  stopThinking: (profileId) => ipcRenderer.send("agent:think:stop", profileId),
  sendToAgent: (profileId, text) => ipcRenderer.invoke("agent:send", profileId, text),
  killAll: () => ipcRenderer.invoke("agent:killAll"),
  onThinkingLine: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, msg: { profileId: string; line: string }) => cb(msg);
    ipcRenderer.on("agent:think:line", handler);
    return () => ipcRenderer.removeListener("agent:think:line", handler);
  },
  listFiles: (profileId, dir) => ipcRenderer.invoke("files:list", profileId, dir),
  readFile: (profileId, file) => ipcRenderer.invoke("files:read", profileId, file),
  writeFile: (profileId, file, content) =>
    ipcRenderer.invoke("files:write", profileId, file, content),
  onSessionState: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, state: SessionState) => cb(state);
    ipcRenderer.on("session:state", handler);
    return () => ipcRenderer.removeListener("session:state", handler);
  },
  onSessionLog: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, log: SessionLog) => cb(log);
    ipcRenderer.on("session:log", handler);
    return () => ipcRenderer.removeListener("session:log", handler);
  },
};

contextBridge.exposeInMainWorld("tabs", api);
