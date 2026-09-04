# notebook.md - research journal (whole project)

Your lab notebook for the whole effort, spanning every experiment. Unlike
[`verified_math/`](./verified_math) (verified truths only), this is where the
messy, in-progress thinking lives: the current plan, which approaches you've
tried across experiments, dead ends, and what to do next.

Each experiment also keeps its own `scratchpad.md` for that attempt's local
notes (see [`AGENTS.md`](./AGENTS.md) section 3). This file is the global view;
the per-experiment scratchpad is the detail.

Read this at the start of every turn so you don't re-tread dead ends. Append to
it before you pause or after any attempt.

## Current plan / working hypothesis

_(what you're trying right now, and why; which experiment is active)_

## Next concrete step

_(the single next action: a lemma to prove, a search to run, a check to build)_

## Attempt log

Newest first. Record every non-trivial approach and its outcome, especially
failures, so no future turn wastes time repeating them. Note the experiment.

```
### <date> - <approach> (experiment_<n>_<slug>)
- Goal:
- What I did:
- Outcome: works | partial | DEAD END
- Why / evidence:
- Follow-up:
```

_(no entries yet. The first should be building the answer checker in
`check_answer/`, per AGENTS.md section 4.)_

## Open questions

_(sub-questions you haven't resolved; promote to the plan when you tackle them)_
