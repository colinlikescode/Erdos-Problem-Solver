"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { PROBLEM_CATEGORY_LABEL, type ProblemCategory } from "../shared/types";
import { cn } from "../lib/utils";
import { Select } from "./ui/Select";

interface AddProblemDialogProps {
  onClose: () => void;
  onAdd: (
    name: string,
    description: string,
    category?: ProblemCategory,
    sourceUrl?: string
  ) => Promise<unknown>;
}

const inputClass =
  "w-full rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-sm text-zinc-100 " +
  "placeholder:text-zinc-600 outline-none focus:border-zinc-600 transition-colors";

/** Save a research problem (name + description + family/source) for the run dropdown. */
export function AddProblemDialog({ onClose, onAdd }: AddProblemDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<ProblemCategory>("frontier");
  const [sourceUrl, setSourceUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const canSave = name.trim().length > 0 && description.trim().length > 0 && !saving;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    try {
      await onAdd(name, description, category, sourceUrl.trim() || undefined);
      onClose();
    } catch {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h1 className="text-lg font-semibold text-zinc-100">Add problem</h1>
            <p className="mt-1 text-sm text-zinc-500">
              Saved problems show up in the run dropdown. The description is written verbatim
              into the VM&apos;s <code className="text-zinc-400">problem.md</code>.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={save} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-400">Name</label>
            <input
              className={inputClass}
              placeholder="e.g. Hadamard 428"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              spellCheck={false}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">Problem family</label>
              <Select
                value={category}
                onChange={(v) => setCategory(v as ProblemCategory)}
                options={(Object.keys(PROBLEM_CATEGORY_LABEL) as ProblemCategory[]).map((c) => ({
                  value: c,
                  label: PROBLEM_CATEGORY_LABEL[c],
                }))}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">Source link (optional)</label>
              <input
                className={cn(inputClass, "font-mono text-xs")}
                placeholder="https://…"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                spellCheck={false}
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-400">Problem description</label>
            <textarea
              className={cn(inputClass, "h-40 resize-y font-mono text-xs leading-relaxed")}
              placeholder="State the math problem and what counts as solved."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              spellCheck={false}
            />
          </div>
          <button
            type="submit"
            disabled={!canSave}
            className={cn(
              "w-full rounded-lg py-2.5 text-sm font-medium transition-colors",
              canSave ? "bg-zinc-100 text-zinc-900 hover:bg-white" : "cursor-not-allowed bg-zinc-800 text-zinc-600"
            )}
          >
            {saving ? "Saving…" : "Save problem"}
          </button>
        </form>
      </div>
    </div>
  );
}
