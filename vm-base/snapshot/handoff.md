# handoff.md - technical handoff (survives context compaction)

This is the memory that survives when the context window fills up. The
supervisor makes you rewrite this file at ~90% context, then compacts the
session, and a fresh agent resumes from this document. Keep it complete,
precise, and current.

A fresh agent with zero memory of the prior session must be able to read this
file (plus `verified_math/verified_math.md` and `notebook.md`) and continue
without a gap. Write for that reader. Update the sections below in place.

## 1. Goal

_(One paragraph: the target, copied from the essence of `problem.md`, and the
precise definition of "solved".)_

## 2. Current status

_(Where things stand right now, in 3-8 bullets. What works, what's in flight.)_

## 3. Done and verified

_(What has been established. Cite the `verified_math/` subfolders and
`verified_math.md` entries by title. Positive results and verified negative
results / ruled-out approaches.)_

## 4. Current approach (and why)

_(The strategy you're pursuing now and the reasoning. What you expect to work.)_

## 5. Ruled out / dead ends

_(Approaches proven not to work and why, so the next agent doesn't repeat them.
Formal impossibility results belong in `verified_math/`; summarize the
reasoning here.)_

## 6. Next steps

_(The exact ordered next actions. Be concrete: which lemma, which search, which
file to edit.)_

## 7. Codebase map

_(Where everything lives: check_answer/, verified_math/, workspace/ (rust/,
cuda/, lean/, ...), key files and what each does. How the pieces fit.)_

## 8. Build / run / verify

_(Exact commands to build and run each component and to run the answer checker
or Lean proofs. Environment notes, gotchas.)_

## 9. Open questions

_(Unresolved sub-questions and hypotheses to test next.)_
