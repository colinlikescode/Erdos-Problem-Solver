"use client";

import { useEffect, type ReactNode } from "react";

interface ConfirmDialogProps {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ title, body, confirmLabel, onConfirm, onCancel }: ConfirmDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onConfirm, onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-[#2a2a2a] bg-[#1a1a1a] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h1 className="text-base font-semibold text-zinc-100">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-500">{body}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-[#2a2a2a] px-3.5 py-2 text-sm text-zinc-300 transition-colors hover:bg-white/[0.04]"
          >
            Cancel
          </button>
          <button
            autoFocus
            onClick={onConfirm}
            className="rounded-lg bg-zinc-100 px-3.5 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
