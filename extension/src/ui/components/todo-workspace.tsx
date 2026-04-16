import { CheckCheck, GitBranch, History, ListTodo, Plus } from "lucide-react";

import { formatCompactDate } from "../../shared/explorer";
import type { BackendTodoItem, BackendTodoListRead } from "../../shared/types";
import { Button } from "./button";
import { Badge } from "./badge";
import { ScrollArea } from "./scroll-area";

function gitSummary(todo: BackendTodoListRead | null): {
  label: string;
  tone: "neutral" | "success" | "warning" | "info";
  detail: string;
} {
  const git = todo?.git;
  if (!git?.versioning_enabled) {
    return {
      label: "Versioning off",
      tone: "neutral",
      detail: "Checklist changes still update the shared markdown file, but automatic commits are disabled."
    };
  }
  if (!git.available) {
    return {
      label: "Git unavailable",
      tone: "warning",
      detail: "The checklist still updates, but the backend machine cannot run git right now."
    };
  }
  if (!git.repository_ready) {
    return {
      label: "Tracking ready",
      tone: "info",
      detail: "The next checklist edit will initialize repository tracking for the shared list."
    };
  }
  if (git.clean === false) {
    return {
      label: "Pending changes",
      tone: "warning",
      detail: "The vault has uncommitted changes alongside the shared checklist."
    };
  }
  return {
    label: "Tracked",
    tone: "success",
    detail: "Checklist updates are committed into the knowledge vault automatically."
  };
}

function taskCardTone(done: boolean): string {
  return done
    ? "border-zinc-200 bg-zinc-50/80 text-zinc-500"
    : "border-zinc-200 bg-white text-zinc-900 hover:border-zinc-300 hover:bg-zinc-50";
}

type TodoWorkspaceProps = {
  todo: BackendTodoListRead | null;
  loading: boolean;
  error?: string | null;
  savingSummary?: string | null;
  taskUpdateCount: number;
  draft: string;
  onDraftChange: (value: string) => void;
  onAddTask: () => void;
  onToggleTask: (item: BackendTodoItem, done: boolean) => void;
};

export function TodoWorkspace({
  todo,
  loading,
  error,
  savingSummary,
  taskUpdateCount,
  draft,
  onDraftChange,
  onAddTask,
  onToggleTask
}: TodoWorkspaceProps) {
  const activeItems = todo?.items.filter((item) => !item.done) ?? [];
  const completedItems = todo?.items.filter((item) => item.done) ?? [];
  const git = gitSummary(todo);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "Active tasks", value: String(todo?.active_count ?? 0), icon: ListTodo },
          { label: "Completed", value: String(todo?.completed_count ?? 0), icon: CheckCheck },
          { label: "Update notes", value: String(taskUpdateCount), icon: History },
          { label: "Tracking", value: todo?.git.repository_ready ? (todo.git.branch ?? "Git on") : "Ready on edit", icon: GitBranch }
        ].map((metric) => (
          <div key={metric.label} className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4">
            <metric.icon className="h-4 w-4 text-zinc-400" />
            <div className="mt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">{metric.label}</div>
            <div className="mt-2 break-words text-2xl font-semibold text-zinc-950">{metric.value}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_320px]">
        <div className="space-y-4">
          <div className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-500">Shared checklist</div>
                <div className="mt-1 text-lg font-semibold text-zinc-950">Update the living to-do list directly</div>
              </div>
              <Badge tone={savingSummary ? "info" : git.tone}>{savingSummary ? "Saving" : git.label}</Badge>
            </div>

            <form
              className="mt-4 flex flex-col gap-2 sm:flex-row"
              onSubmit={(event) => {
                event.preventDefault();
                onAddTask();
              }}
            >
              <input
                type="text"
                value={draft}
                onChange={(event) => onDraftChange(event.target.value)}
                placeholder="Add a task that belongs on the shared checklist"
                className="h-11 flex-1 rounded-[8px] border border-zinc-200 bg-white px-3 text-sm outline-none transition focus:border-zinc-300"
              />
              <Button type="submit" variant="primary">
                <Plus className="h-4 w-4" />
                Add task
              </Button>
            </form>

            <div className="mt-4 grid gap-4 xl:grid-cols-2">
              <section className="rounded-[8px] border border-zinc-200 bg-white p-3">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-zinc-950">Active</div>
                  <Badge tone="info">{activeItems.length}</Badge>
                </div>
                <ScrollArea className="h-[min(40vh,360px)] pr-4">
                  <div className="space-y-2">
                    {activeItems.map((item) => (
                      <label
                        key={item.text}
                        className={`flex cursor-pointer items-start gap-3 rounded-[8px] border px-3 py-3 transition ${taskCardTone(false)}`}
                      >
                        <input
                          type="checkbox"
                          checked={item.done}
                          onChange={(event) => onToggleTask(item, event.target.checked)}
                          className="mt-1 h-4 w-4 shrink-0 accent-emerald-600"
                        />
                        <span className="break-words text-sm leading-6">{item.text}</span>
                      </label>
                    ))}
                    {!activeItems.length ? <p className="text-sm leading-6 text-zinc-500">No active tasks in the shared list.</p> : null}
                  </div>
                </ScrollArea>
              </section>

              <section className="rounded-[8px] border border-zinc-200 bg-white p-3">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-zinc-950">Completed</div>
                  <Badge tone="neutral">{completedItems.length}</Badge>
                </div>
                <ScrollArea className="h-[min(40vh,360px)] pr-4">
                  <div className="space-y-2">
                    {completedItems.map((item) => (
                      <label
                        key={item.text}
                        className={`flex cursor-pointer items-start gap-3 rounded-[8px] border px-3 py-3 transition ${taskCardTone(true)}`}
                      >
                        <input
                          type="checkbox"
                          checked={item.done}
                          onChange={(event) => onToggleTask(item, event.target.checked)}
                          className="mt-1 h-4 w-4 shrink-0 accent-emerald-600"
                        />
                        <span className="break-words text-sm leading-6 line-through">{item.text}</span>
                      </label>
                    ))}
                    {!completedItems.length ? <p className="text-sm leading-6 text-zinc-500">Checked-off tasks stay here until you reopen them.</p> : null}
                  </div>
                </ScrollArea>
              </section>
            </div>
          </div>

          {error ? (
            <div className="rounded-[8px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
          ) : null}

          {loading ? (
            <div className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-5 text-sm text-zinc-500">Loading shared checklist…</div>
          ) : null}
        </div>

        <div className="space-y-4">
          <div className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-500">Versioning</div>
                <div className="mt-1 text-base font-semibold text-zinc-950">How updates land</div>
              </div>
              <Badge tone={git.tone}>{git.label}</Badge>
            </div>
            <p className="mt-4 text-sm leading-6 text-zinc-600">{git.detail}</p>

            <div className="mt-4 grid gap-3">
              <div className="rounded-[8px] border border-zinc-200 bg-white p-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">Branch</div>
                <div className="mt-2 break-words text-sm font-semibold text-zinc-950">{todo?.git.branch ?? "Initialized on first tracked edit"}</div>
              </div>
              <div className="rounded-[8px] border border-zinc-200 bg-white p-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">Working tree</div>
                <div className="mt-2 text-sm font-semibold text-zinc-950">
                  {todo?.git.clean == null ? "Waiting for git status" : todo.git.clean ? "Clean" : "Pending changes"}
                </div>
              </div>
              <div className="rounded-[8px] border border-zinc-200 bg-white p-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">Latest commit</div>
                <div className="mt-2 break-words text-sm font-semibold text-zinc-950">
                  {todo?.git.last_commit_message ?? "No checklist commit yet"}
                </div>
                <div className="mt-1 text-xs text-zinc-500">{formatCompactDate(todo?.git.last_commit_at, "Waiting for the first commit")}</div>
              </div>
            </div>
          </div>

          <div className="rounded-[8px] border border-zinc-200 bg-zinc-50 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-500">Flow</div>
            <div className="mt-1 text-base font-semibold text-zinc-950">What changes when you click</div>
            <div className="mt-4 space-y-2 text-sm leading-6 text-zinc-600">
              <p>Each checkbox edit rewrites the shared checklist in the vault.</p>
              <p>Saved to-do notes below keep a readable history of why tasks changed.</p>
              <p>Search, provider filters, and note reader stay in sync with the shared list.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
