"use client";

import { useEffect, useRef, useState } from "react";
import { X, Loader2, Sparkles, History, GitBranch, ExternalLink } from "lucide-react";
import { api, type CreateRunInput, type Problem, type SavedRunManifest } from "../lib/api";
import { PROBLEM_CATEGORY_LABEL } from "../shared/types";
import { buildSaveTree, flattenSaveTree } from "../shared/saveTree";
import { cn } from "../lib/utils";
import { Select } from "./ui/Select";

/** Category badge styling - subtle, monochrome-adjacent accents. */
const CATEGORY_BADGE: Record<string, string> = {
  frontier: "border-zinc-700 text-zinc-400",
  millennium: "border-amber-900/70 text-amber-500/90",
  erdos: "border-emerald-900/70 text-emerald-500/90",
};

function ProblemBadge({ problem }: { problem: Problem }) {
  if (!problem.category) return null;
  const label = PROBLEM_CATEGORY_LABEL[problem.category];
  const badge = (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium",
        CATEGORY_BADGE[problem.category] ?? CATEGORY_BADGE.frontier
      )}
    >
      {label}
      {problem.sourceUrl && <ExternalLink size={9} />}
    </span>
  );
  return problem.sourceUrl ? (
    <a
      href={problem.sourceUrl}
      target="_blank"
      rel="noreferrer"
      title={problem.sourceUrl}
      className="transition-opacity hover:opacity-75"
      onClick={(e) => e.stopPropagation()}
    >
      {badge}
    </a>
  ) : (
    badge
  );
}

interface NewRunDialogProps {
  problems: Problem[];
  onClose: () => void;
  /** Spin up + open the run. Resolves once the droplet is saved. */
  onCreate: (input: CreateRunInput) => Promise<void>;
}

type Source = "new" | "continue";

const fmtWhen = (ts: number) =>
  new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * "New run" - the only way to make a machine. Both paths spin up a fresh
 * droplet with the current base snapshot (the chassis):
 *   New problem      -> problem.md seeded, agent starts from zero.
 *   Continue problem -> additionally overlays a saved run's cargo from R2
 *                      (verified_math, notebook, handoff, workspace…), so the
 *                      agent resumes the accumulated research on the latest
 *                      doctrine/skills - no drift, nothing to merge.
 */
export function NewRunDialog({ problems, onClose, onCreate }: NewRunDialogProps) {
  const [source, setSource] = useState<Source>("new");
  const [problemId, setProblemId] = useState<string>(problems[0]?.id ?? "");
  const [saved, setSaved] = useState<SavedRunManifest[] | null>(null); // all problems
  const [savedRunId, setSavedRunId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  // Saved runs load once when Continue is first selected.
  useEffect(() => {
    if (source !== "continue" || saved !== null) return;
    api()
      .listSavedRuns()
      .then((m) => {
        if (!mounted.current) return;
        setSaved(m);
        // Default to a problem that actually has saves.
        const withSaves = problems.find((p) => m.some((s) => s.problemId === p.id));
        if (withSaves && !m.some((s) => s.problemId === problemId)) setProblemId(withSaves.id);
      })
      .catch((e) => mounted.current && setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const savesForProblem = (saved ?? []).filter((s) => s.problemId === problemId);
  // Newest save is the default choice.
  useEffect(() => {
    if (source === "continue") setSavedRunId(savesForProblem[0]?.runId ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problemId, saved, source]);

  const continueProblems = problems.filter((p) => (saved ?? []).some((s) => s.problemId === p.id));
  const shownProblems = source === "continue" ? continueProblems : problems;

  const canSubmit =
    !submitting &&
    problemId.length > 0 &&
    (source === "new" || savedRunId.length > 0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError("");
    setProgress("starting…");
    const off = api().onSpinupProgress(({ message }) => {
      if (mounted.current) setProgress(message);
    });
    try {
      await onCreate(
        source === "continue"
          ? { source: "continue", problemId, savedRunId }
          : { source: "new", problemId }
      );
    } catch (err) {
      if (mounted.current) {
        setError((err as Error).message);
        setSubmitting(false);
        setProgress("");
      }
    } finally {
      off();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h1 className="text-lg font-semibold text-zinc-100">New run</h1>
            <p className="mt-1 text-sm text-zinc-500">
              Star Fleet spins up a fresh droplet, installs everything, and starts the agent
              automatically - no manual steps.
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-2">
          {([
            { s: "new" as const, label: "New problem", icon: Sparkles },
            { s: "continue" as const, label: "Continue problem", icon: History },
          ]).map(({ s, label, icon: Icon }) => (
            <button
              key={s}
              type="button"
              disabled={submitting}
              onClick={() => { setSource(s); setError(""); }}
              className={cn(
                "flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors disabled:opacity-40",
                source === s
                  ? "border-zinc-500 bg-zinc-800 text-zinc-100"
                  : "border-zinc-800 bg-zinc-900/50 text-zinc-400 hover:text-zinc-200"
              )}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-400">Problem</label>
            {shownProblems.length === 0 ? (
              <p className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2.5 text-xs text-zinc-500">
                {source === "continue"
                  ? saved === null
                    ? "Loading saved runs…"
                    : "No saved runs yet - save a run first (the Save run button on a machine tab)."
                  : (<>No saved problems yet. Add one with the <span className="text-zinc-300">Add Problem</span> button.</>)}
              </p>
            ) : (
              <Select
                value={problemId}
                onChange={setProblemId}
                disabled={submitting}
                autoFocus
                placeholder="Pick a problem"
                options={shownProblems.map((p) => ({
                  value: p.id,
                  label: p.category ? `${p.name}   ·  ${PROBLEM_CATEGORY_LABEL[p.category]}` : p.name,
                }))}
              />
            )}
            {(() => {
              const sel = problems.find((p) => p.id === problemId);
              if (!sel?.description) return null;
              return (
                <div className="mt-2">
                  <div className="mb-1.5 flex items-center gap-2">
                    <ProblemBadge problem={sel} />
                    {sel.sourceUrl && (
                      <a
                        href={sel.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate text-[10px] text-zinc-600 transition-colors hover:text-zinc-400"
                      >
                        {sel.sourceUrl.replace(/^https?:\/\//, "")}
                      </a>
                    )}
                  </div>
                  <p className="max-h-24 overflow-y-auto whitespace-pre-wrap rounded-lg border border-zinc-800/70 bg-zinc-900/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-500">
                    {sel.description}
                  </p>
                </div>
              );
            })()}
          </div>

          {source === "continue" && savesForProblem.length > 0 && (
            <div>
              <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-zinc-400">
                <GitBranch size={12} />
                Save lineage - pick where to continue from
              </label>
              <div className="max-h-56 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900/40 py-1.5">
                {flattenSaveTree(buildSaveTree(savesForProblem)).map(({ node, isLast }) => {
                  const m = node.manifest;
                  const selected = m.runId === savedRunId;
                  return (
                    <button
                      key={m.runId}
                      type="button"
                      disabled={submitting}
                      onClick={() => setSavedRunId(m.runId)}
                      className={cn(
                        "flex w-full items-center gap-0 px-3 py-1 text-left transition-colors",
                        selected ? "bg-zinc-800/80" : "hover:bg-zinc-800/40"
                      )}
                    >
                      {/* branch connector glyphs (git-graph style) */}
                      {isLast.slice(0, -1).map((last, i) => (
                        <span key={i} className="w-4 shrink-0 text-center font-mono text-[11px] leading-5 text-zinc-700">
                          {last ? "" : "│"}
                        </span>
                      ))}
                      {node.depth > 0 && (
                        <span className="w-4 shrink-0 text-center font-mono text-[11px] leading-5 text-zinc-700">
                          {isLast[isLast.length - 1] ? "└" : "├"}
                        </span>
                      )}
                      <span
                        className={cn(
                          "mr-2 h-2 w-2 shrink-0 rounded-full border",
                          selected ? "border-zinc-100 bg-zinc-100" : "border-zinc-600 bg-zinc-900"
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        <span className={cn("text-xs", selected ? "text-zinc-100" : "text-zinc-300")}>
                          {fmtWhen(m.savedAt)}
                        </span>
                        <span className="ml-2 text-[11px] text-zinc-500">
                          {m.factCount ?? 0} facts{m.note ? ` · ${m.note}` : ""}
                        </span>
                      </span>
                      {node.depth === 0 && (
                        <span className="ml-2 shrink-0 rounded border border-zinc-800 px-1 text-[10px] text-zinc-600">
                          root
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-zinc-600">
                Each continuation becomes a new branch under the save it grew from. The chosen
                save&apos;s research state (verified_math, notebook, handoff, workspace) is
                overlaid on the current base snapshot - the agent resumes on the latest
                doctrine and skills.
              </p>
            </div>
          )}

          <p className="text-xs leading-relaxed text-zinc-600">
            Creates a 60 vCPU · 120 GB · 750 GB Ubuntu 24.04 droplet in NYC1, then provisions
            and starts the agent (~2-3 min).
          </p>

          {submitting && (
            <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2.5 text-xs text-zinc-400">
              <Loader2 size={14} className="animate-spin text-zinc-400" />
              {progress || "working…"}
            </div>
          )}

          {error && (
            <p className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-400">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            className={cn(
              "w-full rounded-lg py-2.5 text-sm font-medium transition-colors",
              canSubmit
                ? "bg-zinc-100 text-zinc-900 hover:bg-white"
                : "cursor-not-allowed bg-zinc-800 text-zinc-600"
            )}
          >
            {submitting ? "Creating…" : source === "continue" ? "Continue run" : "Create run"}
          </button>
        </form>
      </div>
    </div>
  );
}
