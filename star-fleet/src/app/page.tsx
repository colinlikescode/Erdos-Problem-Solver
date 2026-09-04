"use client";

import { useState } from "react";
import type { SessionStatus } from "../lib/api";
import { cn } from "../lib/utils";
import { NewRunDialog } from "../components/NewTabForm";
import { AddProblemDialog } from "../components/AddProblemDialog";
import { EditorView } from "../components/EditorView";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { TabStrip } from "../components/TabStrip";
import { Dashboard } from "../components/Dashboard";
import { DASHBOARD, useMachines } from "./useMachines";

/** Main window: tab strip + dashboard + one persistent editor view per tab. */
export default function Home() {
  const m = useMachines();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [addProblemOpen, setAddProblemOpen] = useState(false);
  const [showAgent, setShowAgent] = useState(true);
  const [closePromptFor, setClosePromptFor] = useState<string | null>(null);
  const [deletePromptFor, setDeletePromptFor] = useState<string | null>(null);

  return (
    <div className="flex h-screen flex-col bg-zinc-950">
      <TabStrip
        openTabs={m.openTabs}
        activeTab={m.activeTab}
        profileById={m.profileById}
        states={m.states}
        showAgent={showAgent}
        onSelect={m.setActiveTab}
        onRequestClose={setClosePromptFor}
        onToggleAgent={() => setShowAgent((s) => !s)}
        onAddProblem={() => setAddProblemOpen(true)}
      />

      <div className="relative min-h-0 flex-1 bg-[#1a1a1a]">
        <div
          className={cn(
            "absolute inset-0 overflow-y-auto p-6",
            m.activeTab !== DASHBOARD && "invisible"
          )}
        >
          <Dashboard
            profiles={m.profiles}
            states={m.states}
            onAdd={() => setDialogOpen(true)}
            onOpen={m.requestOpen}
            onRename={m.renameProfile}
            onRemove={setDeletePromptFor}
          />
        </div>

        {/* Editor tabs - kept mounted so switching is instant and sessions persist */}
        {m.openTabs.map((id) => {
          const profile = m.profileById.get(id);
          const state = m.states[id] ?? { status: "idle" as SessionStatus, message: "" };
          if (!profile) return null;
          return (
            <div key={id} className={cn("absolute inset-0", m.activeTab !== id && "invisible")}>
              <EditorView
                profile={profile}
                status={state.status}
                message={state.message}
                logs={m.logs[id] ?? []}
                onRetry={() => m.connect(id)}
                active={m.activeTab === id}
                showAgent={showAgent}
              />
            </div>
          );
        })}
      </div>

      {dialogOpen && (
        <NewRunDialog
          problems={m.problems}
          onClose={() => setDialogOpen(false)}
          onCreate={async (input) => {
            await m.createRun(input);
            setDialogOpen(false);
          }}
        />
      )}
      {addProblemOpen && (
        <AddProblemDialog
          onClose={() => setAddProblemOpen(false)}
          onAdd={m.addProblem}
        />
      )}
      {closePromptFor && (
        <ConfirmDialog
          title="Close this tab?"
          body={
            <>
              This disconnects{" "}
              <span className="text-zinc-200">
                {m.profileById.get(closePromptFor)?.name ?? "this machine"}
              </span>{" "}
              from Star Fleet. Your agents keep running in tmux on the machine - you can
              reopen the tab to pick them back up.
            </>
          }
          confirmLabel="Close tab"
          onConfirm={() => {
            m.closeTab(closePromptFor);
            setClosePromptFor(null);
          }}
          onCancel={() => setClosePromptFor(null)}
        />
      )}
      {deletePromptFor && (
        <ConfirmDialog
          title="Delete this run?"
          body={
            <>
              This permanently destroys the DigitalOcean droplet for{" "}
              <span className="text-zinc-200">
                {m.profileById.get(deletePromptFor)?.name ?? "this run"}
              </span>{" "}
              and removes it from Star Fleet. All work on that VM is lost - Save to R2 first
              if you want to keep it. This cannot be undone.
            </>
          }
          confirmLabel="Delete run + droplet"
          onConfirm={() => {
            m.removeProfile(deletePromptFor);
            setDeletePromptFor(null);
          }}
          onCancel={() => setDeletePromptFor(null)}
        />
      )}
    </div>
  );
}
