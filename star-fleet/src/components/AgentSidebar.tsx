"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bot, Send, Wrench, Sparkles, TriangleAlert, ChevronRight } from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/utils";

interface AgentSidebarProps {
  profileId: string;
  active: boolean;
}

// The repl slash-commands, shown as an autocomplete when you type "/".
// Keep in sync with vm-base/scaffolding/tabs-repl.sh.
const SLASH_COMMANDS: { cmd: string; desc: string; takesArg?: boolean }[] = [
  { cmd: "/stop-recursive-loop", desc: "Stop the loop, unlock edits, and chat with the agent" },
  { cmd: "/start-recursive-loop", desc: "Resume the never-stop loop where it left off" },
  { cmd: "/reject", desc: 'Reject a handed-back solution: /reject "why it\'s wrong" - resumes work', takesArg: true },
  { cmd: "/model", desc: "Show or switch the model (e.g. /model gpt-5.4)", takesArg: true },
];

type Ev = { k: string; v: string; t?: number };

/** Collapsible "Thought" block - muted, like Cursor's reasoning. */
function Thought({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const preview = text.length > 90 ? text.slice(0, 90) + "…" : text;
  return (
    <button
      onClick={() => setOpen((o) => !o)}
      className="my-1 flex w-full items-start gap-1.5 text-left text-zinc-500 transition-colors hover:text-zinc-400"
    >
      <ChevronRight size={13} className={cn("mt-0.5 shrink-0 transition-transform", open && "rotate-90")} />
      <span className="min-w-0 whitespace-pre-wrap break-words text-[12px] italic leading-relaxed">
        {open ? text : preview}
      </span>
    </button>
  );
}

/**
 * One action = one card: a tool call (bash/read/edit/…) with its result folded
 * in. Collapsed shows name + args on a row; click to expand pretty args + the
 * full result. This is the atomic unit of the feed.
 */
function ToolBlock({ v, result }: { v: string; result?: string }) {
  const [open, setOpen] = useState(false);
  const sp = v.indexOf(" ");
  const name = sp === -1 ? v : v.slice(0, sp);
  let arg = sp === -1 ? "" : v.slice(sp + 1);
  if (open && arg) {
    try {
      arg = JSON.stringify(JSON.parse(arg), null, 2);
    } catch {
      /* not json - show raw */
    }
  }
  return (
    <button
      onClick={() => setOpen((o) => !o)}
      className="my-1 block w-full rounded-lg border border-zinc-800 bg-[#1e1e1e] px-2.5 py-2 text-left transition-colors hover:border-zinc-700"
    >
      <span className="flex items-center gap-2">
        <Wrench size={13} className="shrink-0 text-zinc-400" />
        <span className="shrink-0 font-mono text-[13px] font-medium text-zinc-200">{name}</span>
        {!open && arg && (
          <span className="min-w-0 truncate font-mono text-[13px] text-zinc-400">{arg}</span>
        )}
      </span>
      {open && arg && (
        <pre className="mt-1.5 max-h-80 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-zinc-300">
          {arg}
        </pre>
      )}
      {open && result && (
        <pre className="mt-1.5 max-h-80 overflow-y-auto whitespace-pre-wrap break-words border-t border-zinc-800 pt-1.5 font-mono text-[12px] leading-relaxed text-zinc-500">
          {result}
        </pre>
      )}
    </button>
  );
}

/** An orphan tool result (no matching call) - rare; show it plainly. */
function ToolResBlock({ v }: { v: string }) {
  const [open, setOpen] = useState(false);
  const preview = v.length > 220 ? v.slice(0, 220) + "…" : v;
  return (
    <button
      onClick={() => setOpen((o) => !o)}
      className="my-1 block w-full border-l border-zinc-800 pl-2.5 text-left transition-colors hover:border-zinc-600"
    >
      <span className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-zinc-400">
        {open ? v : preview}
      </span>
    </button>
  );
}

/** A supervisor status line (loop start, compaction, rotation). */
function MetaLine({ text }: { text: string }) {
  return (
    <div className="my-2 flex items-start gap-1.5 px-1 text-[11px] leading-relaxed text-zinc-500">
      <Sparkles size={11} className="mt-0.5 shrink-0 text-zinc-600" />
      <span>{text}</span>
    </div>
  );
}

/** Each event is its own action card. Tool results merge into their tool call;
 * `turn` markers are dropped (they aren't actions). */
function renderEvents(events: Ev[]) {
  const out: ReactNode[] = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    switch (ev.k) {
      case "turn":
        break; // not an action - the model tag lives on nothing now
      case "say":
        out.push(
          <div
            key={i}
            className="my-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-white"
          >
            {ev.v}
          </div>
        );
        break;
      case "think":
        out.push(<Thought key={i} text={ev.v} />);
        break;
      case "tool": {
        const next = events[i + 1];
        const result = next && next.k === "toolres" ? next.v : undefined;
        if (result) i++; // fold the result into this card
        out.push(<ToolBlock key={i} v={ev.v} result={result} />);
        break;
      }
      case "toolres":
        out.push(<ToolResBlock key={i} v={ev.v} />);
        break;
      case "meta":
        out.push(<MetaLine key={i} text={ev.v} />);
        break;
      case "err":
        out.push(
          <div
            key={i}
            className="my-1 flex items-start gap-1.5 rounded-md border border-red-900/60 bg-red-950/30 px-2 py-1 text-[12px] leading-relaxed text-red-300"
          >
            <TriangleAlert size={12} className="mt-0.5 shrink-0" />
            <span className="whitespace-pre-wrap break-words">{ev.v}</span>
          </div>
        );
        break;
    }
  }
  return out;
}

/**
 * Cursor-style Agent panel: streams the never-stop loop's clean transcript
 * (~/.tabs/agent-thinking.jsonl) as readable chat blocks - assistant messages,
 * collapsible reasoning, tool calls, results, and turn dividers - with a
 * slash-command message box. No shell, no raw log.
 */
export function AgentSidebar({ profileId, active }: AgentSidebarProps) {
  const [events, setEvents] = useState<Ev[]>([]);
  const [cmd, setCmd] = useState("");
  const [sel, setSel] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const atBottom = useRef(true);

  // Cursor-style: the box grows with the text (capped by max-h) and shrinks back.
  function autoGrow(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  const showMenu = /^\/\S*$/.test(cmd);
  const matches = useMemo(
    () => (showMenu ? SLASH_COMMANDS.filter((c) => c.cmd.startsWith(cmd.toLowerCase())) : []),
    [showMenu, cmd]
  );
  const selIdx = matches.length ? Math.min(sel, matches.length - 1) : 0;

  function choose(c: (typeof SLASH_COMMANDS)[number]) {
    if (c.takesArg) setCmd(c.cmd + " ");
    else send(c.cmd);
  }

  useEffect(() => {
    setEvents([]);
    // `tail -F` on the VM replays the whole transcript whenever the file is
    // rotated/recreated (loop restarts, log caps) - dedup on the event
    // timestamp so replays never double the feed.
    const seen = new Set<string>();
    const off = api().onThinkingLine(({ profileId: pid, line }) => {
      if (pid !== profileId) return;
      const s = line.trim();
      if (!s || s[0] !== "{") return;
      let ev: Ev;
      try {
        ev = JSON.parse(s);
      } catch {
        return;
      }
      if (!ev || !ev.k) return;
      const key = `${ev.t ?? ""}|${ev.k}|${ev.v.length}`;
      if (seen.has(key)) return;
      seen.add(key);
      setEvents((prev) => {
        const next = prev.length > 4000 ? prev.slice(-3000) : prev.slice();
        next.push(ev);
        return next;
      });
    });
    api().startThinking(profileId);
    return () => {
      off();
      api().stopThinking(profileId);
    };
  }, [profileId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  function onScroll() {
    const el = scrollRef.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }

  async function send(text: string) {
    const t = text.trim();
    if (!t) return;
    setCmd("");
    setSel(0);
    atBottom.current = true;
    if (inputRef.current) inputRef.current.style.height = "auto";
    await api().sendToAgent(profileId, t).catch(() => {});
  }

  return (
    <div className="flex h-full flex-col border-l border-zinc-800 bg-[#181818]">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-zinc-800 px-3 py-2.5">
        <Bot size={14} className="text-zinc-400" />
        <span className="text-[13px] font-semibold text-zinc-100">Agent</span>
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {events.length === 0 ? (
          <div className="mt-10 flex flex-col items-center gap-2 text-center">
            <Bot size={20} className="text-zinc-700" />
            <div className="text-[12px] text-zinc-600">Waiting for the agent to start…</div>
          </div>
        ) : (
          renderEvents(events)
        )}
      </div>

      <div className="relative shrink-0 border-t border-zinc-800 px-2 pt-2 pb-4">
        {showMenu && matches.length > 0 && (
          <div className="absolute bottom-full left-2 right-2 mb-1 overflow-hidden rounded-lg border border-zinc-700 bg-[#1e1e1e] shadow-xl">
            <div className="border-b border-zinc-800 px-3 py-1.5 text-[10px] uppercase tracking-wide text-zinc-500">
              Commands
            </div>
            {matches.map((c, i) => (
              <button
                key={c.cmd}
                onMouseEnter={() => setSel(i)}
                onClick={() => choose(c)}
                className={cn(
                  "flex w-full items-baseline gap-2 px-3 py-1.5 text-left transition-colors",
                  i === selIdx ? "bg-zinc-800" : "hover:bg-zinc-800/60"
                )}
              >
                <code className="shrink-0 font-mono text-xs text-zinc-200">{c.cmd}</code>
                <span className="truncate text-[11px] text-zinc-500">{c.desc}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-1.5 rounded-lg border border-[#535757] bg-[#2a2a2a] px-2.5 py-2">
          <textarea
            ref={inputRef}
            rows={1}
            autoFocus={active}
            value={cmd}
            onChange={(e) => {
              setCmd(e.target.value);
              setSel(0);
              autoGrow(e.currentTarget);
            }}
            onKeyDown={(e) => {
              if (showMenu && matches.length) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSel((s) => (s + 1) % matches.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSel((s) => (s - 1 + matches.length) % matches.length);
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  choose(matches[selIdx]);
                  return;
                }
              } else if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(cmd);
              }
            }}
            placeholder="Message the agent - type / for commands"
            className="max-h-40 min-w-0 flex-1 resize-none bg-transparent text-[12.5px] leading-relaxed text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
          />
          <button
            onClick={() => send(cmd)}
            disabled={!cmd.trim()}
            className={cn(
              "flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors",
              cmd.trim() ? "bg-zinc-200 text-zinc-900 hover:bg-white" : "text-zinc-600"
            )}
          >
            <Send size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}
