# .agents/skills/

This is the folder Pi auto-discovers project skills from (the cross-tool
"Agent Skills" path). Each skill is just its `SKILL.md`, the agent-facing doc.
The implementation lives in the scaffolding layer (`vm-base/scaffolding/tools/`
and `vm-base/scaffolding/brokers/`) and is exposed to the agent as a command on
PATH. The snapshot only holds what the agent reads; the machinery it runs stays
outside its world.

## Layout

```
.agents/skills/
├── README.md                  conventions (this file)
├── gpu-burst/SKILL.md         up to 10 H100s        -> gpu-burst request N
├── cpu-burst/SKILL.md         up to 400 vCPUs       -> cpu-burst request N
├── web-search/SKILL.md        web search + digest   -> web-search "..."
├── research-search/SKILL.md   papers + GitHub       -> research-search ...
├── lean-search/SKILL.md       Mathlib NL search     -> lean-search "..."
└── text-operator/SKILL.md     text the human owner  -> text-operator "..."
```

Every skill is "SKILL.md plus a PATH command". There are no `scripts/` or
`assets/` folders in the snapshot; those live in `scaffolding/tools/` (and
`scaffolding/brokers/` for the burst brokers), and the provisioner installs a
PATH wrapper for each command.

## Skills vs tools

A skill is what the agent learns to interact with (the `SKILL.md`). A tool is
the machinery behind it (the script or broker in scaffolding). The SKILL.md
teaches only the interface: command name, arguments, when to use it. Which
compute provider the broker picks, how a search is scraped and digested, and
so on never belong in a SKILL.md.

## Conventions

- One folder per skill, kebab-case. Folder name == frontmatter `name` == the
  PATH command the agent runs.
- `SKILL.md` is the whole skill: frontmatter `name` and `description` (Pi
  refuses skills without a description), then a short how-to. Keep it readable
  in one pass. Reference the PATH command, never a path into the snapshot.
- Implementations go in `scaffolding/tools/<script>` or `scaffolding/brokers/`.
  Add the PATH wrapper in the provisioner
  (`star-fleet/src/electron/provision/children/scaffolding.ts`).
- Keys come from the environment (the provisioner exports them). Tools must name
  the env vars they need and fail cleanly when they're missing.
- Adding or renaming a skill? Update the structure tests
  (`star-fleet/tests/unit/snapshotStructure.test.ts`) and the pointers in
  `AGENTS.md` sections 2a and 3.
