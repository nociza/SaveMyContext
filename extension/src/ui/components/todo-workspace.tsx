import { CheckCheck, ListTodo, Plus } from "lucide-react";

import type { BackendTodoItem, BackendTodoListRead } from "../../shared/types";
import { Button } from "./button";
import { Badge } from "./badge";
import { ScrollArea } from "./scroll-area";

function taskCardTone(done: boolean): string {
  return done
    ? "border-[var(--color-line)] bg-[var(--color-paper-sunken)]/80 text-[var(--color-ink-soft)]"
    : "border-[var(--color-line)] bg-[var(--color-paper-raised)] text-[var(--color-ink)] hover:border-[var(--color-line-strong)] hover:bg-[var(--color-paper-sunken)]";
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
  onInspectTask?: (item: BackendTodoItem) => void;
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
  onToggleTask,
  onInspectTask
}: TodoWorkspaceProps) {
  const items = todo?.items ?? [];
  const activeItems = items.filter((item) => !item.done);
  const completedItems = items.filter((item) => item.done);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { label: "Active tasks", value: String(todo?.active_count ?? 0), icon: ListTodo },
          { label: "Completed", value: String(todo?.completed_count ?? 0), icon: CheckCheck },
          { label: "Saved updates", value: String(taskUpdateCount), icon: ListTodo }
        ].map((metric) => (
          <div key={metric.label} className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-4">
            <metric.icon className="h-4 w-4 text-[var(--color-ink-subtle)]" />
            <div className="mt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">{metric.label}</div>
            <div className="mt-2 break-words text-2xl font-semibold text-[var(--color-ink)]">{metric.value}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4">
        <div className="space-y-4">
          <div className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-soft)]">Shared checklist</div>
                <div className="mt-1 text-lg font-semibold text-[var(--color-ink)]">Active and completed tasks</div>
              </div>
              <Badge tone={savingSummary ? "info" : "neutral"}>{savingSummary ? "Saving" : "Checklist"}</Badge>
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
                className="h-11 flex-1 rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] px-3 text-sm text-[var(--color-ink)] outline-none transition placeholder:text-[var(--color-ink-subtle)] focus:border-[var(--color-line-strong)]"
              />
              <Button type="submit" variant="primary">
                <Plus className="h-4 w-4" />
                Add task
              </Button>
            </form>

            <div className="mt-4 grid gap-4 xl:grid-cols-2">
              <section className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] p-3">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-[var(--color-ink)]">Active</div>
                  <Badge tone="info">{activeItems.length}</Badge>
                </div>
                <ScrollArea className="h-[min(40vh,360px)] pr-4">
                  <div className="space-y-2">
                    {activeItems.map((item) => (
                      <div
                        key={item.text}
                        className={`flex items-start gap-3 rounded-[8px] border px-3 py-3 transition ${taskCardTone(false)}`}
                      >
                        <input
                          type="checkbox"
                          checked={item.done}
                          onChange={(event) => onToggleTask(item, event.target.checked)}
                          className="mt-1 h-4 w-4 shrink-0 accent-emerald-600"
                        />
                        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onInspectTask?.(item)}>
                          <span className="break-words text-sm leading-6">{item.text}</span>
                          {item.account_label ? <span className="mt-1 block text-xs text-[var(--color-ink-soft)]">{item.account_label}</span> : null}
                        </button>
                      </div>
                    ))}
                    {!activeItems.length ? <p className="text-sm leading-6 text-[var(--color-ink-soft)]">No active tasks in the shared list.</p> : null}
                  </div>
                </ScrollArea>
              </section>

              <section className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] p-3">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-[var(--color-ink)]">Completed</div>
                  <Badge tone="neutral">{completedItems.length}</Badge>
                </div>
                <ScrollArea className="h-[min(40vh,360px)] pr-4">
                  <div className="space-y-2">
                    {completedItems.map((item) => (
                      <div
                        key={item.text}
                        className={`flex items-start gap-3 rounded-[8px] border px-3 py-3 transition ${taskCardTone(true)}`}
                      >
                        <input
                          type="checkbox"
                          checked={item.done}
                          onChange={(event) => onToggleTask(item, event.target.checked)}
                          className="mt-1 h-4 w-4 shrink-0 accent-emerald-600"
                        />
                        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onInspectTask?.(item)}>
                          <span className="break-words text-sm leading-6 line-through">{item.text}</span>
                          {item.account_label ? <span className="mt-1 block text-xs text-[var(--color-ink-soft)]">{item.account_label}</span> : null}
                        </button>
                      </div>
                    ))}
                    {!completedItems.length ? <p className="text-sm leading-6 text-[var(--color-ink-soft)]">Checked-off tasks stay here until you reopen them.</p> : null}
                  </div>
                </ScrollArea>
              </section>
            </div>
          </div>

          {error ? (
            <div className="rounded-[8px] border border-[var(--color-danger-line)] bg-[var(--color-danger-soft)] px-4 py-3 text-sm text-[var(--color-danger)]">{error}</div>
          ) : null}

          {loading ? (
            <div className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-5 text-sm text-[var(--color-ink-soft)]">Loading shared checklist…</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
