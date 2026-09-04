import type { SavedRunManifest } from "./types";

/**
 * Saves form a tree per problem: every "Continue" run remembers the save it
 * grew from (manifest.parentRunId), and each later "Save to R2" becomes a
 * child node. The UI renders this as the branching diagram the user picks a
 * continuation point from.
 */
export interface SaveNode {
  manifest: SavedRunManifest;
  children: SaveNode[];
  /** Depth from its root (0 = an imported/first save). */
  depth: number;
}

/** Build the forest for one problem's saves: roots first, children sorted
 *  oldest->newest (so a branch reads top-down chronologically). Orphans (parent
 *  save deleted) are treated as roots rather than dropped. */
export function buildSaveTree(manifests: SavedRunManifest[]): SaveNode[] {
  const byId = new Map<string, SaveNode>();
  for (const m of manifests) byId.set(m.runId, { manifest: m, children: [], depth: 0 });

  const roots: SaveNode[] = [];
  for (const node of byId.values()) {
    const parent = node.manifest.parentRunId ? byId.get(node.manifest.parentRunId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const sortRec = (nodes: SaveNode[], depth: number) => {
    nodes.sort((a, b) => a.manifest.savedAt - b.manifest.savedAt);
    for (const n of nodes) {
      n.depth = depth;
      sortRec(n.children, depth + 1);
    }
  };
  sortRec(roots, 0);
  return roots;
}

/** Flatten the forest to render order (each node right under its parent,
 *  siblings chronological), tagging each row with whether it's the last
 *  sibling - what the UI needs to draw the connector lines. */
export function flattenSaveTree(roots: SaveNode[]): { node: SaveNode; isLast: boolean[] }[] {
  const out: { node: SaveNode; isLast: boolean[] }[] = [];
  const walk = (nodes: SaveNode[], trail: boolean[]) => {
    nodes.forEach((n, i) => {
      const isLast = [...trail, i === nodes.length - 1];
      out.push({ node: n, isLast });
      walk(n.children, isLast);
    });
  };
  walk(roots, []);
  return out;
}
