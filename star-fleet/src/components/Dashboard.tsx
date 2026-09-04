"use client";

import { Plus, ServerOff, X, Cpu, Server, Globe, BookOpen, MessageSquare, ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { ConnectionProfile } from "../lib/api";
import { MachineCard } from "./MachineCard";
import type { SessionState } from "../app/useMachines";

interface Props {
  profiles: ConnectionProfile[];
  states: Record<string, SessionState>;
  onAdd: () => void;
  onOpen: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
}

const STEPS: { title: string; body: ReactNode }[] = [
  {
    title: "Choose a problem",
    body: (
      <>
        Use <span className="text-zinc-300">Add Problem</span> to save a math problem (name +
        description). Saved runs can be continued later from R2.
      </>
    ),
  },
  {
    title: "Start a run",
    body: (
      <>
        Click <span className="text-zinc-300">New run</span>, then pick a problem - fresh
        (<span className="text-zinc-300">New problem</span>) or resuming a saved run from R2
        (<span className="text-zinc-300">Continue problem</span>). Star Fleet spins up a
        60 vCPU · 120 GB droplet and installs everything.
      </>
    ),
  },
  {
    title: "Provisions & starts automatically",
    body: (
      <>
        The research base lands at <code className="text-zinc-400">~/snapshot</code> (or a saved
        run is restored into it), and the agent starts on its own. It never stops until the
        problem is solved and survives closing your laptop.
      </>
    ),
  },
  {
    title: "Watch, chat, or stop",
    body: (
      <>
        The Agent sidebar streams its work live. To intervene, run{" "}
        <code className="text-emerald-400">/stop-recursive-loop</code> (then type a message to
        chat); <code className="text-emerald-400">/start-recursive-loop</code> resumes. Or hit{" "}
        <span className="text-zinc-300">Kill all</span> to stop every run at once.
      </>
    ),
  },
];

// The full sidebar command reference. This list is the single source of truth
// shown on Home - keep it in sync with vm-base/scaffolding/tabs-repl.sh.
const COMMANDS: { cmd: string; desc: ReactNode }[] = [
  {
    cmd: "/stop-recursive-loop",
    desc: "Stop the loop, unlock manual file edits, and chat with the agent (type a message).",
  },
  {
    cmd: "/start-recursive-loop",
    desc: "Resume the never-stop loop where it left off (after a stop).",
  },
  {
    cmd: '/reject "<why>"',
    desc: "After the agent texts you a solution you judge wrong: tell it why and it resumes working (takes the rejection as ground truth, retries you when ready).",
  },
  {
    cmd: "/model",
    desc: "Show or switch the model the loop runs. Stop first, switch, then resume.",
  },
];

// Models the loop can run. The live allowlist comes from the codex-broker's
// /models endpoint (CODEX_MODELS), so new models roll out fleet-wide without
// touching a VM. Keep this in sync with vm-base/scaffolding/agent-loop.sh.
const MODELS: { name: string; tag: string }[] = [
  { name: "gpt-5.5", tag: "default · xhigh reasoning" },
  { name: "gpt-5.4", tag: "alternate · xhigh reasoning" },
];

// Context window depends on the backend, not the model (see context_window_for).
const WINDOWS: { backend: string; window: string }[] = [
  { backend: "ChatGPT Codex backend (broker accounts + reserve)", window: "400,000 tokens" },
  { backend: "Raw OpenAI API key", window: "1,000,000 tokens" },
];

// Provider failover, in order. The supervisor cycles this forever and never
// exits on its own. Matches agent-loop.sh.
const FALLBACK: { step: string; detail: string }[] = [
  { step: "Codex broker pool", detail: "Pooled ChatGPT Codex accounts, round-robin (the codex-broker vends tokens)." },
  { step: "Codex reserve account", detail: "High-budget ChatGPT Codex account, used when the pool is exhausted." },
  { step: "OpenAI direct key", detail: "Regular OpenAI API key (OPENAI_API_KEY), last resort." },
];

// The under-the-hood providers behind the skills (the agent never picks these;
// the broker does). Shown in the "See providers" modal.
const PROVIDERS: { category: string; detail: string; providers: string[] }[] = [
  {
    category: "GPU burst",
    detail: "H100 GPUs. Broker preference order: Daytona, then Modal #1, then Modal #2.",
    providers: ["Daytona", "Modal (account 1)", "Modal (account 2)"],
  },
  {
    category: "CPU burst",
    detail: "Sharded CPU. E2B for up to 200 vCPU (8 vCPU/box), Cloudflare above that (standard-4).",
    providers: ["E2B", "Cloudflare"],
  },
  {
    category: "Web & research search",
    detail: "Search + scrape via Firecrawl, digested by GPT-5.5 (xhigh) via the broker chain.",
    providers: ["Firecrawl", "GPT-5.5 (broker chain)"],
  },
  {
    category: "Lean search",
    detail: "Self-hosted Mathlib search: Gemini embeddings-2 + Chroma Cloud + GPT-5.5 (xhigh) rerank (on Railway).",
    providers: ["Chroma Cloud", "Gemini embeddings-2", "GPT-5.5 (broker chain)"],
  },
  {
    category: "Text the operator",
    detail: "The human escalation channel (stuck / need a huge GPU cluster / solved). Sends via Sendblue.",
    providers: ["Sendblue"],
  },
];

// Every skill the agent can invoke. Mirrors vm-base/snapshot/.agents/skills/.
const SKILLS: { name: string; icon: ReactNode; desc: string }[] = [
  {
    name: "gpu-burst",
    icon: <Cpu size={14} className="text-zinc-400" />,
    desc: "Request up to 10 individual H100 GPUs (shard bigger jobs); the broker allocates them.",
  },
  {
    name: "cpu-burst",
    icon: <Server size={14} className="text-zinc-400" />,
    desc: "Request up to 400 vCPUs of burst CPU for large shardable jobs; the broker shards it.",
  },
  {
    name: "web-search",
    icon: <Globe size={14} className="text-zinc-400" />,
    desc: "Search the web and get full page content. Powered by an LLM.",
  },
  {
    name: "research-search",
    icon: <BookOpen size={14} className="text-zinc-400" />,
    desc: "Search papers and related GitHub repos; read passages, find related work. Powered by an LLM.",
  },
  {
    name: "lean-search",
    icon: <BookOpen size={14} className="text-zinc-400" />,
    desc: "Search Mathlib 4 in plain English; returns exact Lean lemma names + signatures.",
  },
  {
    name: "text-operator",
    icon: <MessageSquare size={14} className="text-zinc-400" />,
    desc: "Text the human owner and HALT - only when stuck, needing a huge GPU cluster, or solved.",
  },
];

/** Modal: available models, per-backend context windows, and the fallback order. */
function ModelsModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[82vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-zinc-700/80 bg-[#1c1c1c] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-zinc-800 bg-[#1c1c1c] px-5 py-3.5">
          <h2 className="text-sm font-semibold text-zinc-100">Models &amp; failover</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-5 p-5">
          {/* Available models */}
          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Available models
            </h3>
            <div className="mt-2 space-y-1.5">
              {MODELS.map((m) => (
                <div
                  key={m.name}
                  className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2"
                >
                  <code className="font-mono text-[13px] font-medium text-emerald-400">{m.name}</code>
                  <span className="text-[11px] text-zinc-500">{m.tag}</span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
              The live allowlist comes from the codex-broker, so new models (e.g. a future gpt-5.6)
              roll out to every VM without an update. Switch per-machine with{" "}
              <code className="text-emerald-400">/model</code>.
            </p>
          </section>

          {/* Context window */}
          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Context window
            </h3>
            <div className="mt-2 space-y-1.5">
              {WINDOWS.map((w) => (
                <div
                  key={w.backend}
                  className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2"
                >
                  <div className="font-mono text-[13px] font-medium text-zinc-100">{w.window}</div>
                  <div className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">{w.backend}</div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
              At 90% of the window the loop writes <code className="text-emerald-400">handoff.md</code>{" "}
              and compacts into a fresh session, so work never hits a hard context wall.
            </p>
          </section>

          {/* Fallback order */}
          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Provider fallback order
            </h3>
            <ol className="mt-2 space-y-2">
              {FALLBACK.map((f, i) => (
                <li key={f.step} className="flex gap-2.5">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[11px] font-semibold text-emerald-400">
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-zinc-100">{f.step}</div>
                    <div className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">{f.detail}</div>
                  </div>
                </li>
              ))}
            </ol>
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
              The supervisor cycles this list forever and never exits on its own - the only handback
              is the <code className="text-emerald-400">text-operator</code> skill.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

/** A collapsible titled section with a tiny chevron toggle (starts closed). */
function Collapsible({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-4 border-t border-zinc-800 pt-4">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 text-left"
      >
        <ChevronRight
          size={13}
          className={`shrink-0 text-zinc-500 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{title}</span>
      </button>
      {open && (
        <div className="mt-2 pb-5 pl-[18px]">
          {subtitle && <p className="text-xs leading-relaxed text-zinc-500">{subtitle}</p>}
          {children}
        </div>
      )}
    </div>
  );
}

/** Modal: the under-the-hood providers behind each skill category. */
function ProvidersModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[82vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-zinc-700/80 bg-[#1c1c1c] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-zinc-800 bg-[#1c1c1c] px-5 py-3.5">
          <h2 className="text-sm font-semibold text-zinc-100">Skill providers</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          >
            <X size={16} />
          </button>
        </div>
        <div className="space-y-4 p-5">
          <p className="text-[11px] leading-relaxed text-zinc-500">
            The agent never chooses a provider - the broker does, under the hood. These are the
            services the skills actually run on.
          </p>
          {PROVIDERS.map((p) => (
            <section key={p.category}>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                {p.category}
              </h3>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {p.providers.map((name) => (
                  <span
                    key={name}
                    className="rounded-md border border-zinc-800 bg-zinc-900/50 px-2 py-1 font-mono text-[12px] text-emerald-400"
                  >
                    {name}
                  </span>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">{p.detail}</p>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The Home explanation: how the whole system works, plus the command reference. */
function HowItWorks() {
  const [modelsOpen, setModelsOpen] = useState(false);
  const [providersOpen, setProvidersOpen] = useState(false);
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h2 className="text-sm font-semibold text-zinc-100">How it works</h2>
      <ol className="mt-4 space-y-3">
        {STEPS.map((step, i) => (
          <li key={step.title} className="flex gap-3">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[11px] font-semibold text-zinc-300">
              {i + 1}
            </span>
            <div>
              <p className="text-sm font-medium text-zinc-200">{step.title}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <Collapsible
        title="Sidebar commands"
        subtitle="Type these in a machine's sidebar. Everything else you type runs as a shell command."
      >
        <ul className="mt-3 space-y-2">
          {COMMANDS.map(({ cmd, desc }) => (
            <li key={cmd} className="flex flex-col gap-1 sm:flex-row sm:gap-3">
              <code className="shrink-0 font-mono text-xs text-emerald-400 sm:w-52">{cmd}</code>
              <span className="text-xs leading-relaxed text-zinc-500">{desc}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs leading-relaxed text-zinc-600">
          While the loop is running, manual file edits are locked - run{" "}
          <code className="text-zinc-400">/stop-recursive-loop</code> first, then{" "}
          <code className="text-zinc-400">/start-recursive-loop</code>{" "}when you&apos;re done.
        </p>
        <button
          onClick={() => setModelsOpen(true)}
          className="mt-3 text-xs font-medium text-emerald-400 underline-offset-2 hover:text-emerald-300 hover:underline"
        >
          View models, context windows &amp; fallback order →
        </button>
      </Collapsible>

      <Collapsible
        title="Agent skills"
        subtitle="Capabilities the agent can invoke on its own while it works."
      >
        <ul className="mt-3 space-y-2.5">
          {SKILLS.map((s) => (
            <li key={s.name} className="flex items-start gap-2.5">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-zinc-800/80">
                {s.icon}
              </span>
              <div className="min-w-0">
                <code className="font-mono text-xs text-zinc-200">{s.name}</code>
                <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{s.desc}</p>
              </div>
            </li>
          ))}
        </ul>
        <button
          onClick={() => setProvidersOpen(true)}
          className="mt-3 text-xs font-medium text-emerald-400 underline-offset-2 hover:text-emerald-300 hover:underline"
        >
          See providers →
        </button>
      </Collapsible>

      {modelsOpen && <ModelsModal onClose={() => setModelsOpen(false)} />}
      {providersOpen && <ProvidersModal onClose={() => setProvidersOpen(false)} />}
    </div>
  );
}

/** Home tab: how-it-works + the machine list (or the empty state). */
export function Dashboard({ profiles, states, onAdd, onOpen, onRename, onRemove }: Props) {
  if (profiles.length === 0) {
    return (
      <div className="mx-auto flex h-full max-w-2xl flex-col justify-center gap-6">
        <div className="flex flex-col items-center text-center">
          <ServerOff size={32} className="text-zinc-700" />
          <p className="mt-4 text-sm font-medium text-zinc-300">No runs yet</p>
          <p className="mt-1 max-w-sm text-sm text-zinc-600">
            Start a run and Star Fleet spins up a self-driving research VM and puts the agent to
            work automatically.
          </p>
          <button
            onClick={onAdd}
            className="mt-5 flex items-center gap-1.5 rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white"
          >
            <Plus size={15} />
            New run
          </button>
        </div>
        <HowItWorks />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl pb-20 pt-10">
      <HowItWorks />
      <div className="mb-4 mt-6 flex items-center justify-between">
        <div>
          <h1 className="text-sm font-semibold text-zinc-100">Runs</h1>
          <p className="text-xs text-zinc-500">Agents run in tmux - safe to close your laptop.</p>
        </div>
        <button
          onClick={onAdd}
          className="flex items-center gap-1.5 rounded-lg bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 transition-colors hover:bg-white"
        >
          <Plus size={15} />
          New run
        </button>
      </div>
      <div className="grid grid-cols-1 gap-3">
        {profiles.map((profile) => (
          <MachineCard
            key={profile.id}
            profile={profile}
            status={states[profile.id]?.status ?? "idle"}
            onOpen={() => onOpen(profile.id)}
            onRename={(name) => onRename(profile.id, name)}
            onRemove={() => onRemove(profile.id)}
          />
        ))}
      </div>
    </div>
  );
}
