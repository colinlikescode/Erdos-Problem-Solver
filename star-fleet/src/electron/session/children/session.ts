import { Client } from "ssh2";
import type { ClientChannel, SFTPWrapper } from "ssh2";
import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import type { ConnectionProfile, DirEntry, SessionStatus, SshCredential } from "../../../shared/types";
import { agentTmux, agentStartCommand, buildProvision } from "../../provision/orchestrator";
import { connect, runScript } from "./connection";

/** Ran after a fresh provision, before the agent auto-starts - used to overlay
 *  a saved run's cargo (see electron/runs.ts). Throwing aborts the open. */
export type RestoreHook = (session: Session, log: (msg: string) => void) => Promise<void>;

export type SessionEventMap = {
  state: [profileId: string, status: SessionStatus, message: string];
  log: [profileId: string, line: string];
};

const MAX_VIEW_BYTES = 2 * 1024 * 1024; // 2MB file-view cap keeps the UI responsive

/**
 * One persistent SSH connection to a VM: provisions the agent + tmux on open,
 * then serves SFTP file operations and an interactive agent PTY. Emits `state`
 * and `log` for the orchestrator to relay to the renderer.
 */
export class Session extends EventEmitter<SessionEventMap> {
  readonly profile: ConnectionProfile;
  private cred: SshCredential;
  private env: Record<string, string>;
  private conn: Client | null = null;
  private sftpPromise: Promise<SFTPWrapper> | null = null;
  status: SessionStatus = "idle";
  message = "";

  private seedProblem: string;
  private restoreHook?: RestoreHook;

  constructor(
    profile: ConnectionProfile,
    cred: SshCredential,
    env: Record<string, string>,
    seedProblem = "",
    restoreHook?: RestoreHook
  ) {
    super();
    this.profile = profile;
    this.cred = cred;
    this.env = env;
    this.seedProblem = seedProblem;
    this.restoreHook = restoreHook;
  }

  private setStatus(status: SessionStatus, message = "") {
    this.status = status;
    this.message = message;
    this.emit("state", this.profile.id, status, message);
  }

  private log(line: string) {
    this.emit("log", this.profile.id, line);
  }

  async open(): Promise<void> {
    if (this.status === "ready" && this.conn) return;
    const { username, host, port } = this.profile;
    this.setStatus("connecting", `Connecting to ${username}@${host}...`);
    this.log(`Connecting to ${username}@${host}:${port}`);

    const conn = await connect(host, port, username, this.cred).catch((err: Error) => {
      this.setStatus("error", err.message);
      throw err;
    });

    this.conn = conn;
    conn.on("error", (err) => {
      this.log(`ssh error: ${err.message}`);
      this.setStatus("error", err.message);
    });
    conn.on("close", () => {
      if (this.status !== "error") this.setStatus("disconnected", "SSH connection closed");
      this.conn = null;
    });

    // Provisioning is idempotent but slow (npm, apt, pi extensions). The script
    // records its version stamp on the VM when it completes, so a plain reopen
    // (same script version + agent tmux alive) skips the whole setup instantly.
    const { script, stamp } = buildProvision(
      this.profile.agent,
      this.env,
      this.profile.remotePath,
      this.seedProblem
    );
    const tmux = agentTmux(this.profile.agent);
    const check = await this.execOut(
      `cat "$HOME/.tabs/provision-stamp" 2>/dev/null; tmux has-session -t ${tmux} 2>/dev/null && echo TMUX_OK`
    ).catch(() => "");
    if (check.includes(stamp) && check.includes("TMUX_OK")) {
      this.log("already provisioned (stamp match) - skipping setup");
      await this.maybeRestore(); // an interrupted continue-run finishes here
      this.setStatus("ready", "Connected - agent running in tmux");
      return;
    }

    this.log("SSH connected, provisioning agent...");
    this.setStatus("provisioning", "Setting up agent + tmux...");
    await runScript(conn, script, (line) => this.log(line)).catch((err: Error) => {
      this.setStatus("error", `Setup failed: ${err.message}`);
      throw err;
    });

    // Continue-run: overlay the saved cargo before the agent ever starts.
    await this.maybeRestore();

    this.setStatus("ready", "Connected - agent running in tmux");

    // Auto-start the never-stop loop right after a fresh provision (the new
    // one-click flow - there is no manual /start-new-agent). Only on the
    // just-provisioned path: the stamp-skip reopen above returns early, so a
    // running loop is never double-started. Guarded by the pid file too.
    if (this.profile.autoStart) {
      await new Promise((r) => setTimeout(r, 3000));
      const running = await this.execOut(
        `pid=$(cat "$HOME/.tabs/agent-loop.pid" 2>/dev/null); [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo RUNNING`
      ).catch(() => "");
      if (!running.includes("RUNNING")) {
        this.log("auto-starting the agent loop (/start-new-agent)");
        await this.sendToRepl("/start-new-agent").catch(() => {});
      }
    }
  }

  /**
   * Run the pending cargo restore exactly once per VM (marker-guarded, so an
   * interrupted continue-run resumes the restore on the next open - the
   * provision stamp alone can't be trusted for that, it's written before the
   * overlay happens).
   */
  private async maybeRestore(): Promise<void> {
    if (!this.restoreHook || !this.profile.restoreRunId) return;
    const done = await this.execOut('[ -f "$HOME/.tabs/restore-done" ] && echo DONE').catch(() => "");
    if (done.includes("DONE")) return;
    this.setStatus("provisioning", "Restoring saved run from R2…");
    await this.restoreHook(this, (msg) => this.log(msg)).catch((err: Error) => {
      this.setStatus("error", `Restore failed: ${err.message}`);
      throw err;
    });
  }

  /** Lazily-opened SFTP channel, reused for all file operations. */
  private sftp(): Promise<SFTPWrapper> {
    if (!this.conn) return Promise.reject(new Error("session not connected"));
    if (!this.sftpPromise) {
      this.sftpPromise = new Promise((resolve, reject) => {
        this.conn!.sftp((err, sftp) => {
          if (err) {
            this.sftpPromise = null;
            reject(err);
          } else {
            sftp.on("close", () => (this.sftpPromise = null));
            resolve(sftp);
          }
        });
      });
    }
    return this.sftpPromise;
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const sftp = await this.sftp();
    return new Promise((resolve, reject) => {
      sftp.readdir(path, (err, list) => {
        if (err) return reject(err);
        const entries = list
          .map((e) => ({ name: e.filename, isDir: (e.attrs.mode & 0o170000) === 0o040000 }))
          .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
        resolve(entries);
      });
    });
  }

  async readFile(path: string): Promise<{ content: string; truncated: boolean }> {
    const sftp = await this.sftp();
    return new Promise((resolve, reject) => {
      sftp.stat(path, (err, stats) => {
        if (err) return reject(err);
        const truncated = stats.size > MAX_VIEW_BYTES;
        const stream = sftp.createReadStream(path, truncated ? { start: 0, end: MAX_VIEW_BYTES - 1 } : {});
        const chunks: Buffer[] = [];
        stream.on("data", (d: Buffer) => chunks.push(d));
        stream.on("error", reject);
        stream.on("end", () => resolve({ content: Buffer.concat(chunks).toString("utf8"), truncated }));
      });
    });
  }

  /** Run a command on the VM and return its stdout (small outputs only). */
  private execOut(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.conn) return reject(new Error("session not connected"));
      this.conn.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let out = "";
        stream.on("data", (d: Buffer) => (out += d.toString()));
        stream.stderr.on("data", () => {});
        stream.on("close", () => resolve(out));
      });
    });
  }

  /** Public exec: stdout of a remote command (used by runs.ts for metadata). */
  exec(cmd: string): Promise<string> {
    return this.execOut(cmd);
  }

  /**
   * Run a remote command and expose its stdout as a stream (e.g. `tar -czf -`
   * piped straight into an R2 multipart upload - no temp files, any size).
   * `done` resolves with the exit code once the command finishes.
   */
  execStream(cmd: string): Promise<{ stdout: Readable; done: Promise<number> }> {
    return new Promise((resolve, reject) => {
      if (!this.conn) return reject(new Error("session not connected"));
      this.conn.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        stream.stderr.on("data", () => {});
        const done = new Promise<number>((res) => stream.on("close", (code: number) => res(code ?? 0)));
        resolve({ stdout: stream as unknown as Readable, done });
      });
    });
  }

  /**
   * Run a remote command feeding `input` to its stdin (e.g. an R2 download
   * piped straight into `tar -xzf -` on the VM). Resolves with the exit code.
   */
  execWithInput(cmd: string, input: Readable): Promise<number> {
    return new Promise((resolve, reject) => {
      if (!this.conn) return reject(new Error("session not connected"));
      this.conn.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let errOut = "";
        stream.on("data", () => {});
        stream.stderr.on("data", (d: Buffer) => (errOut += d.toString()));
        input.on("error", () => stream.close());
        input.pipe(stream.stdin);
        stream.on("close", (code: number) => {
          if ((code ?? 0) !== 0) this.log(`remote command stderr: ${errOut.slice(-400)}`);
          resolve(code ?? 0);
        });
      });
    });
  }

  /**
   * True while the never-stop supervisor is alive on the VM (its pid file is
   * written by scaffolding/agent-loop.sh and removed on exit/stop).
   */
  private async agentWorking(): Promise<boolean> {
    const out = await this.execOut(
      'if [ -f "$HOME/.tabs/agent-loop.pid" ] && kill -0 "$(cat "$HOME/.tabs/agent-loop.pid")" 2>/dev/null; then echo WORKING; fi'
    ).catch(() => "");
    return out.includes("WORKING");
  }

  async writeFile(path: string, content: string): Promise<void> {
    // HARD RULE: no manual edits while the agent is working - a human write
    // racing the agent's own edits would corrupt the run. The human must
    // /stop-recursive-loop in the agent tab first (which also opens a chat),
    // then /start-recursive-loop when done.
    if (await this.agentWorking()) {
      throw new Error(
        "The agent is working - manual edits are locked. " +
          "Type /stop-recursive-loop in the agent tab first, then /start-recursive-loop when you're done."
      );
    }
    const sftp = await this.sftp();
    return new Promise((resolve, reject) => {
      sftp.writeFile(path, Buffer.from(content, "utf8"), (err) => (err ? reject(err) : resolve()));
    });
  }

  /**
   * Stream the agent's thinking log (~/.tabs/agent-loop.log) line by line - the
   * full turn-by-turn history the never-stop loop writes. Follows the file so
   * new turns arrive live. Returns a disposer.
   */
  streamThinking(onLine: (line: string) => void): { close: () => void } {
    if (!this.conn) throw new Error("session not connected");
    let ch: ClientChannel | undefined;
    let buf = "";
    this.conn.exec(
      'mkdir -p "$HOME/.tabs"; touch "$HOME/.tabs/agent-thinking.jsonl"; tail -n 4000 -F "$HOME/.tabs/agent-thinking.jsonl" 2>/dev/null',
      (err, stream) => {
        if (err) return;
        ch = stream;
        const feed = (d: Buffer) => {
          buf += d.toString();
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            onLine(buf.slice(0, i));
            buf = buf.slice(i + 1);
          }
        };
        stream.on("data", feed);
        stream.stderr.on("data", () => {});
      }
    );
    return { close: () => ch?.end() };
  }

  /** Send a line to the agent's tmux repl (e.g. a /command from the sidebar). */
  sendToRepl(text: string): Promise<void> {
    const t = agentTmux(this.profile.agent);
    const esc = text.replace(/'/g, "'\\''");
    // Ensure the repl session exists, then type the line + Enter.
    const cd = `cd ${this.profile.remotePath.replace(/"/g, "")} 2>/dev/null; `;
    const ensure =
      `tmux has-session -t ${t} 2>/dev/null || ` +
      `tmux new-session -d -s ${t} '${cd}source $HOME/.tabs-agent.env 2>/dev/null; ${agentStartCommand(this.profile.agent)}; exec $SHELL' 9>&-; `;
    return this.execOut(`${ensure}tmux send-keys -t ${t} '${esc}' Enter`).then(() => {});
  }

  disconnect() {
    this.conn?.end();
    this.conn = null;
    this.setStatus("disconnected", "Disconnected");
  }
}
