---
name: text-operator
description: Send the operator (the human owner) a text message via iMessage/SMS, then halt. Use only in three cases - (1) you are 100% stuck and cannot proceed (e.g. The VM itself is broken), (2) the only thing between you and solving the problem is a very large GPU cluster beyond the skill providers, or (3) you have solved and verified the problem. Sending a text stops the agent loop until the operator returns. Requires SENDBLUE_API_KEY, SENDBLUE_API_SECRET, SENDBLUE_FROM_NUMBER and OPERATOR_PHONE_NUMBER (the provisioner sets them).
---

# text-operator (this stops you)

This sends a real text message to a real person's phone and then halts the
agent loop until they come back and restart it. It is the one deliberate "hand
back to the human" action, not a log channel, status feed, or progress update.
Use it only in these three cases:

1. You are 100% stuck. Something outside your control is broken (the VM
   itself, all providers down, a corrupted toolchain you cannot repair) and you
   have exhausted every recovery path, including `wait.sh` and retries.
2. You need a very large GPU cluster. The path to the solution is clear but
   requires compute beyond what `gpu-burst`/`cpu-burst` can provide (many
   nodes, not one H100). Say exactly what you need and why.
3. You have solved it. The problem is solved, verified against
   `check_answer/`, and recorded in `verified_math/`. Tell the operator the
   result.

If you're merely blocked on a rate limit, a failing search, or a hard lemma,
that is normal research, not a texting event. Keep working.

## Send a text (and stop)

Always pass `--case` so the operator gets the right header. Use a real
multi-line string (actual line breaks), not literal `\n`:

```bash
text-operator --case solved "$(cat <<'MSG'
Order-668 Hadamard matrix found and verified.

Witness CSV: verified_math/hadamard_668_construction/hadamard_668.csv
Checker: Rust + independent Python cross-check both PASS.
MSG
)"
```

Short cases can stay on one line:

```bash
text-operator --case stuck "Lean toolchain is corrupted and I can't repair it (elan reinstall + lake clean/rebuild both fail). Please reset the VM."
text-operator --case gpu   "Final search needs ~64 H100s (beyond gpu-burst), ~6h. That run completes the construction."
```

`--case solved | stuck | gpu` sets the header. The tool also prefixes every
message with this VM's instance tag (`[tabs <6-hex-id>]`) so the operator knows
which machine is talking; never remove or fake that tag. After it sends, the
loop stops. All three cases need the operator before anything useful can
happen.

## Writing the message

- Keep it short and self-contained (600 characters or so): a couple of tight
  lines, not a wall of detail. The full story lives in `handoff.md` and
  `verified_math/`; the text is just the headline.
- Use real line breaks for structure. (If you do pass literal `\n`, the tool
  converts it and collapses extra blank lines, but prefer real breaks.)
- Case `solved`: the verified result in one line plus the witness path in
  `verified_math/`.
- Case `stuck`: what broke, what you tried, what you need from them.
- Case `gpu`: the exact compute ask (GPU type, count, estimated hours) and the
  one-line reason it unblocks the solution.

Before texting, make sure `handoff.md` and `notebook.md` are current (you're
about to stop). Log that you texted, and why, in `notebook.md` first.
