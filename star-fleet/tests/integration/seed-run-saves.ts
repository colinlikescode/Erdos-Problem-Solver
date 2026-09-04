// Seed R2 with run-saves built from the two archived research programs in
// old/ (hadamard_668_starfleet, navier_stokes_starfleet) - the real test of
// the save/continue pipeline. Idempotent-ish: re-running adds new runIds.
//
//   cd star-fleet && bun tests/integration/seed-run-saves.ts
//
// 1. Registers the two problems in the app's problem store (userData
//    problems.json) with description = the run's exact problem.md, keyed by
//    stable UUIDs so re-runs don't duplicate.
// 2. Tars each repo's CARGO paths (chassis excluded by construction).
// 3. Streams the tarballs to R2 + writes manifests, exactly like a live save.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseDotEnv } from "../../src/electron/agentEnv";
import { uploadStream, putJson } from "../../src/electron/r2";
import { CARGO_PATHS, SNAPSHOT_FORMAT_VERSION, sha256 } from "../../src/electron/runs";
import type { SavedRunManifest, Problem } from "../../src/shared/types";

const REPO = join(process.cwd(), "..");
const env = parseDotEnv(readFileSync(join(REPO, ".env"), "utf8"));

// Stable ids so re-seeding never duplicates the problems.
const SEEDS = [
  {
    problemId: "b7e3f7a0-1111-4a61-9c9e-hadamard0668".replace("hadamard0668", "0d41aa8668ff"),
    name: "Hadamard 668",
    dir: join(REPO, "old", "hadamard_668_starfleet"),
  },
  {
    problemId: "c9d4e8b1-2222-4b72-8d8f-0e52bb97a3ns".replace("0e52bb97a3ns", "1e52bb97a301"),
    name: "Navier–Stokes finite-time blow-up",
    dir: join(REPO, "old", "navier_stokes_starfleet"),
  },
];

// 1. Problem store (same file ProblemStore uses).
const problemsFile = join(homedir(), "Library", "Application Support", "Star Fleet", "problems.json");
const problems: Problem[] = existsSync(problemsFile)
  ? JSON.parse(readFileSync(problemsFile, "utf8"))
  : [];

for (const seed of SEEDS) {
  const description = readFileSync(join(seed.dir, "problem.md"), "utf8");
  const existing = problems.find((p) => p.id === seed.problemId || p.name === seed.name);
  if (existing) {
    existing.id = seed.problemId;
    existing.name = seed.name;
    existing.description = description;
  } else {
    problems.push({ id: seed.problemId, name: seed.name, description, createdAt: Date.now() });
  }
}
writeFileSync(problemsFile, JSON.stringify(problems, null, 2));
console.log(`[seed] problem store updated (${problems.length} problems) - ${problemsFile}`);

// 2+3. Tar cargo -> stream to R2 -> manifest.
for (const seed of SEEDS) {
  const description = readFileSync(join(seed.dir, "problem.md"), "utf8");
  const present = CARGO_PATHS.filter((p) => existsSync(join(seed.dir, p)));
  const runId = `${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}-seed`;
  const key = `runs/${seed.problemId}/${runId}/state.tar.gz`;

  console.log(`[seed] ${seed.name}: tar+upload ${present.join(", ")} → ${key}`);
  const tar = spawn("tar", ["-czf", "-", "-C", seed.dir, ...present]);
  let stderr = "";
  tar.stderr.on("data", (d) => (stderr += d.toString()));
  // Attach the exit listener before awaiting the upload - tar exits the moment
  // its stdout is drained, which is before the multipart completes.
  const tarDone = new Promise<number>((r) => tar.on("close", r));
  await uploadStream(env, key, tar.stdout, (b) =>
    process.stdout.write(`\r[seed]   uploaded ${(b / 1024 / 1024).toFixed(1)} MB`)
  );
  process.stdout.write("\n");
  const code = await tarDone;
  if (code !== 0) throw new Error(`tar failed (${code}): ${stderr}`);

  const factCount = Number(
    execFileSync("bash", ["-c", `ls -d '${join(seed.dir, "verified_math")}'/*/ 2>/dev/null | wc -l`])
      .toString()
      .trim()
  );
  const manifest: SavedRunManifest = {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    problemId: seed.problemId,
    problemName: seed.name,
    runId,
    savedAt: Date.now(),
    problemMdSha256: sha256(description),
    factCount,
    note: "imported from old/ (pre-app archive)",
  };
  await putJson(env, `runs/${seed.problemId}/${runId}/manifest.json`, manifest);
  console.log(`[seed]   manifest written - ${factCount} verified facts`);
}
console.log("[seed] DONE");
