"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ConnectionProfile, type CreateRunInput, type Problem, type SessionStatus } from "../lib/api";

export const DASHBOARD = "__dashboard__";
const MAX_LOG_LINES = 300;

export type SessionState = { status: SessionStatus; message: string };

const HEALTH_POLL_MS = 8000;

/**
 * All machine/tab state for the main window: profiles, open tabs, per-session
 * status + logs, and the callbacks the tab strip / dashboard / dialogs need.
 * Keeps `page.tsx` a pure composition of views.
 */
export function useMachines() {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string>(DASHBOARD);
  const [states, setStates] = useState<Record<string, SessionState>>({});
  const [logs, setLogs] = useState<Record<string, string[]>>({});
  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;
  const statesRef = useRef(states);
  statesRef.current = states;

  useEffect(() => {
    api().listProfiles().then(setProfiles);
    api().listProblems().then(setProblems);

    const offState = api().onSessionState(({ profileId, status, message }) => {
      setStates((prev) => ({ ...prev, [profileId]: { status, message: message ?? "" } }));
    });
    const offLog = api().onSessionLog(({ profileId, line }) => {
      setLogs((prev) => {
        const next = [...(prev[profileId] ?? []), line];
        return { ...prev, [profileId]: next.slice(-MAX_LOG_LINES) };
      });
    });
    return () => {
      offState();
      offLog();
    };
  }, []);

  // Passively poll host reachability for machines WITHOUT a live session, so
  // the dashboard dots go green/red on their own (spun-up VM comes online, old
  // VM dies). A tracked session's real status (connecting/provisioning/ready/
  // error) always wins - we never overwrite it, and we never provision here.
  const profileIds = useMemo(() => profiles.map((p) => p.id).join(","), [profiles]);
  useEffect(() => {
    if (!profileIds) return;
    const ids = profileIds.split(",");
    let cancelled = false;
    const LIVE = new Set<SessionStatus>(["connecting", "provisioning", "ready"]);
    const tick = async () => {
      await Promise.all(
        ids.map(async (id) => {
          if (LIVE.has(statesRef.current[id]?.status as SessionStatus)) return;
          const up = await api().pingHost(id).catch(() => false);
          if (cancelled) return;
          setStates((prev) => {
            if (LIVE.has(prev[id]?.status as SessionStatus)) return prev;
            const status: SessionStatus = up ? "disconnected" : "error";
            const message = up ? "Reachable - not connected" : "Unreachable";
            if (prev[id]?.status === status) return prev;
            return { ...prev, [id]: { status, message } };
          });
        })
      );
    };
    tick();
    const h = setInterval(tick, HEALTH_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(h);
    };
  }, [profileIds]);

  const connect = useCallback((id: string) => {
    setLogs((prev) => ({ ...prev, [id]: [] }));
    api()
      .open(id)
      .catch(() => {
        /* surfaced via session state */
      });
  }, []);

  const openMachine = useCallback(
    (id: string) => {
      if (!openTabsRef.current.includes(id)) setOpenTabs((prev) => [...prev, id]);
      setActiveTab(id);
      const st = states[id]?.status;
      if (st !== "ready" && st !== "connecting" && st !== "provisioning") connect(id);
    },
    [connect, states]
  );

  // Clicking Open: switch to an existing tab, else open + provision directly.
  // No folder picking - provisioning places the snapshot at ~/snapshot and the
  // editor opens there. (profile.remotePath already defaults to ~/snapshot.)
  const requestOpen = useCallback(
    (id: string) => {
      if (openTabsRef.current.includes(id)) {
        setActiveTab(id);
        return;
      }
      openMachine(id);
    },
    [openMachine]
  );

  // One-click run: spin up a droplet (new problem OR continue a saved run), and
  // open the tab so it auto-provisions + auto-starts the agent.
  const createRun = useCallback(
    async (input: CreateRunInput) => {
      const profile = await api().createRun(input);
      setProfiles((prev) => [...prev, profile]);
      openMachine(profile.id);
      return profile;
    },
    [openMachine]
  );

  const addProblem = useCallback(
    async (
      name: string,
      description: string,
      category?: import("../shared/types").ProblemCategory,
      sourceUrl?: string
    ) => {
      const problem = await api().addProblem(name, description, category, sourceUrl);
      setProblems((prev) => [...prev, problem]);
      return problem;
    },
    []
  );

  const removeProblem = useCallback((id: string) => {
    api().removeProblem(id);
    setProblems((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const removeProfile = useCallback((id: string) => {
    api().removeProfile(id);
    setProfiles((prev) => prev.filter((p) => p.id !== id));
    setOpenTabs((prev) => prev.filter((t) => t !== id));
    setActiveTab((cur) => (cur === id ? DASHBOARD : cur));
  }, []);

  const renameProfile = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    api().renameProfile(id, trimmed);
    setProfiles((prev) => prev.map((p) => (p.id === id ? { ...p, name: trimmed } : p)));
  }, []);

  const closeTab = useCallback((id: string) => {
    api().disconnect(id);
    setOpenTabs((prev) => {
      const idx = prev.indexOf(id);
      const next = prev.filter((t) => t !== id);
      setActiveTab((cur) => (cur === id ? (next[Math.min(idx, next.length - 1)] ?? DASHBOARD) : cur));
      return next;
    });
    setStates((prev) => {
      const { [id]: _gone, ...rest } = prev;
      return rest;
    });
  }, []);

  const profileById = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);

  return {
    profiles,
    problems,
    profileById,
    openTabs,
    activeTab,
    setActiveTab,
    states,
    logs,
    connect,
    requestOpen,
    createRun,
    addProblem,
    removeProblem,
    removeProfile,
    renameProfile,
    closeTab,
  };
}
