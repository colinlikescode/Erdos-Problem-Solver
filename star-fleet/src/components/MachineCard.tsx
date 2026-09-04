"use client";

import { useState } from "react";
import { Server, Trash2, ExternalLink } from "lucide-react";
import type { ConnectionProfile, SessionStatus } from "../lib/api";
import { cn } from "../lib/utils";

const DOT: Record<SessionStatus, string> = {
  idle: "bg-zinc-600",
  connecting: "bg-amber-400",
  provisioning: "bg-amber-400",
  ready: "bg-emerald-400",
  error: "bg-red-400",
  disconnected: "bg-zinc-600",
};

interface MachineCardProps {
  profile: ConnectionProfile;
  status: SessionStatus;
  onOpen: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
}

export function MachineCard({ profile, status, onOpen, onRename, onRemove }: MachineCardProps) {
  const [editing, setEditing] = useState(false);

  return (
    <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4 transition-colors hover:border-zinc-700/80">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-800/80">
          <Server size={16} className="text-zinc-400" />
        </div>

        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              autoFocus
              defaultValue={profile.name}
              onFocus={(e) => e.target.select()}
              onBlur={(e) => {
                setEditing(false);
                onRename(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setEditing(false);
                  onRename(e.currentTarget.value);
                }
                if (e.key === "Escape") setEditing(false);
              }}
              className="w-full bg-transparent text-sm font-medium text-zinc-100 outline-none"
            />
          ) : (
            <button
              onClick={() => setEditing(true)}
              className="block max-w-full truncate text-left text-sm font-medium text-zinc-100 hover:text-white"
              title="Click to rename"
            >
              {profile.name}
            </button>
          )}
          <p className="truncate text-xs text-zinc-500">
            {profile.username}@{profile.host} · Pi
          </p>
        </div>

        <span className={cn("h-2 w-2 shrink-0 rounded-full", DOT[status])} />

        <button
          onClick={onOpen}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 transition-colors hover:bg-white"
        >
          <ExternalLink size={13} />
          Open
        </button>

        <button
          onClick={onRemove}
          className="shrink-0 rounded-lg border border-zinc-800 p-2 text-zinc-500 transition-colors hover:border-red-900 hover:text-red-400"
          title="Remove machine"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
