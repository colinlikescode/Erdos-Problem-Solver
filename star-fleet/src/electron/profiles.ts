import { app } from "electron";
import { utils as sshUtils } from "ssh2";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { ConnectionProfile, ProfileInput, SshCredential } from "../shared/types";

/**
 * Decode the key with ssh2's parser (PKCS#1/PKCS#8/OpenSSH/PPK) so bad keys
 * fail immediately with a clear message instead of at connect time.
 */
function assertUsableKey(pemKey: string): void {
  const parsed = sshUtils.parseKey(pemKey);
  if (parsed instanceof Error) {
    if (/encrypted|passphrase/i.test(parsed.message)) {
      throw new Error(
        "This key is passphrase-protected. Export an unencrypted copy with: " +
          "ssh-keygen -p -N '' -f <keyfile>"
      );
    }
    throw new Error(`Couldn't decode this key: ${parsed.message}`);
  }
}

interface StoredProfile extends ConnectionProfile {
  /** Exactly one is set, matching `authMethod`. Never sent to the renderer. */
  pemKey?: string;
  password?: string;
  /** Optional problem.md contents to write when the snapshot is first placed. */
  seedProblem?: string;
}

/** New tabs open the provisioner-placed research snapshot by default. */
function defaultRemotePath(username: string): string {
  return username === "root" ? "/root/snapshot" : `/home/${username}/snapshot`;
}

/**
 * Plain-JSON persistence in the app's userData folder.
 * The user explicitly opted into storing keys unencrypted on this machine.
 */
export class ProfileStore {
  private file: string;
  private profiles: StoredProfile[] = [];

  constructor() {
    this.file = path.join(app.getPath("userData"), "profiles.json");
    this.load();
  }

  private load() {
    try {
      this.profiles = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      this.profiles = [];
    }
    // Backfill fields added after older profiles were saved. Every machine runs
    // the unified `pi` agent now (legacy claude/codex/shell/… all fold in).
    for (const p of this.profiles) {
      p.agent = "pi";
      if (!p.remotePath) {
        p.remotePath = defaultRemotePath(p.username);
      }
      // Profiles saved before password auth existed were key-only.
      if (!p.authMethod) p.authMethod = p.password ? "password" : "key";
    }
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.profiles, null, 2));
  }

  /** Strip secrets + seed data before anything crosses to the renderer. */
  private redact(p: StoredProfile): ConnectionProfile {
    const { pemKey: _k, password: _pw, seedProblem: _sp, ...pub } = p;
    return pub;
  }

  /** The one-time problem.md seed for this machine (main-process only). */
  getSeedProblem(id: string): string {
    return this.profiles.find((x) => x.id === id)?.seedProblem ?? "";
  }

  list(): ConnectionProfile[] {
    return this.profiles.map((p) => this.redact(p));
  }

  get(id: string): ConnectionProfile | undefined {
    const p = this.profiles.find((x) => x.id === id);
    return p ? this.redact(p) : undefined;
  }

  /** The secret used to connect (key or password). Main-process only. */
  getCredential(id: string): SshCredential {
    const p = this.profiles.find((x) => x.id === id);
    if (!p) return {};
    return p.authMethod === "password" ? { password: p.password } : { pemKey: p.pemKey };
  }

  add(input: ProfileInput): ConnectionProfile {
    const pemKey = input.pemKey?.trim();
    const password = input.password ?? "";
    if (pemKey) {
      assertUsableKey(pemKey);
    } else if (!password) {
      throw new Error("Provide a private key or a password to connect.");
    }
    const username = input.username.trim() || "root";
    const profile: StoredProfile = {
      id: crypto.randomUUID(),
      name: input.name?.trim() || `${username}@${input.host}`,
      host: input.host.trim(),
      port: input.port || 22,
      username,
      remotePath: input.remotePath?.trim() || defaultRemotePath(username),
      agent: input.agent ?? "pi",
      authMethod: pemKey ? "key" : "password",
      ...(pemKey ? { pemKey } : { password }),
      ...(input.seedProblem?.trim() ? { seedProblem: input.seedProblem } : {}),
      ...(input.problemId ? { problemId: input.problemId } : {}),
      ...(input.restoreRunId ? { restoreRunId: input.restoreRunId } : {}),
      ...(input.autoStart ? { autoStart: true } : {}),
      ...(input.dropletId ? { dropletId: input.dropletId } : {}),
      createdAt: Date.now(),
    };
    this.profiles.push(profile);
    this.persist();
    return this.redact(profile);
  }

  rename(id: string, name: string) {
    const profile = this.profiles.find((p) => p.id === id);
    const trimmed = name.trim();
    if (!profile || !trimmed) return;
    profile.name = trimmed;
    this.persist();
  }

  setRemotePath(id: string, remotePath: string) {
    const profile = this.profiles.find((p) => p.id === id);
    const trimmed = remotePath.trim();
    if (!profile || !trimmed) return;
    profile.remotePath = trimmed;
    this.persist();
  }

  remove(id: string) {
    this.profiles = this.profiles.filter((p) => p.id !== id);
    this.persist();
  }
}
