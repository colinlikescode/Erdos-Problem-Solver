"use client";

import { useState } from "react";
import { Plus, X, Circle, LayoutGrid, PanelRight, CloudUpload, Loader2, Check, OctagonX, FilePlus2 } from "lucide-react";
import { api, type ConnectionProfile, type SessionStatus } from "../lib/api";
import { cn } from "../lib/utils";
import { DASHBOARD, type SessionState } from "../app/useMachines";

/**
 * Fleet killswitch: runs `/stop-recursive-loop` on every machine at once (behind
 * an "are you sure?" confirm). Stops each agent loop and unlocks manual edits  - 
 * the master brake for the whole fleet.
 */
function KillSwitch({ machineCount }: { machineCount: number }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");

  async function fire() {
    setBusy(true);
    setConfirming(false);
    setResult("");
    try {
      const res = await api().killAll();
      const ok = res.filter((r) => r.ok).length;
      setResult(`Stopped ${ok}/${res.length}`);
    } catch {
      setResult("Failed");
    } finally {
      setBusy(false);
      setTimeout(() => setResult(""), 4000);
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => setConfirming((c) => !c)}
        disabled={busy || machineCount === 0}
        title="Stop the recursive loop on ALL machines"
        className={cn(
          "titlebar-no-drag mb-1.5 flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors disabled:opacity-40",
          "border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
        )}
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : <OctagonX size={13} />}
        {busy ? "Stopping…" : result || "Kill all"}
      </button>

      {confirming && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setConfirming(false)} />
          <div className="titlebar-no-drag absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border border-zinc-700 bg-[#1e1e1e] p-3 shadow-2xl">
            <p className="text-xs font-semibold text-zinc-100">Stop every agent?</p>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
              Runs <code className="text-zinc-300">/stop-recursive-loop</code> on all{" "}
              {machineCount} machine{machineCount === 1 ? "" : "s"} at once. Each agent halts and
              manual edits unlock. Resume per-machine with <code className="text-zinc-300">/start-recursive-loop</code>.
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => setConfirming(false)}
                className="rounded-md px-2.5 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              >
                Cancel
              </button>
              <button
                onClick={fire}
                className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-500"
              >
                Stop all
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

type SaveState = "idle" | "saving" | "done" | "error";

/**
 * "Save run" - archives this VM's run cargo (problem.md, verified_math/,
 * notebook, handoff, check_answer/, workspace/) to R2 under its problem, so it
 * can be continued later on a fresh droplet with the then-current snapshot.
 */
function SaveRunButton({ profileId, ready }: { profileId: string; ready: boolean }) {
  const [state, setState] = useState<SaveState>("idle");
  const [msg, setMsg] = useState("");

  async function save() {
    if (state === "saving" || !ready) return;
    setState("saving");
    setMsg("");
    try {
      const manifest = await api().saveRun(profileId);
      setState("done");
      setMsg(`saved - ${manifest.factCount ?? 0} verified facts`);
      setTimeout(() => setState("idle"), 4000);
    } catch (e) {
      setState("error");
      setMsg(e instanceof Error ? e.message : String(e));
      setTimeout(() => setState("idle"), 6000);
    }
  }

  return (
    <button
      onClick={save}
      disabled={!ready || state === "saving"}
      title={
        !ready
          ? "Connect the machine first"
          : state === "error"
            ? `Save failed: ${msg}`
            : state === "done"
              ? msg
              : "Save this run's research state to R2 (stop the loop first; continue it later from New run → Continue problem)"
      }
      className={cn(
        "titlebar-no-drag mb-1.5 flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors disabled:opacity-50",
        state === "error"
          ? "border-red-800 text-red-400"
          : state === "done"
            ? "border-emerald-800 text-emerald-400"
            : "border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
      )}
    >
      {state === "saving" ? (
        <Loader2 size={13} className="animate-spin" />
      ) : state === "done" ? (
        <Check size={13} />
      ) : (
        <CloudUpload size={13} />
      )}
      {state === "saving" ? "Saving…" : state === "done" ? "Saved" : "Save to R2"}
    </button>
  );
}

const statusColor: Record<SessionStatus, string> = {
  idle: "text-zinc-600",
  connecting: "text-amber-400",
  provisioning: "text-amber-400",
  ready: "text-emerald-400",
  error: "text-red-400",
  disconnected: "text-zinc-600",
};

interface Props {
  openTabs: string[];
  activeTab: string;
  profileById: Map<string, ConnectionProfile>;
  states: Record<string, SessionState>;
  showAgent: boolean;
  onSelect: (id: string) => void;
  onRequestClose: (id: string) => void;
  onToggleAgent: () => void;
  onAddProblem: () => void;
}

/** Browser-style tab strip: Home, one tab per open machine, agent/keys toggles. */
export function TabStrip({
  openTabs,
  activeTab,
  profileById,
  states,
  showAgent,
  onSelect,
  onRequestClose,
  onToggleAgent,
  onAddProblem,
}: Props) {
  return (
    <div className="titlebar-drag flex h-11 shrink-0 items-end gap-1 border-b border-[#262626] bg-[#141414] pl-[84px] pr-3">
      <div className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto pb-1.5">
        <button
          onClick={() => onSelect(DASHBOARD)}
          className={cn(
            "titlebar-no-drag mb-0 flex h-8 shrink-0 items-center gap-2 rounded-t-lg border border-b-0 px-3 transition-colors",
            activeTab === DASHBOARD
              ? "border-[#262626] bg-[#1a1a1a] text-zinc-100"
              : "border-transparent text-zinc-500 hover:bg-white/[0.03] hover:text-zinc-300"
          )}
        >
          <LayoutGrid size={13} />
          <span className="text-xs font-medium">Home</span>
        </button>

        {openTabs.map((id) => {
          const profile = profileById.get(id);
          const status = states[id]?.status ?? "idle";
          if (!profile) return null;
          return (
            <div
              key={id}
              onClick={() => onSelect(id)}
              className={cn(
                "titlebar-no-drag group flex h-8 min-w-0 max-w-52 flex-1 cursor-pointer items-center gap-2 rounded-t-lg border border-b-0 px-3 transition-colors",
                activeTab === id
                  ? "border-[#262626] bg-[#1a1a1a] text-zinc-100"
                  : "border-transparent text-zinc-500 hover:bg-white/[0.03] hover:text-zinc-300"
              )}
            >
              <Circle size={7} className={cn("shrink-0 fill-current", statusColor[status])} />
              <span className="min-w-0 flex-1 truncate text-xs font-medium">{profile.name}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRequestClose(id);
                }}
                className="shrink-0 rounded p-0.5 text-zinc-600 opacity-0 transition-opacity hover:bg-zinc-700/60 hover:text-zinc-200 group-hover:opacity-100"
              >
                <X size={12} />
              </button>
            </div>
          );
        })}

        <button
          onClick={() => onSelect(DASHBOARD)}
          className="titlebar-no-drag mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-200"
          title="Machines"
        >
          <Plus size={15} />
        </button>
      </div>
      {activeTab === DASHBOARD && (
        <button
          onClick={onAddProblem}
          title="Add a problem to the run list"
          className="titlebar-no-drag mb-1.5 flex h-7 items-center gap-1.5 rounded-lg border border-zinc-800 px-2.5 text-xs font-medium text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-200"
        >
          <FilePlus2 size={13} />
          Add Problem
        </button>
      )}
      {activeTab === DASHBOARD && <KillSwitch machineCount={profileById.size} />}
      {activeTab !== DASHBOARD && (
        <SaveRunButton profileId={activeTab} ready={(states[activeTab]?.status ?? "idle") === "ready"} />
      )}
      {activeTab !== DASHBOARD && (
        <button
          onClick={onToggleAgent}
          className={cn(
            "titlebar-no-drag mb-1.5 flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors",
            showAgent
              ? "border-zinc-700 bg-zinc-800 text-zinc-200"
              : "border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
          )}
          title="Toggle agent panel"
        >
          <PanelRight size={13} />
          Agent
        </button>
      )}
    </div>
  );
}
