"use client";

import { useState } from "react";
import { Loader2, TriangleAlert, PlugZap } from "lucide-react";
import type { ConnectionProfile, SessionStatus } from "../lib/api";
import { FileTree } from "./FileTree";
import { CodeViewer } from "./CodeViewer";
import { AgentSidebar } from "./AgentSidebar";

interface EditorViewProps {
  profile: ConnectionProfile;
  status: SessionStatus;
  message: string;
  logs: string[];
  onRetry: () => void;
  active: boolean;
  showAgent: boolean;
}

export function EditorView({
  profile,
  status,
  message,
  logs,
  onRetry,
  active,
  showAgent,
}: EditorViewProps) {
  const [openFile, setOpenFile] = useState<string | null>(null);

  if (status === "ready") {
    return (
      <div className="flex h-full w-full">
        <div className="w-64 shrink-0 border-r border-zinc-800/80">
          <FileTree
            profileId={profile.id}
            rootPath={profile.remotePath}
            activeFile={openFile}
            onOpenFile={setOpenFile}
          />
        </div>
        <div className="min-w-0 flex-1">
          <CodeViewer profileId={profile.id} path={openFile} />
        </div>
        {showAgent && (
          <div className="w-[440px] shrink-0">
            <AgentSidebar profileId={profile.id} active={active} />
          </div>
        )}
      </div>
    );
  }

  const failed = status === "error" || status === "disconnected";

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 bg-zinc-950 p-8">
      <div className="flex flex-col items-center gap-3">
        {failed ? (
          <TriangleAlert size={26} className="text-amber-500" />
        ) : (
          <Loader2 size={26} className="animate-spin text-zinc-400" />
        )}
        <div className="text-center">
          <p className="text-sm font-medium text-zinc-200">
            {status === "connecting" && "Connecting over SSH..."}
            {status === "provisioning" && "Setting up agents + tmux"}
            {status === "error" && "Connection failed"}
            {status === "disconnected" && "Disconnected"}
            {status === "idle" && "Starting..."}
          </p>
          {message && <p className="mt-1 max-w-md text-xs text-zinc-500">{message}</p>}
          {status === "provisioning" && (
            <p className="mt-1 max-w-md text-xs text-zinc-600">
              Installing your agent CLIs on first connect. This can take a couple of
              minutes; it&apos;s instant next time.
            </p>
          )}
        </div>
      </div>

      {logs.length > 0 && !failed && (
        <div className="h-44 w-full max-w-2xl overflow-y-auto rounded-lg border border-zinc-800/80 bg-black/50 p-3 font-mono text-[11px] leading-relaxed text-zinc-500">
          {logs.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}

      {failed && (
        <button
          onClick={onRetry}
          className="flex items-center gap-2 rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white"
        >
          <PlugZap size={15} />
          Reconnect
        </button>
      )}
    </div>
  );
}
