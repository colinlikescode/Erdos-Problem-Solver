"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Save, FileText } from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/utils";

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  py: "python", rs: "rust", go: "go", java: "java", c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cs: "csharp", rb: "ruby", php: "php", swift: "swift",
  json: "json", md: "markdown", yml: "yaml", yaml: "yaml", toml: "ini",
  sh: "shell", bash: "shell", html: "html", css: "css", scss: "scss",
  sql: "sql", lua: "lua", r: "r", jl: "julia", tex: "latex",
};

function langFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANG[ext] ?? "plaintext";
}

interface CodeViewerProps {
  profileId: string;
  path: string | null;
}

export function CodeViewer({ profileId, path }: CodeViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const monacoRef = useRef<any>(null);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [ready, setReady] = useState(false);
  // Save rejection (e.g. edits locked while the agent is working) - shown
  // inline until the next save attempt or file switch.
  const [saveError, setSaveError] = useState("");
  // Version id of the last saved/loaded content - dirty is "version differs",
  // so undoing back to the saved state clears the unsaved dot.
  const savedVersionRef = useRef(0);
  // The editor (and its keybindings) is created once; route commands through a
  // ref so Cmd+S always runs the latest save closure, not a stale one.
  const saveRef = useRef<() => void>(() => {});

  // Create the Monaco editor once (client-only import).
  useEffect(() => {
    let disposed = false;
    (async () => {
      const monaco = await import("monaco-editor");
      // No-op workers: colorization runs on the main thread; we don't need
      // the language service workers for a viewer, and this avoids bundling them.
      (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
        getWorker: () => new Worker(URL.createObjectURL(new Blob([""], { type: "text/javascript" }))),
      };
      if (disposed || !hostRef.current) return;
      monaco.editor.defineTheme("tabs-dark", {
        base: "vs-dark",
        inherit: true,
        rules: [],
        colors: { "editor.background": "#1a1a1a" },
      });
      const editor = monaco.editor.create(hostRef.current, {
        value: "",
        language: "plaintext",
        theme: "tabs-dark",
        readOnly: false,
        automaticLayout: true,
        fontSize: 13,
        lineHeight: 21,
        fontFamily: "'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace",
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
      });
      editor.onDidChangeModelContent(() => {
        setDirty(editor.getModel()?.getAlternativeVersionId() !== savedVersionRef.current);
      });
      // Save keybindings: Cmd+S on Mac / Ctrl+S elsewhere
      // (Monaco's CtrlCmd maps to ⌘ on Mac), plus plain Ctrl+S on Mac too so
      // both chords work.
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
      editor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyS, () => saveRef.current());
      monacoRef.current = monaco;
      editorRef.current = editor;
      setReady(true);
    })();
    return () => {
      disposed = true;
      editorRef.current?.dispose();
      editorRef.current = null;
    };
  }, []);

  // Load file contents when the selected path changes.
  useEffect(() => {
    if (!ready || !path) return;
    let cancelled = false;
    setLoading(true);
    setDirty(false);
    setSaveError("");
    api()
      .readFile(profileId, path)
      .then(({ content, truncated }) => {
        if (cancelled) return;
        const monaco = monacoRef.current;
        const editor = editorRef.current;
        editor.setValue(content);
        monaco.editor.setModelLanguage(editor.getModel(), langFor(path));
        editor.setScrollTop(0);
        savedVersionRef.current = editor.getModel()?.getAlternativeVersionId() ?? 0;
        setTruncated(truncated);
        setDirty(false);
      })
      .catch(() => {
        editorRef.current?.setValue("");
        savedVersionRef.current = editorRef.current?.getModel()?.getAlternativeVersionId() ?? 0;
        setDirty(false);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [ready, path, profileId]);

  async function save() {
    const editor = editorRef.current;
    if (!path || !editor) return;
    // Capture the version being written; only mark clean if no further edits
    // happened while the write was in flight.
    const version = editor.getModel()?.getAlternativeVersionId() ?? 0;
    if (version === savedVersionRef.current) return; // clean - nothing to save
    setSaveError("");
    try {
      await api().writeFile(profileId, path, editor.getValue());
    } catch (err) {
      // Most common: the agent is working, so main refused the write.
      setSaveError((err as Error).message.replace(/^Error invoking remote method '[^']*': Error: /, ""));
      return; // still dirty - the buffer keeps the human's changes
    }
    savedVersionRef.current = version;
    setDirty(editor.getModel()?.getAlternativeVersionId() !== version);
  }
  saveRef.current = save;

  return (
    <div
      className="flex h-full flex-col bg-[#1a1a1a]"
      onKeyDownCapture={(e) => {
        // Cmd+S / Ctrl+S anywhere in the viewer. Inside Monaco its own
        // keybinding (added above) handles it, so skip to avoid a double save.
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
          if (hostRef.current?.contains(e.target as Node)) return;
          e.preventDefault();
          saveRef.current();
        }
      }}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-zinc-800/80 px-3">
        <FileText size={13} className="text-zinc-500" />
        <span className="min-w-0 truncate font-mono text-xs text-zinc-400">
          {path ?? "No file open"}
        </span>
        {/* Unsaved indicator: white dot to the right of the file name */}
        {dirty && (
          <span
            className="h-2 w-2 shrink-0 rounded-full bg-white"
            title="Unsaved changes (⌘S / Ctrl+S to save)"
          />
        )}
        <span className="min-w-0 flex-1" />
        {truncated && <span className="text-[11px] text-amber-500">preview (large file)</span>}
        {dirty && (
          <button
            onClick={save}
            className="flex items-center gap-1 rounded-md bg-zinc-100 px-2 py-1 text-[11px] font-medium text-zinc-900 hover:bg-white"
          >
            <Save size={11} /> Save
          </button>
        )}
      </div>
      {saveError && (
        <div className="shrink-0 border-b border-amber-900/50 bg-amber-950/40 px-3 py-1.5 text-[11px] text-amber-400">
          {saveError}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {!path && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-600">
            Select a file to view
          </div>
        )}
        {loading && (
          <div className="absolute right-3 top-2 z-10">
            <Loader2 size={14} className="animate-spin text-zinc-500" />
          </div>
        )}
        <div ref={hostRef} className={cn("h-full w-full", !path && "invisible")} />
      </div>
    </div>
  );
}
