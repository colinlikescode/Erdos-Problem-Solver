import { test, expect, describe } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CARGO_PATHS,
  CHASSIS_PATHS,
  cargoTarCommand,
  cargoUntarCommand,
  sha256,
  SNAPSHOT_FORMAT_VERSION,
} from "../../src/electron/runs";

/**
 * The chassis/cargo contract is the whole safety story of save/continue:
 * cargo (the run's work) round-trips; chassis (doctrine/skills) can never be
 * touched by a restore. These tests run the real tar commands locally.
 */
describe("runs - chassis/cargo split", () => {
  test("the two sets are disjoint and cover the snapshot contract", () => {
    for (const c of CARGO_PATHS) expect(CHASSIS_PATHS).not.toContain(c as never);
    expect(CARGO_PATHS).toContain("problem.md");
    expect(CARGO_PATHS).toContain("verified_math");
    expect(CARGO_PATHS).toContain("workspace");
    expect(CHASSIS_PATHS).toContain("AGENTS.md");
    expect(CHASSIS_PATHS).toContain(".agents");
    expect(SNAPSHOT_FORMAT_VERSION).toBeGreaterThanOrEqual(2);
  });

  test("save tars only existing cargo; restore overlays it and CANNOT touch the chassis", () => {
    const src = mkdtempSync(join(tmpdir(), "cargo-src-"));
    const dst = mkdtempSync(join(tmpdir(), "cargo-dst-"));
    // Source VM: a run mid-flight (note: no handoff.md yet - partial cargo is fine).
    writeFileSync(join(src, "problem.md"), "P");
    writeFileSync(join(src, "notebook.md"), "N");
    mkdirSync(join(src, "verified_math", "F-001_x"), { recursive: true });
    writeFileSync(join(src, "verified_math", "F-001_x", "entry.md"), "fact");
    // A hostile/old archive might carry chassis files - simulate one.
    writeFileSync(join(src, "AGENTS.md"), "OLD DOCTRINE - MUST NOT ESCAPE");

    // Destination VM: freshly provisioned chassis.
    writeFileSync(join(dst, "AGENTS.md"), "CURRENT DOCTRINE");
    mkdirSync(join(dst, ".tabs")); // stand-in for $HOME/.tabs markers

    // A hostile/old archive: real cargo PLUS a chassis file (AGENTS.md).
    const hostileTar = `tar -czf - -C '${src}' problem.md notebook.md verified_math AGENTS.md`;
    const untarCmd = cargoUntarCommand(dst).replaceAll("$HOME/.tabs", join(dst, ".tabs"));
    const r = spawnSync("bash", ["-c", `${hostileTar} | { ${untarCmd}; }`], { encoding: "utf8" });
    expect(r.status).toBe(0);

    // cargo restored
    expect(readFileSync(join(dst, "problem.md"), "utf8")).toBe("P");
    expect(readFileSync(join(dst, "verified_math", "F-001_x", "entry.md"), "utf8")).toBe("fact");
    // chassis untouched despite the archive carrying AGENTS.md
    expect(readFileSync(join(dst, "AGENTS.md"), "utf8")).toBe("CURRENT DOCTRINE");
    // continuation markers written for the supervisor + exactly-once restore
    expect(existsSync(join(dst, ".tabs", "continue-codebase"))).toBe(true);
    expect(existsSync(join(dst, ".tabs", "restore-done"))).toBe(true);
  });

  test("cargo tar command skips paths that don't exist yet (young runs)", () => {
    const src = mkdtempSync(join(tmpdir(), "cargo-young-"));
    writeFileSync(join(src, "problem.md"), "P"); // ONLY problem.md exists
    const listing = execFileSync("bash", ["-c", `${cargoTarCommand(src)} | tar -tzf -`], {
      encoding: "utf8",
    });
    expect(listing.trim()).toBe("problem.md");
  });

  test("sha256 matches the shell's sha256sum (problem drift detection)", () => {
    const text = "the problem statement ✓";
    const shell = execFileSync("bash", ["-c", "printf '%s' \"$0\" | shasum -a 256 | cut -d' ' -f1", text], {
      encoding: "utf8",
    }).trim();
    expect(sha256(text)).toBe(shell);
  });
});
