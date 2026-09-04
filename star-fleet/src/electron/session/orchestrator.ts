import { EventEmitter } from "node:events";
import type { ConnectionProfile, DirEntry, SessionStatus, SshCredential } from "../../shared/types";
import { Session, type SessionEventMap, type RestoreHook } from "./children/session";

/**
 * Orchestrates one `Session` (SSH connection) per machine profile: creates them
 * on demand, relays their `state`/`log` events, and routes file, thinking, and
 * run-save operations to the right session. This is the single entry point
 * `main.ts` uses to drive all remote VMs.
 */
export class SessionManager extends EventEmitter<SessionEventMap> {
  private sessions = new Map<string, Session>();

  private getOrCreate(
    profile: ConnectionProfile,
    cred: SshCredential,
    env: Record<string, string>,
    seedProblem: string,
    restoreHook?: RestoreHook
  ): Session {
    let session = this.sessions.get(profile.id);
    if (session && (session.status === "error" || session.status === "disconnected")) {
      session = undefined;
      this.sessions.delete(profile.id);
    }
    if (!session) {
      session = new Session(profile, cred, env, seedProblem, restoreHook);
      session.on("state", (id, status, message) => this.emit("state", id, status, message));
      session.on("log", (id, line) => this.emit("log", id, line));
      this.sessions.set(profile.id, session);
    }
    return session;
  }

  async open(
    profile: ConnectionProfile,
    cred: SshCredential,
    env: Record<string, string> = {},
    seedProblem = "",
    restoreHook?: RestoreHook
  ): Promise<void> {
    await this.getOrCreate(profile, cred, env, seedProblem, restoreHook).open();
  }

  /** The ready session for a profile (used by main.ts for run saves). */
  session(profileId: string): Session {
    return this.ready(profileId);
  }

  getState(profileId: string): { status: SessionStatus; message: string } {
    const s = this.sessions.get(profileId);
    return s ? { status: s.status, message: s.message } : { status: "idle", message: "" };
  }

  private ready(profileId: string): Session {
    const session = this.sessions.get(profileId);
    if (!session || session.status !== "ready") throw new Error("session not ready");
    return session;
  }

  listDir(profileId: string, path: string): Promise<DirEntry[]> {
    return this.ready(profileId).listDir(path);
  }

  readFile(profileId: string, path: string): Promise<{ content: string; truncated: boolean }> {
    return this.ready(profileId).readFile(path);
  }

  writeFile(profileId: string, path: string, content: string): Promise<void> {
    return this.ready(profileId).writeFile(path, content);
  }

  private thinking = new Map<string, { close: () => void }>();

  startThinking(profileId: string, onLine: (line: string) => void) {
    this.stopThinking(profileId);
    const s = this.sessions.get(profileId);
    if (!s || s.status !== "ready") return;
    this.thinking.set(profileId, s.streamThinking(onLine));
  }

  stopThinking(profileId: string) {
    this.thinking.get(profileId)?.close();
    this.thinking.delete(profileId);
  }

  sendToAgent(profileId: string, text: string): Promise<void> {
    return this.ready(profileId).sendToRepl(text);
  }

  disconnect(profileId: string) {
    this.stopThinking(profileId);
    this.sessions.get(profileId)?.disconnect();
    this.sessions.delete(profileId);
  }

  disconnectAll() {
    for (const [, s] of this.sessions) s.disconnect();
    this.sessions.clear();
  }
}
