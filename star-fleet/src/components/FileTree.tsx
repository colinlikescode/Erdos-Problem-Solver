"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, ChevronDown, Folder, FolderOpen, File, Loader2 } from "lucide-react";
import { api, type DirEntry } from "../lib/api";
import { cn } from "../lib/utils";

interface FileTreeProps {
  profileId: string;
  rootPath: string;
  activeFile: string | null;
  onOpenFile: (path: string) => void;
}

interface NodeProps {
  profileId: string;
  path: string;
  name: string;
  depth: number;
  activeFile: string | null;
  onOpenFile: (path: string) => void;
}

function DirNode({ profileId, path, name, depth, activeFile, onOpenFile }: NodeProps) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = useCallback(async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (entries === null) {
      setLoading(true);
      try {
        setEntries(await api().listFiles(profileId, path));
      } catch {
        setEntries([]);
      } finally {
        setLoading(false);
      }
    }
  }, [open, entries, profileId, path]);

  return (
    <div>
      <button
        onClick={toggle}
        className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-[13px] text-zinc-300 hover:bg-zinc-800/60"
        style={{ paddingLeft: depth * 12 + 6 }}
      >
        {open ? (
          <ChevronDown size={13} className="shrink-0 text-zinc-500" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-zinc-500" />
        )}
        {open ? (
          <FolderOpen size={14} className="shrink-0 text-sky-400/80" />
        ) : (
          <Folder size={14} className="shrink-0 text-sky-400/80" />
        )}
        <span className="truncate">{name}</span>
        {loading && <Loader2 size={11} className="ml-auto animate-spin text-zinc-600" />}
      </button>
      {open && entries && (
        <div>
          {entries.map((e) => {
            const childPath = `${path.replace(/\/$/, "")}/${e.name}`;
            return e.isDir ? (
              <DirNode
                key={childPath}
                profileId={profileId}
                path={childPath}
                name={e.name}
                depth={depth + 1}
                activeFile={activeFile}
                onOpenFile={onOpenFile}
              />
            ) : (
              <FileNode
                key={childPath}
                path={childPath}
                name={e.name}
                depth={depth + 1}
                active={activeFile === childPath}
                onOpen={() => onOpenFile(childPath)}
              />
            );
          })}
          {entries.length === 0 && !loading && (
            <div className="py-1 text-[11px] text-zinc-600" style={{ paddingLeft: (depth + 1) * 12 + 22 }}>
              empty
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FileNode({
  path,
  name,
  depth,
  active,
  onOpen,
}: {
  path: string;
  name: string;
  depth: number;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      className={cn(
        "flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-[13px] hover:bg-zinc-800/60",
        active ? "bg-zinc-800 text-zinc-100" : "text-zinc-400"
      )}
      style={{ paddingLeft: depth * 12 + 6 + 13 }}
      title={path}
    >
      <File size={14} className="shrink-0 text-zinc-500" />
      <span className="truncate">{name}</span>
    </button>
  );
}

export function FileTree({ profileId, rootPath, activeFile, onOpenFile }: FileTreeProps) {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    api()
      .listFiles(profileId, rootPath)
      .then((e) => !cancelled && setEntries(e))
      .catch((err) => !cancelled && setError((err as Error).message));
    return () => {
      cancelled = true;
    };
  }, [profileId, rootPath]);

  return (
    <div className="flex h-full flex-col bg-[#171717]">
      <div className="shrink-0 border-b border-zinc-800/80 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
        Explorer
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {error ? (
          <p className="px-3 py-2 text-xs text-red-400">{error}</p>
        ) : entries === null ? (
          <div className="flex items-center justify-center py-6 text-zinc-600">
            <Loader2 size={16} className="animate-spin" />
          </div>
        ) : (
          entries.map((e) => {
            const childPath = `${rootPath.replace(/\/$/, "")}/${e.name}`;
            return e.isDir ? (
              <DirNode
                key={childPath}
                profileId={profileId}
                path={childPath}
                name={e.name}
                depth={0}
                activeFile={activeFile}
                onOpenFile={onOpenFile}
              />
            ) : (
              <FileNode
                key={childPath}
                path={childPath}
                name={e.name}
                depth={0}
                active={activeFile === childPath}
                onOpen={() => onOpenFile(childPath)}
              />
            );
          })
        )}
      </div>
    </div>
  );
}
