# verified_math.md - the ledger of verified mathematics

This folder is the heart and soul of the whole operation. Every formally
established result, positive and negative, lives here. Progress on the problem
is the growth of this folder: each verified lemma or theorem is one confirmed
step toward a true solution. Everything else (searches, heuristics, notes)
exists to produce entries here.

## Two tiers, strict

This file is only a list of one-liners. One line per verified fact, nothing
more. Full statements never live in this file; they live in each fact's own
folder. That keeps this file cheap to read in full (you will re-read it after
every context reset) however many facts accumulate.

```
verified_math/
├── verified_math.md            this file: one line per fact (the index)
└── F-001_<short-slug>/         one folder per verified fact
    ├── entry.md                the full story: frontmatter, complete
    │                           statement, proof sketch, how to re-verify
    └── <proof artifacts>       the Lean file(s) / witness data / checker run
```

To learn more about any fact, open its folder's `entry.md`. The proof code is
right next to it.

## Admission rule

Nothing enters this folder unless it has been machine-verified, either:

- proved in Lean and accepted by `lake build`, with no `sorry`/`admit`
  (lemmas, theorems, impossibility results), or
- accepted by the answer checker in [`check_answer/`](../check_answer)
  (constructions, computations, exhaustive non-existence).

No conjectures. No "probably". No unchecked claims. Informal or heuristic dead
ends go in [`notebook.md`](../notebook.md), not here. Once you can prove
something doesn't exist or can't work, it becomes a negative entry here. Expect
the early phase to fill this folder with negative results (AGENTS.md section
1a); a large verified negative space narrows the hunt.

## Adding a fact

```bash
new-fact <short-slug> [--tier lean|gate|census] [--negative] \
         [--depends F-001,F-002] [--supersedes F-011]
```

It mints the next zero-padded id, creates `F-<nnn>_<slug>/entry.md` with the
frontmatter template, and appends the one-liner below. Then you fill in the
entry body and copy the proof artifacts into the folder.

`entry.md` starts with structured frontmatter. Keep every field accurate; it is
what makes the fact findable later:

```markdown
---
id: F-003
title: <short human title>
tier: lean            # lean (kernel proof) | gate (named verifier binary) | census (exhaustive computation)
polarity: positive    # positive | negative
depends_on: [F-002]   # facts this proof builds on; `rg "depends_on:.*F-002"` gives the reverse graph
supersedes: []        # set when this fact corrects an earlier one
verifier: <the exact command that re-verifies this fact>
date: 2026-07-04
---

## Statement
<plain language and the formal statement>

## Proof / verification
<proof sketch; what the verifier checks; artifact list>
```

Rules:

- Never edit or delete an existing fact. If a fact turns out wrong, mint a new
  fact with `supersedes: [F-<nnn>]` explaining what broke, and mark the old
  ledger line `(superseded by F-<mmm>)`. Anything you already read must stay
  true.
- Keep `depends_on` honest. It is how a fresh session pulls only the subgraph
  it needs instead of re-reading everything.

The ledger line format (`new-fact` writes it for you):

```
- **F-<nnn>** [lean|gate|census] <title>: <one-sentence statement> → F-<nnn>_<slug>/
```

## The facts (one line each; full detail in each folder)

_(none yet. The first entry should be the pinned-down formal statement or
answer checker once built and cross-checked, per AGENTS.md section 4, followed
by the initial negative-space results from section 1a.)_
