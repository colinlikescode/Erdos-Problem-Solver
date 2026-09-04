"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "../../lib/utils";

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * A dependency-free shadcn-style Select: a trigger button + a floating popover
 * of options (check on the selected one, comfortable row spacing). Closes on
 * outside click or Escape. Keyboard: ↑/↓ to move, Enter to pick.
 */
export function Select({
  value,
  options,
  onChange,
  placeholder = "Select…",
  disabled,
  autoFocus,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    if (open) setActive(Math.max(0, options.findIndex((o) => o.value === value)));
  }, [open, value, options]);

  function pick(v: string) {
    onChange(v);
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        autoFocus={autoFocus}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
            e.preventDefault();
            setOpen(true);
            return;
          }
          if (!open) return;
          if (e.key === "Escape") setOpen(false);
          else if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => (a + 1) % options.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => (a - 1 + options.length) % options.length);
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (options[active]) pick(options[active].value);
          }
        }}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-left text-sm transition-colors",
          "outline-none focus:border-zinc-600 disabled:opacity-40",
          open && "border-zinc-600"
        )}
      >
        <span className={cn("truncate", selected ? "text-zinc-100" : "text-zinc-600")}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronsUpDown size={14} className="shrink-0 text-zinc-500" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1.5 max-h-72 w-full overflow-y-auto rounded-lg border border-zinc-700 bg-[#1e1e1e] p-1.5 shadow-2xl">
          {options.length === 0 ? (
            <div className="px-2.5 py-2 text-xs text-zinc-600">No options</div>
          ) : (
            options.map((o, i) => (
              <button
                key={o.value}
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o.value)}
                className={cn(
                  "my-0.5 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                  i === active ? "bg-zinc-800 text-zinc-100" : "text-zinc-300 hover:bg-zinc-800/60"
                )}
              >
                <Check
                  size={14}
                  className={cn("shrink-0", o.value === value ? "text-emerald-400" : "text-transparent")}
                />
                <span className="truncate">{o.label}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
