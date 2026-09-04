---
name: lean-search
description: Search Mathlib 4 (Lean's math library) in plain English. Run `lean-search "<description>"` to find the theorems, definitions, and lemmas that match what you describe, by meaning rather than exact Lean names. Use it constantly while writing Lean, to find the lemma you need, to check what already exists before proving it yourself, and to get exact declaration names and signatures.
---

# lean-search

When you're writing Lean and need "the lemma that says X", don't guess names or
reprove known results. Describe X in plain English and get the matching Mathlib
declarations with their exact names and signatures.

## Search

```bash
lean-search "the order of a group element divides the order of the group"
lean-search "continuity of the composition of continuous functions" --k 15
lean-search "a finite-dimensional vector space has a basis" --kind theorem
```

- Returns ranked matches: `name` (the exact Lean identifier), `kind`, the type
  `signature`, and a short informal description. Use the `name` directly in
  your proof (`exact`, `apply`, `rw`, `simp [name]`).
- `--k <n>` results (default 10, max 50). `--kind theorem|definition|instance|class|...`
  filters by declaration kind. `--raw` prints JSON.

## When to use it

- Before proving anything nontrivial, to check whether Mathlib already has it.
- When a tactic wants a lemma you can't name.
- To find the right definition or instance for a type you're working with.

## Notes

- It searches Mathlib, not your own code. Make sure your file imports the
  relevant module (usually `import Mathlib`).
- It's semantic search: describe the mathematical content, not Lean syntax. If
  the first query misses, rephrase with standard terminology.
