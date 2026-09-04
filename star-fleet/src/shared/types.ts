// Only Pi runs on these machines. Kept as a one-member type so the tmux session
// name (`tabs-pi`) and start command stay in one place instead of hard-coded.
export type AgentKind = "pi";

/** How Tabs authenticates the SSH connection to a machine. */
export type AuthMethod = "key" | "password";

/** The secret used to connect - exactly one field is set. Never leaves main. */
export interface SshCredential {
  pemKey?: string;
  password?: string;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  /** Remote absolute path the editor opens (and the agent runs in). */
  remotePath: string;
  agent: AgentKind;
  /** Whether this machine connects with a private key or a password. */
  authMethod: AuthMethod;
  /** The saved problem this run works on - the identity that ties saves and
   * continues to one problem forever (no drift). */
  problemId?: string;
  /** When this run CONTINUES a saved run: the R2 save to overlay after the
   * base snapshot is provisioned (chassis from base, cargo from the save). */
  restoreRunId?: string;
  /** Start the agent loop automatically once provisioning finishes. */
  autoStart?: boolean;
  /** DigitalOcean droplet id (set when Star Fleet spun it up), so removing the
   * run can also destroy the droplet. Absent for externally-created machines. */
  dropletId?: number;
  createdAt: number;
}

export interface ProfileInput {
  name?: string;
  host: string;
  port: number;
  username: string;
  /** Provide exactly one of pemKey / password. */
  pemKey?: string;
  password?: string;
  remotePath?: string;
  agent?: AgentKind;
  /** Optional: pre-fill the snapshot's problem.md on first provision. */
  seedProblem?: string;
  /** The saved problem this run works on. */
  problemId?: string;
  /** Saved run (R2) to overlay on first provision - a "Continue Problem" run. */
  restoreRunId?: string;
  /** Auto-start the agent loop after provisioning. */
  autoStart?: boolean;
  /** DigitalOcean droplet id, so deleting the run can destroy the droplet. */
  dropletId?: number;
}

/** Where a problem comes from (rendered as a badge + source link in the UI). */
export type ProblemCategory = "frontier" | "millennium" | "erdos";

export const PROBLEM_CATEGORY_LABEL: Record<ProblemCategory, string> = {
  frontier: "Frontier Math",
  millennium: "Millennium Problem",
  erdos: "Erdős Problem",
};

/** A saved research problem (populates the run dropdown). */
export interface Problem {
  id: string;
  name: string;
  description: string;
  /** Problem family - Frontier Math / Millennium / Erdős. */
  category?: ProblemCategory;
  /** Canonical source page (epoch.ai / claymath.org / erdosproblems.com). */
  sourceUrl?: string;
  createdAt: number;
}

/** How a new run starts: a fresh problem, or continuing a saved run's cargo. */
export interface CreateRunInput {
  source: "new" | "continue";
  /** The saved problem (required for both sources - identity, no drift). */
  problemId?: string;
  /** For source "continue": which saved run to overlay. */
  savedRunId?: string;
}

/** Manifest stored next to every run save in R2 (runs/<problemId>/<runId>/). */
export interface SavedRunManifest {
  formatVersion: number;
  problemId: string;
  problemName: string;
  runId: string;
  savedAt: number;
  /** The save this run was CONTINUED from (lineage; absent = a root save).
   * Saves form a tree per problem - the UI renders it as a branching diagram. */
  parentRunId?: string;
  /** SHA-256 of the run's problem.md - drift alarm against the problem store. */
  problemMdSha256: string;
  /** Provision stamp of the VM the save came from (informational). */
  baseStamp?: string;
  host?: string;
  bytes?: number;
  factCount?: number;
  note?: string;
}

export type SessionStatus =
  | "idle"
  | "connecting"
  | "provisioning"
  | "ready"
  | "error"
  | "disconnected";

export interface SessionState {
  profileId: string;
  status: SessionStatus;
  message?: string;
}

export interface SessionLog {
  profileId: string;
  line: string;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
}
