import { app, BrowserWindow, ipcMain } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";
import { ProfileStore } from "./profiles";
import { ProblemStore } from "./problems";
import { SessionManager } from "./session/orchestrator";
import { pingHost, connect } from "./session/children/connection";
import { SettingsStore, type AppSettings } from "./settings";
import { parseDotEnv, resolveAgentEnv } from "./agentEnv";
import { spinupDroplet, destroyDroplet } from "./digitalocean";
import { saveRun, restoreRun, listSavedRuns } from "./runs";
import type { CreateRunInput } from "../shared/types";

const isDev = !app.isPackaged;
const DEV_URL = "http://localhost:3210";

// Desktop app name (macOS menu bar, About panel, dock tooltip).
app.setName("Star Fleet");

let win: BrowserWindow | null = null;
const profiles = new ProfileStore();
const problems = new ProblemStore();
const sessions = new SessionManager();
const settings = new SettingsStore();

const slugifyName = (s: string) =>
  "tabs-" + (s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "run");
/**
 * Env for the remote agent, resolved from the repo-root `.env` (dev
 * convenience; the user keeps their token pool there) and in-app settings,
 * which override it. The app lives in star-fleet/, so the root `.env` is
 * one level above the app path; both locations are tried.
 * The mapping/precedence logic lives in the pure, unit-tested `agentEnv` module.
 */
function readDotEnv(): Record<string, string> {
  for (const p of [
    path.join(app.getAppPath(), "..", ".env"),
    path.join(app.getAppPath(), ".env"),
  ]) {
    try {
      return parseDotEnv(fs.readFileSync(p, "utf8"));
    } catch {
      /* try next - no .env means settings only */
    }
  }
  return {};
}

function agentEnv(): Record<string, string> {
  return resolveAgentEnv(readDotEnv(), settings.get());
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "Star Fleet",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 14 },
    backgroundColor: "#09090b",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    win.loadURL(DEV_URL);
    win.webContents.on("did-fail-load", () => {
      setTimeout(() => win?.loadURL(DEV_URL), 500);
    });
  } else {
    win.loadFile(path.join(__dirname, "../out/index.html"));
  }

  win.on("closed", () => (win = null));
}

sessions.on("state", (profileId, status, message) => {
  win?.webContents.send("session:state", { profileId, status, message });
});
sessions.on("log", (profileId, line) => {
  win?.webContents.send("session:log", { profileId, line });
});

ipcMain.handle("profiles:list", () => profiles.list());

// Saved problems (populate the run dropdown + Add Problem dialog).
ipcMain.handle("problems:list", () => problems.list());
ipcMain.handle(
  "problems:add",
  (_e, name: string, description: string, category?: import("../shared/types").ProblemCategory, sourceUrl?: string) =>
    problems.add(name, description, category, sourceUrl)
);
ipcMain.handle("problems:remove", (_e, id: string) => problems.remove(id));

// One-click run: spin up a DigitalOcean droplet, then save it as a machine that
// auto-provisions + auto-starts the agent. Two ways to start (both are NEW runs):
//   new      -> fresh run on the chosen saved problem (base snapshot + problem.md)
//   continue -> same, then overlay a saved run's cargo from R2 before the agent
//              starts (current chassis + the run's accumulated state - no drift)
ipcMain.handle("runs:create", async (_e, input: CreateRunInput) => {
  const env = readDotEnv();
  const token = env.DIGITAL_OCEAN_API_KEY || "";
  const onProgress = (message: string) => win?.webContents.send("do:progress", { message });

  const prob = input.problemId ? problems.get(input.problemId) : undefined;
  if (!prob) throw new Error("Pick a problem - every run is tied to one.");
  if (input.source === "continue" && !input.savedRunId?.trim()) {
    throw new Error("Pick which saved run to continue.");
  }
  const name = slugifyName(prob.name);

  const vm = await spinupDroplet(token, { name, seedProblem: prob.description }, onProgress);
  onProgress("saving machine…");
  return profiles.add({
    name: vm.name,
    host: vm.host,
    port: 22,
    username: vm.username,
    password: vm.password,
    agent: "pi",
    seedProblem: prob.description,
    problemId: prob.id,
    restoreRunId: input.source === "continue" ? input.savedRunId : undefined,
    autoStart: true,
    dropletId: vm.dropletId,
  });
});

// Save a run's cargo (problem.md, verified_math/, notebook, handoff,
// check_answer/, workspace/) to R2 under its problem - the "Save run" button.
ipcMain.handle("runs:save", async (_e, profileId: string, note?: string) => {
  const profile = profiles.get(profileId);
  if (!profile) throw new Error("machine not found");
  if (!profile.problemId) throw new Error("this run has no linked problem - cannot save");
  const prob = problems.get(profile.problemId);
  if (!prob) throw new Error("the run's problem is no longer in the problem store");
  const log = (line: string) => win?.webContents.send("session:log", { profileId, line });
  return saveRun(sessions.session(profileId), readDotEnv(), prob, note || "", log);
});

// Saved runs (from R2 manifests) - powers the "Continue Problem" picker.
ipcMain.handle("runs:listSaved", (_e, problemId?: string) =>
  listSavedRuns(readDotEnv(), problemId)
);
ipcMain.handle("profiles:rename", (_e, id: string, name: string) => profiles.rename(id, name));
ipcMain.handle("profiles:setPath", (_e, id: string, remotePath: string) =>
  profiles.setRemotePath(id, remotePath)
);
// Remove a run. If Star Fleet spun up its droplet, DESTROY it on DigitalOcean
// too (the whole model is one droplet per run - leaving it running just burns
// money). Best-effort: the profile is removed even if the destroy call fails.
ipcMain.handle("profiles:remove", async (_e, id: string) => {
  const profile = profiles.get(id);
  sessions.disconnect(id);
  if (profile?.dropletId) {
    const token = readDotEnv().DIGITAL_OCEAN_API_KEY || "";
    await destroyDroplet(token, profile.dropletId).catch((e) =>
      win?.webContents.send("session:log", { profileId: id, line: `droplet destroy failed: ${e.message}` })
    );
  }
  profiles.remove(id);
});

ipcMain.handle("session:open", async (_e, profileId: string) => {
  const profile = profiles.get(profileId);
  if (!profile) throw new Error("machine not found");
  // Continue-runs get a restore hook: after provisioning (current chassis),
  // stream the saved cargo out of R2 onto the snapshot, exactly once.
  const restoreHook =
    profile.restoreRunId && profile.problemId
      ? async (session: import("./session/children/session").Session, log: (m: string) => void) => {
          const prob = problems.get(profile.problemId!);
          if (!prob) throw new Error("the run's problem is no longer in the problem store");
          await restoreRun(session, readDotEnv(), prob, profile.restoreRunId!, log);
        }
      : undefined;
  await sessions.open(
    profile,
    profiles.getCredential(profileId),
    agentEnv(),
    profiles.getSeedProblem(profileId),
    restoreHook
  );
});
ipcMain.handle("session:disconnect", (_e, profileId: string) => {
  sessions.disconnect(profileId);
});
ipcMain.handle("session:state", (_e, profileId: string) => sessions.getState(profileId));

// Cheap reachability probe for the dashboard's status dots - a TCP connect to
// the VM's SSH port, NO provisioning. If a live session is already tracked, its
// (richer) status wins; this just tells idle profiles apart from dead hosts.
ipcMain.handle("session:ping", async (_e, profileId: string) => {
  const profile = profiles.get(profileId);
  if (!profile) return false;
  return pingHost(profile.host, profile.port);
});


// Agent thinking history: stream the supervisor's turn-by-turn log to the
// renderer's Agent sidebar. Start/stop per open tab; sendToAgent types a
// /command into the tmux repl.
ipcMain.on("agent:think:start", (_e, profileId: string) => {
  sessions.startThinking(profileId, (line) =>
    win?.webContents.send("agent:think:line", { profileId, line })
  );
});
ipcMain.on("agent:think:stop", (_e, profileId: string) => sessions.stopThinking(profileId));
ipcMain.handle("agent:send", (_e, profileId: string, text: string) =>
  sessions.sendToAgent(profileId, text)
);

// FLEET KILLSWITCH: type `/stop-recursive-loop` into every machine's repl at
// once. Works whether or not a tab is open - a one-shot SSH exec of tmux
// send-keys per VM (the loop runs in the background, so the repl foreground
// receives it). Does not provision. Returns per-machine ok/failure.
ipcMain.handle("agent:killAll", async () => {
  const results = await Promise.all(
    profiles.list().map(async (p) => {
      try {
        const conn = await connect(p.host, p.port, p.username, profiles.getCredential(p.id));
        await new Promise<void>((resolve, reject) => {
          conn.exec(
            `tmux send-keys -t tabs-pi "/stop-recursive-loop" Enter`,
            (err, stream) => {
              if (err) return reject(err);
              stream.on("close", () => resolve());
              stream.on("data", () => {});
              stream.stderr.on("data", () => {});
            }
          );
        });
        conn.end();
        return { id: p.id, name: p.name, ok: true };
      } catch (e) {
        return { id: p.id, name: p.name, ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    })
  );
  return results;
});

ipcMain.handle("settings:get", () => settings.get());
ipcMain.handle("settings:update", (_e, patch: Partial<AppSettings>) => settings.update(patch));

// Live-session file operations (SFTP over the session's connection).
ipcMain.handle("files:list", (_e, profileId: string, dir: string) =>
  sessions.listDir(profileId, dir)
);
ipcMain.handle("files:read", (_e, profileId: string, file: string) =>
  sessions.readFile(profileId, file)
);
ipcMain.handle("files:write", (_e, profileId: string, file: string, content: string) =>
  sessions.writeFile(profileId, file, content)
);

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  sessions.disconnectAll();
});
