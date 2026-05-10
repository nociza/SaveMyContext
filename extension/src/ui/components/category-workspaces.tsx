import { ArrowRight, BookOpen, GitBranch, Lightbulb, MapPin, Network, Tags, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import {
  displayPileLabel,
  formatCompactDate,
  providerLabels,
  titleFromSession,
  type PileWorkspaceView
} from "../../shared/explorer";
import type {
  BackendFactualBacklogItem,
  BackendFactualLinkedSource,
  BackendIdeaEvolutionNode,
  BackendJournalGroup,
  BackendJournalTimelineItem,
  BackendPileViews,
  BackendSessionListItem,
  BuiltInPileSlug
} from "../../shared/types";
import { Badge } from "./badge";
import { Button } from "./button";
import { ScrollArea } from "./scroll-area";

type FocusHandler = (label: string, sessionIds: string[], nextView?: PileWorkspaceView) => void;

type CategoryWorkspaceProps = {
  pile: BuiltInPileSlug;
  view: PileWorkspaceView;
  views: BackendPileViews | null;
  sessions: BackendSessionListItem[];
  loading: boolean;
  onFocus: FocusHandler;
};

function groupDates(group: BackendJournalGroup): string {
  const dates = group.dates ?? [];
  return dates.length ? dates.slice(-3).join(", ") : `${group.count} notes`;
}

function sessionTitle(sessionId: string, sessions: BackendSessionListItem[]): string {
  const session = sessions.find((item) => item.id === sessionId);
  return session ? titleFromSession(session) : "Saved note";
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex h-full min-h-[320px] items-center justify-center rounded-[8px] border border-dashed border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-6 text-sm text-[var(--color-ink-soft)]">
      {label}
    </div>
  );
}

function GroupList({
  title,
  groups,
  icon: Icon,
  onFocus
}: {
  title: string;
  groups: BackendJournalGroup[];
  icon: LucideIcon;
  onFocus: FocusHandler;
}) {
  return (
    <section className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-[var(--color-ink-subtle)]" />
          <div className="text-sm font-semibold text-[var(--color-ink)]">{title}</div>
        </div>
        <Badge tone="neutral">{groups.length}</Badge>
      </div>
      <div className="space-y-2">
        {groups.slice(0, 10).map((group) => {
          const sessionIds = group.session_ids ?? [];
          const snippet = (group.snippets ?? [])[0];
          return (
            <button
              key={group.label}
              type="button"
              onClick={() => onFocus(group.label, sessionIds)}
              className="w-full rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] p-2.5 text-left transition hover:bg-[var(--color-paper-sunken)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-[var(--color-ink)]">{group.label}</div>
                  <div className="mt-1 text-xs uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">{groupDates(group)}</div>
                </div>
                <Badge tone="info">{group.count}</Badge>
              </div>
              {snippet ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-[var(--color-ink-soft)]">{snippet}</p> : null}
            </button>
          );
        })}
        {!groups.length ? <p className="text-sm text-[var(--color-ink-soft)]">No extracted entries yet.</p> : null}
      </div>
    </section>
  );
}

function JournalTimeline({
  items,
  sessions,
  onFocus
}: {
  items: BackendJournalTimelineItem[];
  sessions: BackendSessionListItem[];
  onFocus: FocusHandler;
}) {
  if (!items.length) {
    return <EmptyState label="Journal entries will appear here as a daily progression." />;
  }
  return (
    <ScrollArea className="h-full min-h-[360px] pr-4">
      <div className="relative space-y-3 pl-5">
        <div className="absolute bottom-2 left-2 top-2 w-px bg-[var(--color-line-strong)]" />
        {items.map((item) => {
          const labels = [...(item.people ?? []), ...(item.locations ?? []), ...(item.activities ?? [])];
          return (
            <button
              key={item.session_id}
              type="button"
              onClick={() => onFocus(item.title || sessionTitle(item.session_id, sessions), [item.session_id])}
              className="relative w-full rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] p-3 text-left transition hover:border-[var(--color-line-strong)] hover:bg-[var(--color-paper-sunken)]"
            >
              <span className="absolute -left-[17px] top-4 h-2.5 w-2.5 rounded-full border-2 border-[var(--color-paper-raised)] bg-[var(--color-journal)]" />
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-soft)]">
                    {item.occurred_on || formatCompactDate(item.updated_at)}
                  </div>
                  <div className="mt-1 truncate text-base font-semibold text-[var(--color-ink)]">{item.title || sessionTitle(item.session_id, sessions)}</div>
                </div>
                {item.mood ? <Badge tone="neutral">{item.mood}</Badge> : null}
              </div>
              <p className="mt-2 line-clamp-3 text-sm leading-6 text-[var(--color-ink-soft)]">{item.entry}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {labels.slice(0, 6).map((label) => (
                  <span key={label} className="rounded-full border border-[var(--color-line)] px-2 py-0.5 text-[11px] text-[var(--color-ink-soft)]">
                    {label}
                  </span>
                ))}
              </div>
            </button>
          );
        })}
      </div>
    </ScrollArea>
  );
}

function JournalWorkspace({ view, views, sessions, loading, onFocus }: CategoryWorkspaceProps) {
  const journal = views?.journal;
  if (loading && !journal) {
    return <EmptyState label="Loading journal views..." />;
  }
  if (!journal) {
    return <EmptyState label="No journal view data is available yet." />;
  }
  const timeline = journal.timeline ?? [];
  const locations = journal.locations ?? [];
  const people = journal.people ?? [];
  const entities = journal.entities ?? [];
  const activities = journal.activities ?? [];
  if (view === "story") {
    return (
      <div className="grid h-full min-h-0 gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-4">
          <div className="mb-4 flex items-center gap-2">
            <MapPin className="h-4 w-4 text-[var(--color-ink-subtle)]" />
            <div className="text-sm font-semibold text-[var(--color-ink)]">Travel and place progression</div>
          </div>
          <ScrollArea className="h-[min(62vh,560px)] pr-4">
            <div className="grid gap-3">
              {timeline
                .filter((item) => (item.travel_path ?? []).length || (item.locations ?? []).length)
                .map((item) => {
                  const travelPath = item.travel_path ?? [];
                  const places = travelPath.length ? travelPath : (item.locations ?? []);
                  return (
                    <button
                      key={item.session_id}
                      type="button"
                      onClick={() => onFocus(item.title || sessionTitle(item.session_id, sessions), [item.session_id], "story")}
                      className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] p-3 text-left transition hover:bg-[var(--color-paper-sunken)]"
                    >
                      <div className="text-xs uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">{item.occurred_on || formatCompactDate(item.updated_at)}</div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {places.map((place, index) => (
                          <span key={`${place}:${index}`} className="flex items-center gap-2">
                            <span className="rounded-full border border-[var(--color-line)] bg-[var(--color-paper-sunken)] px-2.5 py-1 text-xs font-semibold text-[var(--color-ink)]">
                              {place}
                            </span>
                            {index < places.length - 1 ? <ArrowRight className="h-3 w-3 text-[var(--color-ink-subtle)]" /> : null}
                          </span>
                        ))}
                      </div>
                    </button>
                  );
                })}
              {!locations.length ? <p className="text-sm text-[var(--color-ink-soft)]">Locations are extracted when the journal mentions places.</p> : null}
            </div>
          </ScrollArea>
        </section>
        <GroupList title="Places" groups={locations} icon={MapPin} onFocus={onFocus} />
      </div>
    );
  }
  if (view === "ops") {
    return (
      <div className="grid h-full min-h-0 gap-3 xl:grid-cols-3">
        <GroupList title="People" groups={people} icon={Users} onFocus={onFocus} />
        <GroupList title="Entities" groups={entities} icon={Network} onFocus={onFocus} />
        <GroupList title="Items and activities" groups={activities} icon={Tags} onFocus={onFocus} />
      </div>
    );
  }
  return <JournalTimeline items={timeline} sessions={sessions} onFocus={onFocus} />;
}

function relationTone(relation: string): "neutral" | "success" | "warning" | "danger" | "info" {
  if (relation === "counters") return "danger";
  if (relation === "validates") return "success";
  if (relation === "builds_on") return "info";
  return "neutral";
}

function IdeaCard({
  node,
  onFocus
}: {
  node: BackendIdeaEvolutionNode;
  onFocus: FocusHandler;
}) {
  const claims = node.claims ?? [];
  return (
    <button
      type="button"
      onClick={() => onFocus(node.core_idea, [node.session_id])}
      className="w-full rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] p-3 text-left transition hover:border-[var(--color-line-strong)] hover:bg-[var(--color-paper-sunken)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">
            {node.thread || "Unthreaded"} · {formatCompactDate(node.updated_at)}
          </div>
          <div className="mt-1 text-sm font-semibold leading-5 text-[var(--color-ink)]">{node.core_idea}</div>
        </div>
        {node.provider ? <Badge tone="neutral">{providerLabels[node.provider]}</Badge> : null}
      </div>
      <div className="mt-3 space-y-1.5">
        {claims.slice(0, 3).map((claim, index) => (
          <div key={`${claim.attributed_to}:${index}`} className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] px-2 py-1.5 text-xs leading-5 text-[var(--color-ink-soft)]">
            <span className="font-semibold text-[var(--color-ink)]">{claim.attributed_to}</span> · {claim.stance}: {claim.idea}
          </div>
        ))}
      </div>
    </button>
  );
}

function IdeaWorkspace({ view, views, loading, onFocus }: CategoryWorkspaceProps) {
  const ideas = views?.ideas;
  if (loading && !ideas) {
    return <EmptyState label="Loading idea evolution..." />;
  }
  if (!ideas) {
    return <EmptyState label="No idea evolution data is available yet." />;
  }
  const nodes = ideas.nodes ?? [];
  const edges = ideas.edges ?? [];
  const threads = ideas.threads ?? [];
  const contributors = ideas.contributors ?? [];
  const facts = ideas.facts ?? [];
  if (view === "story") {
    return (
      <div className="grid h-full min-h-0 gap-3 xl:grid-cols-3">
        <GroupList title="Threads" groups={threads} icon={GitBranch} onFocus={onFocus} />
        <GroupList title="Contributors" groups={contributors} icon={Users} onFocus={onFocus} />
        <GroupList title="Grounding facts" groups={facts} icon={BookOpen} onFocus={onFocus} />
      </div>
    );
  }
  if (view === "ops") {
    return (
      <div className="grid h-full min-h-0 gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-3">
          <div className="mb-3 text-sm font-semibold text-[var(--color-ink)]">Attributed claims</div>
          <ScrollArea className="h-[min(62vh,560px)] pr-4">
            <div className="grid gap-2">
              {nodes.map((node) => <IdeaCard key={node.id} node={node} onFocus={onFocus} />)}
              {!nodes.length ? <p className="text-sm text-[var(--color-ink-soft)]">No attributed ideas have been extracted yet.</p> : null}
            </div>
          </ScrollArea>
        </section>
        <section className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-3">
          <div className="mb-3 text-sm font-semibold text-[var(--color-ink)]">Validates and counters</div>
          <div className="space-y-2">
            {edges.map((edge) => {
              const source = nodes.find((node) => node.id === edge.source);
              const target = nodes.find((node) => node.id === edge.target);
              return (
                <button
                  key={edge.id}
                  type="button"
                  onClick={() => onFocus(edge.label || edge.relation, edge.session_ids, "ops")}
                  className="w-full rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] p-2 text-left transition hover:bg-[var(--color-paper-sunken)]"
                >
                  <Badge tone={relationTone(edge.relation)}>{edge.relation.replace("_", " ")}</Badge>
                  <div className="mt-2 text-xs leading-5 text-[var(--color-ink-soft)]">
                    {source?.core_idea || "Idea"} {"->"} {target?.core_idea || "Idea"}
                  </div>
                </button>
              );
            })}
            {!edges.length ? <p className="text-sm text-[var(--color-ink-soft)]">Relations appear when ideas share a thread or explicitly reference each other.</p> : null}
          </div>
        </section>
      </div>
    );
  }

  const threadLabels = threads.length ? threads.map((thread) => thread.label) : ["Unthreaded"];
  return (
    <ScrollArea className="h-full min-h-[360px] pr-4">
      <div className="grid gap-4">
        {threadLabels.map((thread) => {
          const threadNodes = nodes.filter((node) => (node.thread || "Unthreaded") === thread);
          return (
            <section key={thread} className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Lightbulb className="h-4 w-4 text-[var(--color-ink-subtle)]" />
                  <div className="text-sm font-semibold text-[var(--color-ink)]">{thread}</div>
                </div>
                <Badge tone="info">{threadNodes.length}</Badge>
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {threadNodes.map((node) => <IdeaCard key={node.id} node={node} onFocus={onFocus} />)}
              </div>
            </section>
          );
        })}
        {!nodes.length ? <EmptyState label="Ideas will appear here as evolution threads." /> : null}
      </div>
    </ScrollArea>
  );
}

function LinkedSourceList({
  items,
  onFocus
}: {
  items: BackendFactualLinkedSource[];
  onFocus: FocusHandler;
}) {
  return (
    <div className="space-y-2">
      {items.slice(0, 12).map((item) => {
        const matchedTerms = item.matched_terms ?? [];
        return (
          <button
            key={item.session_id}
            type="button"
            onClick={() => onFocus(item.title || "Linked source", [item.session_id])}
            className="w-full rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] p-2.5 text-left transition hover:bg-[var(--color-paper-sunken)]"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-[var(--color-ink)]">{item.title || "Linked source"}</div>
                <div className="mt-1 text-xs uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">
                  {displayPileLabel(item.pile_slug)}{item.provider ? ` · ${providerLabels[item.provider]}` : ""}
                </div>
              </div>
              <Badge tone="neutral">{matchedTerms.length}</Badge>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {matchedTerms.slice(0, 5).map((term) => (
                <span key={term} className="rounded-full border border-[var(--color-line)] px-2 py-0.5 text-[11px] text-[var(--color-ink-soft)]">{term}</span>
              ))}
            </div>
          </button>
        );
      })}
      {!items.length ? <p className="text-sm text-[var(--color-ink-soft)]">Links appear when ideas or journal entries mention a stored factual term.</p> : null}
    </div>
  );
}

function FactualItem({
  item,
  onFocus
}: {
  item: BackendFactualBacklogItem;
  onFocus: FocusHandler;
}) {
  const labels = [...(item.keywords ?? []), ...(item.entities ?? [])];
  return (
    <button
      type="button"
      onClick={() => onFocus(item.title || "Factual note", [item.session_id])}
      className="w-full rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-raised)] p-3 text-left transition hover:border-[var(--color-line-strong)] hover:bg-[var(--color-paper-sunken)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-[0.08em] text-[var(--color-ink-soft)]">
            Learned {item.learned_on || formatCompactDate(item.updated_at)}
          </div>
          <div className="mt-1 truncate text-base font-semibold text-[var(--color-ink)]">{item.title || "Factual note"}</div>
        </div>
        <Badge tone="info">{item.triplet_count} facts</Badge>
      </div>
      {item.summary || item.context ? <p className="mt-2 line-clamp-2 text-sm leading-6 text-[var(--color-ink-soft)]">{item.summary || item.context}</p> : null}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {labels.slice(0, 8).map((label) => (
          <span key={label} className="rounded-full border border-[var(--color-line)] px-2 py-0.5 text-[11px] text-[var(--color-ink-soft)]">
            {label}
          </span>
        ))}
      </div>
    </button>
  );
}

function FactualWorkspace({ view, views, loading, onFocus }: CategoryWorkspaceProps) {
  const factual = views?.factual;
  if (loading && !factual) {
    return <EmptyState label="Loading factual backlog..." />;
  }
  if (!factual) {
    return <EmptyState label="No factual backlog data is available yet." />;
  }
  const backlog = factual.backlog ?? [];
  const linkedSources = factual.linked_sources ?? [];
  const keywords = factual.keywords ?? [];
  const entities = factual.entities ?? [];
  if (view === "story") {
    const linkedBacklog = backlog.filter((item) => (item.linked_from ?? []).length);
    return (
      <div className="grid h-full min-h-0 gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-3">
          <div className="mb-3 text-sm font-semibold text-[var(--color-ink)]">Facts with links from other piles</div>
          <ScrollArea className="h-[min(62vh,560px)] pr-4">
            <div className="space-y-2">
              {linkedBacklog.map((item) => <FactualItem key={item.session_id} item={item} onFocus={onFocus} />)}
              {!linkedBacklog.length ? <p className="text-sm text-[var(--color-ink-soft)]">No cross-pile links have been detected yet.</p> : null}
            </div>
          </ScrollArea>
        </section>
        <section className="rounded-[8px] border border-[var(--color-line)] bg-[var(--color-paper-sunken)] p-3">
          <div className="mb-3 text-sm font-semibold text-[var(--color-ink)]">Linked from</div>
          <LinkedSourceList items={linkedSources} onFocus={onFocus} />
        </section>
      </div>
    );
  }
  if (view === "ops") {
    return (
      <div className="grid h-full min-h-0 gap-3 xl:grid-cols-2">
        <GroupList
          title="Keywords"
          icon={Tags}
          groups={keywords.map((item) => ({ label: item.label, count: item.count, session_ids: [], dates: [], snippets: [] }))}
          onFocus={(label) => onFocus(label, backlog.filter((item) => (item.keywords ?? []).includes(label)).map((item) => item.session_id), "ops")}
        />
        <GroupList
          title="Entities"
          icon={BookOpen}
          groups={entities.map((item) => ({ label: item.label, count: item.count, session_ids: [], dates: [], snippets: [] }))}
          onFocus={(label) => onFocus(label, backlog.filter((item) => (item.entities ?? []).includes(label)).map((item) => item.session_id), "ops")}
        />
      </div>
    );
  }
  return (
    <ScrollArea className="h-full min-h-[360px] pr-4">
      <div className="space-y-2">
        {backlog.map((item) => <FactualItem key={item.session_id} item={item} onFocus={onFocus} />)}
        {!backlog.length ? <EmptyState label="Factual notes will appear here as a dated backlog." /> : null}
      </div>
    </ScrollArea>
  );
}

export function CategoryWorkspace(props: CategoryWorkspaceProps) {
  if (props.pile === "journal") return <JournalWorkspace {...props} />;
  if (props.pile === "ideas") return <IdeaWorkspace {...props} />;
  if (props.pile === "factual") return <FactualWorkspace {...props} />;
  return <EmptyState label="This pile uses its own workspace." />;
}
