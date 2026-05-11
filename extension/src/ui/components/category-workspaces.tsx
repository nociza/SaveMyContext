import type { CSSProperties } from "react";

import { ArrowRight, BookOpen, CalendarDays, Compass, GitBranch, Lightbulb, MapPin, Milestone, Network, Route, Tags, Users } from "lucide-react";
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
  BackendIdeaEvolutionEdge,
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
  focusedProjectSlug?: string | null;
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

function shortDate(value?: string | null): string {
  if (!value) {
    return "No date";
  }
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function initialLetters(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {
    return "•";
  }
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
}

function uniqueValues(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function sortedIdeaNodes(nodes: BackendIdeaEvolutionNode[]): BackendIdeaEvolutionNode[] {
  return [...nodes].sort((left, right) => {
    const leftDate = left.updated_at ?? "";
    const rightDate = right.updated_at ?? "";
    return leftDate.localeCompare(rightDate) || ideaProjectLabel(left).localeCompare(ideaProjectLabel(right)) || left.core_idea.localeCompare(right.core_idea);
  });
}

function relationLabel(value: string): string {
  return value.replace(/[_-]+/g, " ");
}

function radialPosition(index: number, total: number, radius = 38): CSSProperties {
  const angle = -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(total, 1);
  return {
    left: `${50 + Math.cos(angle) * radius}%`,
    top: `${50 + Math.sin(angle) * radius}%`
  };
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
  onFocus,
  limit = 10
}: {
  title: string;
  groups: BackendJournalGroup[];
  icon: LucideIcon;
  onFocus: FocusHandler;
  limit?: number | null;
}) {
  const visibleGroups = limit === null ? groups : groups.slice(0, limit);
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
        {visibleGroups.map((group) => {
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
        {limit !== null && groups.length > visibleGroups.length ? (
          <p className="text-xs leading-5 text-[var(--color-ink-soft)]">{groups.length - visibleGroups.length} more entries refine with search or project focus.</p>
        ) : null}
        {!groups.length ? <p className="text-sm text-[var(--color-ink-soft)]">No extracted entries yet.</p> : null}
      </div>
    </section>
  );
}

function JournalDayTimeline({
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

  const featured = items[items.length - 1] ?? items[0];
  const featuredLabels = uniqueValues([...(featured.people ?? []), ...(featured.locations ?? []), ...(featured.activities ?? [])]);

  return (
    <div className="journal-daily-workspace">
      <div className="journal-day-strip" aria-label="Journal days">
        {items.map((item, index) => {
          const labels = uniqueValues([...(item.people ?? []), ...(item.locations ?? []), ...(item.activities ?? [])]);
          return (
            <button
              key={item.session_id}
              type="button"
              onClick={() => onFocus(item.title || sessionTitle(item.session_id, sessions), [item.session_id])}
              className="journal-day-card"
              style={{ "--day-index": index } as CSSProperties}
            >
              <span className="journal-day-date">{shortDate(item.occurred_on || item.updated_at)}</span>
              <span className="journal-day-title">{item.title || sessionTitle(item.session_id, sessions)}</span>
              <span className="journal-day-entry">{item.entry}</span>
              <span className="journal-day-meta">
                {item.mood ? `${item.mood} · ` : ""}
                {labels.slice(0, 3).join(" · ") || "Journal note"}
              </span>
            </button>
          );
        })}
      </div>

      <div className="journal-story-grid">
        <section className="journal-featured-day">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="eyebrow">Latest day</div>
              <h3>{featured.title || sessionTitle(featured.session_id, sessions)}</h3>
            </div>
            {featured.mood ? <Badge tone="neutral">{featured.mood}</Badge> : null}
          </div>
          <p>{featured.entry}</p>
          <div className="journal-chip-row">
            {featuredLabels.slice(0, 10).map((label) => (
              <button key={label} type="button" onClick={() => onFocus(label, [featured.session_id])}>
                {label}
              </button>
            ))}
          </div>
        </section>

        <section className="journal-vertical-rail">
          <div className="journal-rail-line" />
          {items.slice(-6).map((item) => (
            <button
              key={item.session_id}
              type="button"
              onClick={() => onFocus(item.title || sessionTitle(item.session_id, sessions), [item.session_id])}
              className="journal-rail-event"
            >
              <span className="journal-rail-dot" />
              <span>
                <strong>{shortDate(item.occurred_on || item.updated_at)}</strong>
                <em>{item.title || sessionTitle(item.session_id, sessions)}</em>
              </span>
            </button>
          ))}
        </section>
      </div>
    </div>
  );
}

function JournalPlaceMap({
  items,
  locations,
  sessions,
  onFocus
}: {
  items: BackendJournalTimelineItem[];
  locations: BackendJournalGroup[];
  sessions: BackendSessionListItem[];
  onFocus: FocusHandler;
}) {
  const placeNames = uniqueValues([
    ...items.flatMap((item) => {
      const path = item.travel_path?.length ? item.travel_path : item.locations;
      return path ?? [];
    }),
    ...locations.map((group) => group.label)
  ]).slice(0, 12);

  const placeByName = new Map(locations.map((group) => [group.label, group] as const));

  return (
    <div className="journal-place-workspace">
      <section className="journal-map-panel">
        <div className="journal-map-header">
          <div>
            <div className="eyebrow">Place map</div>
            <h3>{placeNames.length} places across {items.length} days</h3>
          </div>
          <Compass className="h-5 w-5 text-[var(--color-ink-subtle)]" />
        </div>
        <div className="journal-map-canvas">
          <div className="journal-map-grid" />
          {placeNames.map((place, index) => {
            const group = placeByName.get(place);
            return (
              <button
                key={place}
                type="button"
                className="journal-map-node"
                style={radialPosition(index, placeNames.length, placeNames.length > 6 ? 39 : 32)}
                onClick={() => onFocus(place, group?.session_ids ?? items.filter((item) => item.locations.includes(place) || item.travel_path.includes(place)).map((item) => item.session_id), "story")}
              >
                <MapPin className="h-3.5 w-3.5" />
                <span>{place}</span>
              </button>
            );
          })}
          <div className="journal-map-center">
            <Route className="h-5 w-5" />
            <span>Journal route</span>
          </div>
        </div>
      </section>

      <section className="journal-route-list">
        <div className="flex items-center gap-2">
          <Route className="h-4 w-4 text-[var(--color-ink-subtle)]" />
          <h3>Day routes</h3>
        </div>
        <ScrollArea className="mt-3 h-[min(54vh,520px)] pr-4">
          <div className="space-y-2">
            {items
              .filter((item) => (item.travel_path ?? []).length || (item.locations ?? []).length)
              .map((item) => {
                const places = item.travel_path?.length ? item.travel_path : item.locations;
                return (
                  <button
                    key={item.session_id}
                    type="button"
                    className="journal-route-card"
                    onClick={() => onFocus(item.title || sessionTitle(item.session_id, sessions), [item.session_id], "story")}
                  >
                    <span>{shortDate(item.occurred_on || item.updated_at)}</span>
                    <strong>{item.title || sessionTitle(item.session_id, sessions)}</strong>
                    <em>{places.join(" -> ")}</em>
                  </button>
                );
              })}
            {!placeNames.length ? <p className="text-sm text-[var(--color-ink-soft)]">No locations have been extracted yet.</p> : null}
          </div>
        </ScrollArea>
      </section>
    </div>
  );
}

function JournalPeopleBoard({
  people,
  entities,
  activities,
  items,
  onFocus
}: {
  people: BackendJournalGroup[];
  entities: BackendJournalGroup[];
  activities: BackendJournalGroup[];
  items: BackendJournalTimelineItem[];
  onFocus: FocusHandler;
}) {
  const visiblePeople = people.slice(0, 12);

  return (
    <div className="journal-people-workspace">
      <section className="journal-people-map">
        <div className="journal-map-header">
          <div>
            <div className="eyebrow">People timeline</div>
            <h3>{people.length} people mentioned</h3>
          </div>
          <Users className="h-5 w-5 text-[var(--color-ink-subtle)]" />
        </div>
        <div className="people-constellation">
          <div className="people-constellation-core">
            <Users className="h-5 w-5" />
            <span>Encounters</span>
          </div>
          {visiblePeople.map((person, index) => (
            <button
              key={person.label}
              type="button"
              className="person-orbit-node"
              style={radialPosition(index, visiblePeople.length, visiblePeople.length > 7 ? 40 : 33)}
              onClick={() => onFocus(person.label, person.session_ids, "ops")}
            >
              <span>{initialLetters(person.label)}</span>
              <strong>{person.label}</strong>
              <em>{person.count}</em>
            </button>
          ))}
        </div>
      </section>

      <section className="journal-encounter-panel">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-[var(--color-ink-subtle)]" />
          <h3>Recent encounters</h3>
        </div>
        <div className="journal-encounter-list">
          {items
            .filter((item) => item.people.length || item.activities.length)
            .slice(-7)
            .map((item) => (
              <button key={item.session_id} type="button" onClick={() => onFocus(item.title || "Journal note", [item.session_id], "ops")}>
                <span>{shortDate(item.occurred_on || item.updated_at)}</span>
                <strong>{item.people.slice(0, 3).join(", ") || item.title || "Journal note"}</strong>
                <em>{item.activities.slice(0, 3).join(" · ") || item.entry}</em>
              </button>
            ))}
        </div>
        <div className="journal-signal-columns">
          <GroupList title="Entities" groups={entities} icon={Network} onFocus={onFocus} />
          <GroupList title="Activities" groups={activities} icon={Tags} onFocus={onFocus} />
        </div>
      </section>
    </div>
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
    return <JournalPlaceMap items={timeline} locations={locations} sessions={sessions} onFocus={onFocus} />;
  }
  if (view === "ops") {
    return <JournalPeopleBoard people={people} entities={entities} activities={activities} items={timeline} onFocus={onFocus} />;
  }
  return <JournalDayTimeline items={timeline} sessions={sessions} onFocus={onFocus} />;
}

function relationTone(relation: string): "neutral" | "success" | "warning" | "danger" | "info" {
  if (relation === "counters") return "danger";
  if (relation === "validates") return "success";
  if (relation === "builds_on") return "info";
  return "neutral";
}

function ideaProjectLabel(node: BackendIdeaEvolutionNode): string {
  if (node.project_name) {
    return node.project_name;
  }
  if (node.project_slug) {
    return node.project_slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (value) => value.toUpperCase());
  }
  return "Unassigned";
}

function ideaProjectSlug(node: BackendIdeaEvolutionNode): string {
  return node.project_slug || ideaProjectLabel(node);
}

type IdeaMapPoint = {
  node: BackendIdeaEvolutionNode;
  x: number;
  y: number;
};

function ideaNodeSummary(node: BackendIdeaEvolutionNode): string {
  return node.reasoning_steps[0] || node.claims[0]?.idea || node.share_post || node.core_idea;
}

function IdeaInsightCard({
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
      className="idea-insight-card"
    >
      <span className="idea-card-kicker">{ideaProjectLabel(node)} · {node.thread || "Unthreaded"} · {formatCompactDate(node.updated_at)}</span>
      <strong>{node.core_idea}</strong>
      <span>{ideaNodeSummary(node)}</span>
      <div className="idea-card-footer">
        {node.provider ? <Badge tone="neutral">{providerLabels[node.provider]}</Badge> : null}
        {claims.length ? <Badge tone="info">{claims.length} claims</Badge> : null}
        {node.next_steps.length ? <Badge tone="neutral">{node.next_steps.length} next</Badge> : null}
      </div>
    </button>
  );
}

function ideaMapPoints(nodes: BackendIdeaEvolutionNode[], compact = false): IdeaMapPoint[] {
  const sorted = compact ? sortedIdeaNodes(nodes).slice(0, 10) : sortedIdeaNodes(nodes);
  const columns = compact ? 2 : sorted.length <= 4 ? 2 : 3;
  const rows = Math.max(1, Math.ceil(sorted.length / columns));
  const xMin = compact ? 44 : 38;
  const xMax = compact ? 82 : 86;
  const yMin = rows <= 2 ? 30 : 22;
  const yMax = rows <= 2 ? 72 : 88;

  return sorted.map((node, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const itemsInRow = Math.min(columns, sorted.length - row * columns);
    const centeredColumn = column + (columns - itemsInRow) / 2;
    const x = xMin + (centeredColumn * (xMax - xMin)) / (columns - 1);
    const y = rows === 1 ? 50 : yMin + (row * (yMax - yMin)) / (rows - 1);

    return {
      node,
      x,
      y
    };
  });
}

function IdeaMindMap({
  nodes,
  edges,
  projects,
  onFocus,
  compact = false
}: {
  nodes: BackendIdeaEvolutionNode[];
  edges: BackendIdeaEvolutionEdge[];
  projects: BackendJournalGroup[];
  onFocus: FocusHandler;
  compact?: boolean;
}) {
  const points = ideaMapPoints(nodes, compact);
  const pointById = new Map(points.map((point) => [point.node.id, point] as const));
  const hubX = compact ? 18 : 14;
  const projectLabels = (compact ? uniqueValues([
    ...projects.map((project) => project.label),
    ...nodes.map((node) => ideaProjectLabel(node))
  ]).slice(0, 4) : uniqueValues([
    ...projects.map((project) => project.label),
    ...nodes.map((node) => ideaProjectLabel(node))
  ]));
  const projectByLabel = new Map(projects.map((project) => [project.label, project] as const));
  const columns = compact ? 2 : points.length <= 4 ? 2 : 3;
  const rowCount = Math.max(1, Math.ceil(points.length / columns));
  const canvasHeight = compact
    ? Math.max(520, rowCount * 150 + 120)
    : Math.max(680, rowCount * 160 + 140, Math.max(projectLabels.length, 1) * 76 + 140);

  return (
    <section className={compact ? "idea-map-panel idea-map-panel--compact" : "idea-map-panel"}>
      <div className="idea-map-header">
        <div>
          <div className="eyebrow">Joined mind map</div>
          <h3>{nodes.length} ideas across {projectLabels.length || 1} projects</h3>
        </div>
        <GitBranch className="h-5 w-5 text-[var(--color-ink-subtle)]" />
      </div>
      <div className="idea-map-canvas" style={{ "--idea-map-height": `${canvasHeight}px` } as CSSProperties}>
        <svg className="idea-map-lines" viewBox="0 0 100 100" aria-hidden="true">
          {edges.slice(0, 24).map((edge) => {
            const source = pointById.get(edge.source);
            const target = pointById.get(edge.target);
            if (!source || !target) {
              return null;
            }
            return (
              <line
                key={edge.id}
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                className={`idea-map-link idea-map-link--${edge.relation}`}
              />
            );
          })}
          {points.map((point) => {
            const projectIndex = Math.max(projectLabels.indexOf(ideaProjectLabel(point.node)), 0);
            const hubY = 16 + projectIndex * (68 / Math.max(projectLabels.length, 1));
            return <line key={`hub:${point.node.id}`} x1={hubX} y1={hubY} x2={point.x} y2={point.y} className="idea-map-project-link" />;
          })}
        </svg>

        {projectLabels.map((project, index) => {
          const group = projectByLabel.get(project);
          return (
            <button
              key={project}
              type="button"
              className="idea-map-hub"
              style={{ left: `${hubX}%`, top: `${16 + index * (68 / Math.max(projectLabels.length, 1))}%` }}
              onClick={() => onFocus(project, group?.session_ids ?? nodes.filter((node) => ideaProjectLabel(node) === project).map((node) => node.session_id), "story")}
            >
              <Lightbulb className="h-3.5 w-3.5" />
              <span>{project}</span>
            </button>
          );
        })}

        {points.map((point) => (
          <button
            key={point.node.id}
            type="button"
            className="idea-map-node"
            style={{ left: `${point.x}%`, top: `${point.y}%` }}
            onClick={() => onFocus(point.node.core_idea, [point.node.session_id], "atlas")}
          >
            <span>{point.node.thread || "Idea"}</span>
            <strong>{point.node.core_idea}</strong>
          </button>
        ))}
      </div>
    </section>
  );
}

function IdeaEvolutionTimeline({
  nodes,
  edges,
  projects,
  onFocus
}: {
  nodes: BackendIdeaEvolutionNode[];
  edges: BackendIdeaEvolutionEdge[];
  projects: BackendJournalGroup[];
  onFocus: FocusHandler;
}) {
  const sorted = sortedIdeaNodes(nodes);
  if (!sorted.length) {
    return <EmptyState label="Ideas will appear here as an evolution timeline." />;
  }

  return (
    <div className="idea-evolution-workspace">
      <section className="idea-timeline-panel">
        <div className="idea-map-header">
          <div>
            <div className="eyebrow">Evolution timeline</div>
            <h3>{sorted.length} idea turns</h3>
          </div>
          <Milestone className="h-5 w-5 text-[var(--color-ink-subtle)]" />
        </div>
        <ScrollArea className="mt-3 h-[min(58vh,620px)] pr-4">
          <div className="idea-evolution-rail">
            {sorted.map((node, index) => (
              <button
                key={node.id}
                type="button"
                className="idea-evolution-step"
                style={{ "--step-index": index } as CSSProperties}
                onClick={() => onFocus(node.core_idea, [node.session_id], "atlas")}
              >
                <span className="idea-step-date">{shortDate(node.updated_at)}</span>
                <span className="idea-step-project">{ideaProjectLabel(node)} · {node.thread || "Unthreaded"}</span>
                <strong>{node.core_idea}</strong>
                <em>{ideaNodeSummary(node)}</em>
              </button>
            ))}
          </div>
        </ScrollArea>
      </section>

      <IdeaMindMap nodes={nodes} edges={edges} projects={projects} onFocus={onFocus} compact />
    </div>
  );
}

function IdeaAttributionBoard({
  nodes,
  edges,
  facts,
  onFocus
}: {
  nodes: BackendIdeaEvolutionNode[];
  edges: BackendIdeaEvolutionEdge[];
  facts: BackendJournalGroup[];
  onFocus: FocusHandler;
}) {
  const claims = nodes.flatMap((node) =>
    node.claims.map((claim, index) => ({
      id: `${node.id}:${index}`,
      node,
      claim
    }))
  );
  const nextSteps = nodes.flatMap((node) => node.next_steps.map((step) => ({ node, step })));

  return (
    <div className="idea-attribution-workspace">
      <section className="idea-claims-panel">
        <div className="idea-map-header">
          <div>
            <div className="eyebrow">Claims</div>
            <h3>{claims.length} attributed positions</h3>
          </div>
          <Users className="h-5 w-5 text-[var(--color-ink-subtle)]" />
        </div>
        <ScrollArea className="mt-3 h-[min(58vh,620px)] pr-4">
          <div className="idea-claim-stack">
            {claims.map(({ id, node, claim }) => (
              <button key={id} type="button" onClick={() => onFocus(claim.idea, [node.session_id], "ops")}>
                <span>{claim.attributed_to} · {claim.stance}</span>
                <strong>{claim.idea}</strong>
                {claim.evidence ? <em>{claim.evidence}</em> : null}
              </button>
            ))}
            {!claims.length ? <p className="text-sm text-[var(--color-ink-soft)]">No attributed claims have been extracted yet.</p> : null}
          </div>
        </ScrollArea>
      </section>

      <section className="idea-relation-panel">
        <div className="idea-map-header">
          <div>
            <div className="eyebrow">Relations</div>
            <h3>{edges.length} idea links</h3>
          </div>
          <Network className="h-5 w-5 text-[var(--color-ink-subtle)]" />
        </div>
        <div className="idea-relation-stream">
          {edges.map((edge) => {
            const source = nodes.find((node) => node.id === edge.source);
            const target = nodes.find((node) => node.id === edge.target);
            return (
              <button key={edge.id} type="button" onClick={() => onFocus(edge.label || edge.relation, edge.session_ids, "ops")}>
                <Badge tone={relationTone(edge.relation)}>{relationLabel(edge.relation)}</Badge>
                <strong>{source?.core_idea || "Idea"}</strong>
                <ArrowRight className="h-3.5 w-3.5" />
                <span>{target?.core_idea || "Idea"}</span>
              </button>
            );
          })}
          {!edges.length ? <p className="text-sm text-[var(--color-ink-soft)]">Relations appear when ideas build on, validate, or counter each other.</p> : null}
        </div>
      </section>

      <section className="idea-next-panel">
        <div className="idea-map-header">
          <div>
            <div className="eyebrow">Next moves</div>
            <h3>{nextSteps.length} follow-ups</h3>
          </div>
          <Tags className="h-5 w-5 text-[var(--color-ink-subtle)]" />
        </div>
        <div className="idea-next-list">
          {nextSteps.slice(0, 8).map(({ node, step }) => (
            <button key={`${node.id}:${step}`} type="button" onClick={() => onFocus(step, [node.session_id], "ops")}>
              <span>{ideaProjectLabel(node)}</span>
              <strong>{step}</strong>
            </button>
          ))}
          {facts.slice(0, 5).map((fact) => (
            <button key={fact.label} type="button" onClick={() => onFocus(fact.label, fact.session_ids, "ops")}>
              <span>Grounding fact</span>
              <strong>{fact.label}</strong>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function IdeaWorkspace({ view, views, loading, focusedProjectSlug, onFocus }: CategoryWorkspaceProps) {
  const ideas = views?.ideas;
  if (loading && !ideas) {
    return <EmptyState label="Loading idea evolution..." />;
  }
  if (!ideas) {
    return <EmptyState label="No idea evolution data is available yet." />;
  }
  const allNodes = ideas.nodes ?? [];
  const nodes = focusedProjectSlug ? allNodes.filter((node) => ideaProjectSlug(node) === focusedProjectSlug) : allNodes;
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = (ideas.edges ?? []).filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  const projects = ideas.projects ?? [];
  const focusedProject = focusedProjectSlug ? projects.find((project) => project.slug === focusedProjectSlug) : null;
  const focusedSessionIds = new Set(focusedProject?.session_ids ?? []);
  const threads = (ideas.threads ?? []).filter((group) => !focusedProjectSlug || group.session_ids.some((sessionId) => focusedSessionIds.has(sessionId)));
  const facts = (ideas.facts ?? []).filter((group) => !focusedProjectSlug || group.session_ids.some((sessionId) => focusedSessionIds.has(sessionId)));
  const visibleProjects = focusedProject ? [focusedProject] : projects;
  if (view === "story") {
    return (
      <div className="idea-story-workspace">
        <IdeaMindMap nodes={nodes} edges={edges} projects={visibleProjects} onFocus={onFocus} />
        <div className="idea-story-rails">
          <GroupList title="Projects" groups={visibleProjects} icon={Lightbulb} onFocus={onFocus} limit={null} />
          <GroupList title="Threads" groups={threads} icon={GitBranch} onFocus={onFocus} limit={null} />
          <GroupList title="Grounding facts" groups={facts} icon={BookOpen} onFocus={onFocus} limit={null} />
        </div>
      </div>
    );
  }
  if (view === "ops") {
    return <IdeaAttributionBoard nodes={nodes} edges={edges} facts={facts} onFocus={onFocus} />;
  }

  return <IdeaEvolutionTimeline nodes={nodes} edges={edges} projects={visibleProjects} onFocus={onFocus} />;
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
