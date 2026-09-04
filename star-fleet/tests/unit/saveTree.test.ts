import { test, expect, describe } from "bun:test";
import { buildSaveTree, flattenSaveTree } from "../../src/shared/saveTree";
import type { SavedRunManifest } from "../../src/shared/types";

const m = (runId: string, savedAt: number, parentRunId?: string): SavedRunManifest => ({
  formatVersion: 2,
  problemId: "p1",
  problemName: "P",
  runId,
  savedAt,
  parentRunId,
  problemMdSha256: "x",
});

describe("saveTree - the continuation branching diagram", () => {
  test("builds a tree: roots, branches, chronological siblings", () => {
    // seed -> A -> (B, C);  C -> D.   (A branched twice: B and C are siblings.)
    const roots = buildSaveTree([
      m("D", 50, "C"),
      m("seed", 10),
      m("B", 30, "A"),
      m("A", 20, "seed"),
      m("C", 40, "A"),
    ]);
    expect(roots.length).toBe(1);
    expect(roots[0].manifest.runId).toBe("seed");
    const a = roots[0].children[0];
    expect(a.manifest.runId).toBe("A");
    expect(a.children.map((c) => c.manifest.runId)).toEqual(["B", "C"]); // chronological
    expect(a.children[1].children[0].manifest.runId).toBe("D");
    expect(a.children[1].children[0].depth).toBe(3);
  });

  test("flatten renders each node under its parent with last-sibling markers", () => {
    const rows = flattenSaveTree(
      buildSaveTree([m("seed", 1), m("A", 2, "seed"), m("B", 3, "A"), m("C", 4, "A")])
    );
    expect(rows.map((r) => r.node.manifest.runId)).toEqual(["seed", "A", "B", "C"]);
    // B is not the last child of A; C is.
    expect(rows[2].isLast.at(-1)).toBe(false);
    expect(rows[3].isLast.at(-1)).toBe(true);
  });

  test("an orphan (parent save deleted) becomes a root instead of vanishing", () => {
    const roots = buildSaveTree([m("seed", 1), m("orphan", 2, "GONE")]);
    expect(roots.map((r) => r.manifest.runId).sort()).toEqual(["orphan", "seed"]);
  });

  test("multiple independent roots (fresh runs saved separately) both show", () => {
    const roots = buildSaveTree([m("r1", 1), m("r2", 2), m("kid", 3, "r2")]);
    expect(roots.length).toBe(2);
    expect(roots[1].children[0].manifest.runId).toBe("kid");
  });

  test("every node keeps its OWN runId - the tree never merges/overwrites folders", () => {
    const input = [m("seed", 1), m("a", 2, "seed"), m("b", 3, "seed"), m("c", 4, "a")];
    const rows = flattenSaveTree(buildSaveTree(input));
    // one row per save, all runIds distinct (== distinct R2 folders)
    expect(rows.length).toBe(input.length);
    const ids = rows.map((r) => r.node.manifest.runId);
    expect(new Set(ids).size).toBe(ids.length);
    // a branch: seed has two children (a, b) - siblings, not overwrites
    const seed = buildSaveTree(input)[0];
    expect(seed.children.map((c) => c.manifest.runId)).toEqual(["a", "b"]);
  });
});
