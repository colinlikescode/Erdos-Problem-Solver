import { createHash, randomBytes } from "node:crypto";
import type { Problem, SavedRunManifest } from "../shared/types";
import type { Session } from "./session/children/session";
import {
  presignPut,
  presignGet,
  presignPart,
  multipartBegin,
  multipartFinish,
  multipartAbort,
  putJson,
  getJson,
  listKeys,
} from "./r2";

/**
 * Run saves: the CHASSIS/CARGO split. A snapshot is two disjoint file sets  - 
 *
 *   CHASSIS (owned by the base snapshot, never saved, never restored):
 *     AGENTS.md, dependencies.md, .agents/ - the doctrine + skills we keep
 *     improving. A continued run always gets the current chassis.
 *   CARGO (owned by the run - everything the agent produced):
 *     problem.md, notebook.md, handoff.md, verified_math/, check_answer/,
 *     workspace/ - saved in full (including build caches: they make continues
 *     fast and R2 storage is not a constraint).
 *
 * Save   = tar the cargo on the VM, stream it into R2 (multipart, no temp
 *          files, no size limit) + write a manifest.
 * Continue = provision a fresh VM with the current base snapshot, then stream
 *          the saved cargo out of R2 into `tar -x` on the VM. Chassis files
 *          are excluded from extraction as a second line of defense. The two
 *          sets are disjoint, so there is nothing to merge - and therefore
 *          nothing that can conflict.
 */
export const CARGO_PATHS = [
  "problem.md",
  "notebook.md",
  "handoff.md",
  "verified_math",
  "check_answer",
  "workspace",
] as const;

export const CHASSIS_PATHS = ["AGENTS.md", "dependencies.md", ".agents"] as const;

/** Bump when the snapshot's on-disk format changes incompatibly (e.g. the
 *  verified_math two-tier redesign). Saves record it; continues warn on skew. */
export const SNAPSHOT_FORMAT_VERSION = 2;

const runKey = (problemId: string, runId: string, file: string) =>
  `runs/${problemId}/${runId}/${file}`;

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The remote command that emits the cargo tarball on stdout (only paths that
 *  exist - a young run may not have every folder yet). */
export function cargoTarCommand(snapshotDir = "$HOME/snapshot"): string {
  const list = CARGO_PATHS.map((p) => `[ -e '${p}' ] && printf '%s\\n' '${p}'`).join("; ");
  return `cd "${snapshotDir}" && { ${list}; true; } | tar -czf - -T -`;
}

/** The remote command that receives a cargo tarball on stdin and overlays it.
 *  Chassis paths are excluded again on the VM side (the archive never contains
 *  them, but a hostile/old archive must still be unable to touch doctrine). */
export function cargoUntarCommand(snapshotDir = "$HOME/snapshot"): string {
  const excludes = CHASSIS_PATHS.map((p) => `--exclude='${p}' --exclude='./${p}'`).join(" ");
  return `mkdir -p "${snapshotDir}" && tar -xzf - -C "${snapshotDir}" ${excludes} && : > "$HOME/.tabs/continue-codebase" && : > "$HOME/.tabs/restore-done"`;
}

const PART_SIZE = 256 * 1024 * 1024; // VM-side multipart part size (big saves)
const SINGLE_PUT_MAX = 4 * 1024 * 1024 * 1024; // stay under R2's 5 GiB PUT cap

/**
 * Save a run's cargo to R2. The BYTES GO VM -> R2 DIRECTLY (same region, both
 * NYC-side) via presigned URLs - the laptop only presigns and writes the
 * manifest, so a slow laptop link never bottlenecks a save. Returns the manifest.
 */
export async function saveRun(
  session: Session,
  env: Record<string, string>,
  problem: Problem,
  note = "",
  onProgress?: (msg: string) => void
): Promise<SavedRunManifest> {
  // HARD RULE: never archive a moving target. Saving while the agent loop is
  // writing would tar files mid-edit - the human must /stop-recursive-loop
  // first (same predicate as the app's edit lock).
  const working = await session.exec(
    'if [ -f "$HOME/.tabs/agent-loop.pid" ] && kill -0 "$(cat "$HOME/.tabs/agent-loop.pid")" 2>/dev/null; then echo WORKING; fi'
  );
  if (working.includes("WORKING")) {
    throw new Error(
      "The agent is working - stop it first: type /stop-recursive-loop in the agent tab, then save."
    );
  }

  // A save must never land on an existing R2 folder (that would clobber another
  // run in the lineage). runId = timestamp + 8 random hex; then we HARD-CHECK
  // R2 and regenerate on the astronomically-unlikely collision.
  const newRunId = () =>
    `${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}-${randomBytes(4).toString("hex")}`;
  let runId = newRunId();
  for (let i = 0; i < 5; i++) {
    const existing = await listKeys(env, `runs/${problem.id}/${runId}/`);
    if (existing.length === 0) break;
    if (i === 4) throw new Error("could not allocate a unique run folder in R2");
    runId = newRunId();
  }
  const key = runKey(problem.id, runId, "state.tar.gz");

  // Facts + stamp + the run's problem.md hash, straight from the VM.
  const meta = await session.exec(
    `cd "$HOME/snapshot" 2>/dev/null || exit 1; ` +
      `echo "STAMP=$(cat "$HOME/.tabs/provision-stamp" 2>/dev/null)"; ` +
      `echo "FACTS=$(ls verified_math 2>/dev/null | grep -cE '^[FV]-?[0-9]' | tr -d ' ')"; ` +
      `echo "PSHA=$(sha256sum problem.md 2>/dev/null | cut -d' ' -f1)"; ` +
      `echo "PARENT=$(cat "$HOME/.tabs/parent-run" 2>/dev/null)"`
  );
  const grab = (k: string) => (meta.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim() || "";

  // 1. Build the archive ON the VM (750 GB disk; gives an exact size so parts
  //    are resumable and Content-Length is known).
  onProgress?.("archiving cargo on the VM…");
  const ARC = "/tmp/sf-run-save.tar.gz";
  const sizeOut = await session.exec(
    `rm -f ${ARC} && { ${cargoTarCommand()}; } > ${ARC} && stat -c %s ${ARC}`
  );
  const size = Number(sizeOut.trim().split("\n").pop());
  if (!Number.isFinite(size) || size <= 0) throw new Error(`cargo archive failed on the VM (${sizeOut.slice(-200)})`);
  onProgress?.(`cargo archived: ${(size / 1024 / 1024).toFixed(0)} MB - uploading VM → R2 directly…`);

  // 2. VM PUTs straight to R2 through presigned URLs (curl, retried).
  const curlPut = (url: string, extra: string) =>
    `curl -fsS --retry 5 --retry-all-errors --max-time 3600 -X PUT ${extra} "${url.replace(/"/g, '\\"')}"`;
  if (size <= SINGLE_PUT_MAX) {
    const url = await presignPut(env, key);
    const r = await session.exec(`${curlPut(url, `--upload-file ${ARC}`)} -o /dev/null -w OK || echo FAILED`);
    if (!r.includes("OK") || r.includes("FAILED")) throw new Error(`VM→R2 upload failed: ${r.slice(-300)}`);
  } else {
    const uploadId = await multipartBegin(env, key);
    try {
      const parts: { PartNumber: number; ETag: string }[] = [];
      const total = Math.ceil(size / PART_SIZE);
      for (let n = 1; n <= total; n++) {
        const skip = (n - 1) * (PART_SIZE / (1024 * 1024));
        const url = await presignPart(env, key, uploadId, n);
        const out = await session.exec(
          `dd if=${ARC} bs=1M skip=${skip} count=${PART_SIZE / (1024 * 1024)} 2>/dev/null | ` +
            `${curlPut(url, "--data-binary @- -D -")} -o /dev/null | grep -i '^etag:' | tr -d '\\r' | cut -d' ' -f2`
        );
        const etag = out.trim().split("\n").pop() || "";
        if (!etag) throw new Error(`part ${n}/${total} upload failed`);
        parts.push({ PartNumber: n, ETag: etag });
        onProgress?.(`uploaded part ${n}/${total}…`);
      }
      await multipartFinish(env, key, uploadId, parts);
    } catch (e) {
      await multipartAbort(env, key, uploadId);
      throw e;
    }
  }
  await session.exec(`rm -f ${ARC}`);

  const manifest: SavedRunManifest = {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    problemId: problem.id,
    problemName: problem.name,
    runId,
    savedAt: Date.now(),
    ...(grab("PARENT") ? { parentRunId: grab("PARENT") } : {}),
    problemMdSha256: grab("PSHA"),
    baseStamp: grab("STAMP"),
    host: session.profile.host,
    bytes: size,
    factCount: Number(grab("FACTS")) || 0,
    note,
  };
  await putJson(env, runKey(problem.id, runId, "manifest.json"), manifest);
  onProgress?.(`run saved (${manifest.factCount} verified facts) - runs/${problem.id}/${runId}`);
  return manifest;
}

/**
 * Overlay a saved run's cargo onto a freshly-provisioned snapshot. Alerts (as
 * log lines the UI surfaces) on the two real drift cases: the problem text
 * changed in the store, or the save predates the current snapshot format.
 */
export async function restoreRun(
  session: Session,
  env: Record<string, string>,
  problem: Problem,
  runId: string,
  log: (msg: string) => void
): Promise<void> {
  const manifest = await getJson<SavedRunManifest>(env, runKey(problem.id, runId, "manifest.json"));
  if (manifest.problemId !== problem.id) {
    throw new Error(`saved run belongs to problem ${manifest.problemId}, not ${problem.id} - refusing to continue`);
  }
  if (manifest.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
    log(
      `⚠ ALERT: this save uses snapshot format v${manifest.formatVersion} (current v${SNAPSHOT_FORMAT_VERSION}) - ` +
        `the agent may need to migrate layouts; check verified_math/ after the first turn`
    );
  }
  if (manifest.problemMdSha256 && sha256(problem.description) !== manifest.problemMdSha256) {
    log(
      "⚠ ALERT: the problem text in the store differs from the one this run was saved with - " +
        "continuing with the RUN's problem.md (the text the agent actually worked against)"
    );
  }

  log(`restoring saved run ${runId} (${manifest.factCount ?? "?"} verified facts) from R2…`);
  // The VM pulls the archive STRAIGHT from R2 (presigned GET; both NYC-side)  - 
  // the laptop only presigns, so its link speed never matters.
  const url = await presignGet(env, runKey(problem.id, runId, "state.tar.gz"));
  const out = await session.exec(
    `curl -fsS --retry 5 --retry-all-errors --max-time 3600 "${url.replace(/"/g, '\\"')}" | { ${cargoUntarCommand()}; } && echo RESTORE_OK || echo RESTORE_FAILED`
  );
  if (!out.includes("RESTORE_OK")) throw new Error(`cargo restore failed on the VM: ${out.slice(-300)}`);
  // Lineage: the VM remembers which save it grew from; the next save records
  // it as parentRunId, so every problem's saves form a browsable tree.
  await session.exec(`printf %s '${runId}' > "$HOME/.tabs/parent-run"`);
  log("cargo restored - current chassis + saved run state; continue-codebase marker set");
}

/** All saved runs, newest first (optionally for one problem). */
export async function listSavedRuns(
  env: Record<string, string>,
  problemId?: string
): Promise<SavedRunManifest[]> {
  const prefix = problemId ? `runs/${problemId}/` : "runs/";
  const keys = (await listKeys(env, prefix)).filter((k) => k.endsWith("/manifest.json"));
  const manifests = await Promise.all(
    keys.map((k) => getJson<SavedRunManifest>(env, k).catch(() => null))
  );
  return manifests
    .filter((m): m is SavedRunManifest => m !== null)
    .sort((a, b) => b.savedAt - a.savedAt);
}
