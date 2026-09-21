const cssUrl = new URL("./workspace.css", import.meta.url).href;
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const shortDate = (value) =>
  value
    ? new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
      }).format(new Date(value.length === 10 ? `${value}T12:00:00` : value))
    : "";
const requestKey = () => crypto.randomUUID();

export class SMCWorkspace extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = cssUrl;
    this.container = document.createElement("div");
    this.container.hidden = true;
    stylesheet.addEventListener("load", () => {
      this.container.hidden = false;
    });
    stylesheet.addEventListener("error", () => {
      this.container.hidden = false;
    });
    this.shadowRoot.append(stylesheet, this.container);
    this.state = {
      view: "inbox",
      items: [],
      sources: [],
      tasks: [],
      projects: [],
      overview: null,
      query: "",
      project: "",
      taskStatus: "open",
      searchMode: "auto",
      searchScope: "all",
      retrieval: null,
    };
    this._token = "";
    this.notice = "";
    this.error = "";
    this.busy = false;
    this.generation = 0;
    this.shadowRoot.addEventListener("click", (event) => this.click(event));
    this.shadowRoot.addEventListener("submit", (event) => this.submit(event));
    this.shadowRoot.addEventListener("change", (event) => {
      if (event.target.name === "search-mode" || event.target.name === "search-scope") {
        this.state[event.target.name === "search-mode" ? "searchMode" : "searchScope"] = event.target.value;
        this.load();
      }
      if (event.target.name === "project-filter") {
        this.state.project = event.target.value;
        this.load();
      }
      if (event.target.name === "task-status") {
        this.state.taskStatus = event.target.value;
        this.load();
      }
    });
  }
  set token(value) {
    this._token = value || "";
    if (this.isConnected) this.load();
  }
  connectedCallback() {
    this.state.view = this.getAttribute("view") || "inbox";
    this.state.query = this.getAttribute("query") || "";
    this.load();
    this.timer = setInterval(() => {
      if (
        !document.hidden &&
        !this.shadowRoot.querySelector("dialog[open]") &&
        !this.shadowRoot.activeElement?.matches("input,textarea,select") &&
        !this.expanded &&
        !this.busy
      )
        this.load();
    }, 20000);
  }
  disconnectedCallback() {
    this.generation++;
    clearInterval(this.timer);
  }
  get base() {
    return (this.getAttribute("api-base") || "/api/v1/workspace").replace(
      /\/$/,
      "",
    );
  }
  async api(path, options = {}) {
    const response = await fetch(`${this.base}${path}`, {
      ...options,
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        ...(this._token ? { authorization: `Bearer ${this._token}` } : {}),
        ...options.headers,
      },
    });
    if (response.status === 401) {
      const error = new Error(
        "Connect with your application token to continue.",
      );
      error.auth = true;
      throw error;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        typeof payload.error === "string"
          ? payload.error
          : typeof payload.detail === "string"
            ? payload.detail
            : `Request failed (${response.status}). Please check the fields and try again.`,
      );
    return payload;
  }
  async load() {
    const generation = ++this.generation;
    const viewKey = JSON.stringify([
      this.state.view,
      this.state.project,
      this.state.query,
      this.state.taskStatus,
      this.state.searchMode,
      this.state.searchScope,
    ]);
    this.loading = !this.state.overview || viewKey !== this.viewKey;
    this.render();
    try {
      const { view, project, query, taskStatus } = this.state;
      const filter = project
        ? `&project_id=${encodeURIComponent(project)}`
        : "";
      const [overview, projects, result, sources, projectTasks] =
        await Promise.all([
          this.api("/overview"),
          this.api("/projects"),
          query
            ? this.api(`/search?q=${encodeURIComponent(query)}&mode=${this.state.searchMode}&scope=${this.state.searchScope}`)
            : view === "tasks"
              ? this.api(`/tasks?status=${taskStatus}`)
              : this.api(
                  `/memories?status=${view === "inbox" ? "suggested" : "accepted"}${filter}`,
                ),
          view === "memory" || view === "projects"
            ? this.api(`/sources?limit=50${filter}`)
            : Promise.resolve({ items: [] }),
          view === "projects" && project
            ? this.api(`/tasks?status=open${filter}`)
            : Promise.resolve(null),
        ]);
      if (generation !== this.generation) return;
      this.state = {
        ...this.state,
        overview,
        projects: projects.items,
        items: result.items || [],
        tasks: projectTasks?.tasks || result.tasks || [],
        sources: sources.items,
        retrieval: result.retrieval || null,
      };
      this.moreSources = sources.items.length === 50;
      this.moreMemories = result.items?.length === 50 && !query;
      this.expanded = false;
      this.viewKey = viewKey;
      this.needsAuth = false;
      this.error = "";
    } catch (error) {
      if (generation !== this.generation) return;
      this.error = error.message;
      this.needsAuth = error.auth || false;
    }
    this.loading = false;
    this.render();
  }
  async mutate(path, method, body, notice, headers = {}) {
    if (this.busy) return;
    this.busy = true;
    this.shadowRoot
      .querySelectorAll("dialog button[type=submit]")
      .forEach((b) => (b.disabled = true));
    try {
      await this.api(path, { method, body: JSON.stringify(body), headers });
      this.closeDialog();
      this.notice = notice;
      this.error = "";
      await this.load();
    } catch (error) {
      const region = this.shadowRoot.querySelector(".dialog-error");
      if (region) {
        region.textContent = error.message;
        region.hidden = false;
      } else {
        this.error = error.message;
        this.render();
      }
    } finally {
      this.busy = false;
      this.shadowRoot
        .querySelectorAll("dialog button[type=submit]")
        .forEach((b) => (b.disabled = false));
    }
  }
  async loadMore(kind) {
    if (this.busy) return;
    this.busy = true;
    try {
      const s = this.state;
      const field = kind === "sources" ? "sources" : "items";
      const filter = s.project
        ? `&project_id=${encodeURIComponent(s.project)}`
        : "";
      const status =
        kind === "memories"
          ? `&status=${s.view === "inbox" ? "suggested" : "accepted"}`
          : "";
      const result = await this.api(
        `/${kind}?limit=50&offset=${s[field].length}${filter}${status}`,
      );
      const ids = new Set(s[field].map((item) => item.id));
      s[field].push(...result.items.filter((item) => !ids.has(item.id)));
      this[kind === "sources" ? "moreSources" : "moreMemories"] =
        result.items.length === 50;
      this.expanded = true;
      this.render();
    } finally {
      this.busy = false;
    }
  }
  render() {
    const s = this.state,
      counts = s.overview?.counts || {};
    const headings = {
      inbox: [
        "A little clarity.",
        "Saved notes and suggestions, ready for a second look.",
      ],
      tasks: [
        "What needs doing?",
        "Your commitments, with the context that makes them easier to finish.",
      ],
      memory: [
        "Keep the good thinking.",
        "Find the research, ideas, and decisions you don’t want to lose.",
      ],
      projects: [
        "Bring the threads together.",
        "One place for a project’s sources, decisions, and next steps.",
      ],
    };
    const [heading, subtitle] = headings[s.view] || headings.inbox;
    this.container.innerHTML = `<section aria-label="SaveMyContext workspace">
      <header class="hero"><div><p class="eyebrow">SaveMyContext · Private workspace</p><h1>${esc(heading)}</h1><p class="subtitle">${esc(subtitle)}</p></div><div class="hero-actions"><button data-action="capture">＋ Save a thought</button><button class="primary" data-action="add-task">＋ Add task</button></div></header>
      <div class="toolbar"><nav class="tabs" aria-label="Workspace views">${[
        ["inbox", "Inbox"],
        ["tasks", "Tasks"],
        ["memory", "Memory"],
        ["projects", "Projects"],
      ]
        .map(
          ([v, label]) =>
            `<button class="tab" data-action="view" data-view="${v}" ${s.view === v && !s.query ? 'aria-current="page"' : ""}>${label}${counts[v] ? `<span class="count">${counts[v]}</span>` : ""}</button>`,
        )
        .join(
          "",
        )}</nav><form class="search" data-form="search"><label class="sr-only" for="smc-search">Search your memory</label><input id="smc-search" name="q" type="search" placeholder="Search your memory…" value="${esc(s.query)}"><button type="submit" aria-label="Search">↗</button></form></div>
      <div role="status" aria-live="polite">${this.notice ? `<p class="notice">${esc(this.notice)}</p>` : ""}</div>${this.error ? `<p role="alert" class="notice error">${esc(this.error)}</p>` : ""}
      ${s.overview?.counts.quarantined_captures ? `<p role="status" class="notice">${s.overview.counts.quarantined_captures} captures need repair. Original evidence is preserved, separate from your memories. <button data-action="quarantine">Review status</button></p>` : ""}
      ${this.needsAuth ? this.login() : this.loading ? '<p class="busy" role="status">Opening your workspace…</p>' : s.overview ? this.content() : '<button data-action="refresh">Try again</button>'}
      ${s.overview ? `<footer class="bottom"><span><i class="status-dot"></i>${s.overview.processing.external_enabled ? "External processing enabled" : s.overview.retrieval?.enabled ? "Basic Memory · Local search · Interpretation off" : "Local capture & search · No AI inference"}${s.overview.retrieval?.error ? " · Semantic index needs attention" : s.overview.retrieval?.pending ? ` · ${s.overview.retrieval.pending} waiting to index` : ""}${counts.pending_jobs ? ` · ${counts.pending_jobs} queued` : ""}${counts.failed_jobs ? ` · ${counts.failed_jobs} need attention` : ""}</span><div><button data-action="jobs">Processing</button> <button data-action="settings">Reminders</button> <button data-action="export">Export</button></div></footer>` : ""}
      <dialog><div class="dialog-head"><h2 id="dialog-title"></h2><button type="button" data-action="close" aria-label="Close dialog">×</button></div><p class="notice error dialog-error" role="alert" hidden></p><div class="dialog-content"></div></dialog>
    </section>`;
    const dialog = this.shadowRoot.querySelector("dialog");
    dialog.setAttribute("aria-labelledby", "dialog-title");
    dialog.addEventListener(
      "close",
      () => this.opener?.isConnected && this.opener.focus(),
    );
  }
  login() {
    return '<form class="card login" data-form="login"><h2>Connect your workspace</h2><p class="muted">Use a revocable application token. It stays in memory for this tab only.</p><label class="field">Application token<input name="token" type="password" autocomplete="off" required></label><div class="dialog-actions"><button type="submit" class="primary">Connect</button></div></form>';
  }
  empty(title, text, symbol = "◇") {
    return `<div class="empty"><div class="symbol" aria-hidden="true">${symbol}</div><h2>${esc(title)}</h2><p>${esc(text)}</p></div>`;
  }
  projectFilter() {
    return `<select name="project-filter" aria-label="Filter by project"><option value="">All projects</option>${this.state.projects.map((p) => `<option value="${esc(p.id)}" ${this.state.project === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>`;
  }
  content() {
    const s = this.state;
    if (s.query)
      return `<div class="section-title"><h2>Search results</h2><button data-action="clear-search">Clear search</button></div>
      <div class="filters"><label>Match <select name="search-mode" aria-label="Search matching">${[["auto", "Exact + meaning"], ["exact", "Exact terms"], ["semantic", "Similar meaning"]].map(([value, label]) => `<option value="${value}" ${s.searchMode === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><label>Look in <select name="search-scope" aria-label="Search scope">${[["all", "Everything"], ["curated", "Kept memories & open tasks"], ["sources", "Original sources"]].map(([value, label]) => `<option value="${value}" ${s.searchScope === value ? "selected" : ""}>${label}</option>`).join("")}</select></label></div>
      ${s.retrieval?.degraded ? '<p class="notice" role="status">Semantic search is unavailable. Showing exact matches; your records are safe.</p>' : ""}
      ${s.overview.retrieval?.enabled ? '<p class="muted">Similar meaning is a search aid, not a verified fact. Long conversations use excerpts for semantic search; open the source for full context.</p>' : ""}
      ${s.items.length ? `<div class="grid">${s.items.map((item) => this.searchCard(item)).join("")}</div>` : this.empty("No matches yet", "Try a name, project, or phrase from a conversation.")}`;
    if (s.view === "tasks") return this.tasksView();
    if (s.view === "projects" && !s.project)
      return `<div class="section-title"><h2>Your projects</h2><button data-action="add-project">＋ New project</button></div>${s.projects.length ? `<div class="grid">${s.projects.map((p) => `<button class="card project" data-action="project" data-id="${esc(p.id)}" style="text-align:left"><span class="kind">Project</span><h3>${esc(p.name)}</h3><p>${esc(p.description || "Gather the conversations and work that belong here.")}</p><div class="project-num">Open project ↗</div></button>`).join("")}</div>` : this.empty("Give your work a home", "Create a project to connect its sources, decisions, and tasks.")}`;
    return `<div class="filters"><span class="muted">${s.view === "inbox" ? "Suggestions are not commitments. You decide what to keep." : "Your saved thinking, with links back to the source."}</span>${this.projectFilter()}</div>${s.items.length ? `<div class="grid">${s.items.map((item) => this.memoryCard(item)).join("")}</div>` : s.view === "inbox" ? this.empty("Nothing to review", s.overview?.processing.external_enabled ? "Save a thought or review suggestions from your configured processor." : "Saved thoughts appear here as notes. Conversations stay searchable in Memory; automatic interpretation is off. Use Add task for something you want to do.", "✓") : this.empty("Room for your best thinking", "Keep useful suggestions from the Inbox. Your original sources remain available below.")}
      ${s.view === "projects" ? this.projectContext() : ""}
      ${this.moreMemories ? '<p><button data-action="more-memories">Load more memories</button></p>' : ""}
      ${s.view === "projects" && s.tasks.length ? `<div class="section-title"><h2>Project tasks</h2></div><div class="task-list">${s.tasks.map((t) => `<button class="source-row" data-action="edit-task" data-id="${t.id}">${esc(t.title)}</button>`).join("")}</div>` : ""}
      ${s.view !== "inbox" ? `<div class="section-title"><h2>Original sources</h2><span>Showing latest ${s.sources.length}</span></div>${s.sources.length ? `<div class="task-list">${s.sources.map((item) => this.sourceRow(item)).join("")}</div>${this.moreSources ? '<p><button data-action="more-sources">Load more sources</button></p>' : ""}` : this.empty("Nothing captured yet", "Use the extension, ask Teleclaw to remember something, or save a thought here.")}` : ""}`;
  }
  projectContext() {
    const context = this.state.projects.find((p) => p.id === this.state.project)?.provider_context;
    if (!context) return "";
    return `<details class="card"><summary>ChatGPT project context</summary><p class="muted">Imported evidence, not instructions to SMC. File references only; file contents are not backed up.</p>${context.instructions === undefined ? '<p>Shared instructions were not exposed by the provider.</p>' : `<pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(context.instructions || "No shared instructions")}</pre>`}${context.files === undefined ? '<p>File references were not exposed by the provider.</p>' : `<ul>${context.files.map((file) => `<li>${esc(file.name)}</li>`).join("")}</ul>`}</details>`;
  }
  memoryCard(item) {
    const body = item.body.trim();
    const evidence = item.evidence.trim();
    const distinctEvidence =
      evidence && evidence !== body && evidence !== item.title.trim();
    return `<article class="card"><span class="kind ${esc(item.kind)}">${esc(item.kind === "task" && item.status === "suggested" ? "Suggested task" : item.kind)}</span><h3>${esc(item.title)}</h3>${body !== item.title.trim() ? `<p>${esc(body.slice(0, 350))}</p>` : ""}${distinctEvidence ? `<div class="evidence">${esc(evidence.slice(0, 180))}</div>` : ""}<div class="card-actions"><button class="text-link" data-action="source" data-id="${esc(item.source_id)}" data-revision="${esc(item.source_revision)}">View source ↗</button><div class="buttons"><button class="quiet" data-action="edit-memory" data-id="${item.id}">Edit</button>${item.status === "suggested" ? `<button class="quiet" data-action="reject" data-id="${item.id}">Dismiss</button><button class="primary" data-action="accept" data-id="${item.id}">${item.kind === "task" ? "Add task" : "Keep"}</button>` : ""}</div></div></article>`;
  }
  sourceRow(item) {
    return `<button class="source-row" data-action="source" data-id="${esc(item.id)}"><span class="source-mark" aria-hidden="true">≡</span><span class="text"><span class="source-title">${esc(item.title)}</span><span class="source-excerpt">${esc(item.excerpt || item.body?.slice(0, 180))}</span></span><span class="source-meta">${item.quality?.status === "needs_repair" ? "Needs repair · " : ""}${esc(item.provider)} · ${shortDate(item.updated_at)}</span></button>`;
  }
  searchCard(item) {
    const label = item.record_type === "source" ? "Original source" : item.record_type === "task" ? `Task · ${item.status}` : item.record_type === "memory" ? `Memory · ${item.status}` : "Project";
    return `<article class="card"><span class="kind">${esc(label)}</span>${item.match === "semantic" ? '<span class="muted"> · Similar meaning</span>' : ""}<h3>${esc(item.title)}</h3><p>${esc((item.body || item.notes || item.description || "").slice(0, 250))}</p><div class="card-actions"><button data-action="${item.record_type === "project" ? "project" : item.record_type === "task" ? "edit-task" : item.record_type === "source" ? "source" : "edit-memory"}" data-id="${esc(item.id)}">Open ↗</button></div></article>`;
  }
  tasksView() {
    const s = this.state,
      timezone = s.overview.settings.timezone;
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const groups =
      s.taskStatus === "open"
        ? [
            ["Overdue", (t) => t.due_on && t.due_on < today],
            ["Today", (t) => t.due_on === today],
            ["Upcoming", (t) => t.due_on && t.due_on > today],
            ["Anytime", (t) => !t.due_on],
          ]
        : [[s.taskStatus === "done" ? "Completed" : "Archived", () => true]];
    return `<div class="filters"><span class="muted">${s.tasks.length} ${s.taskStatus === "open" ? "open tasks" : "tasks"} · ${esc(timezone)}</span><select name="task-status" aria-label="Task status">${[
      ["open", "Open"],
      ["done", "Completed"],
      ["archived", "Archived"],
    ]
      .map(
        ([v, l]) =>
          `<option value="${v}" ${s.taskStatus === v ? "selected" : ""}>${l}</option>`,
      )
      .join("")}</select></div>${
      !s.tasks.length
        ? this.empty(
            "A clear list",
            "Add a task directly, or accept a suggested commitment from your Inbox.",
            "✓",
          )
        : groups
            .map(([name, test]) => {
              const tasks = s.tasks.filter(test);
              return !tasks.length
                ? ""
                : `<div class="section-title"><h2>${name}</h2><span>${tasks.length}</span></div><div class="task-list">${tasks.map((t) => `<div class="task-row ${t.status === "done" ? "is-done" : ""}"><button class="check" data-action="toggle" data-id="${t.id}" aria-label="${t.status === "done" ? "Reopen" : "Complete"} ${esc(t.title)}">${t.status === "done" ? "✓" : ""}</button><button class="task-body" data-action="edit-task" data-id="${t.id}"><span class="task-title">${esc(t.title)}</span><span class="task-meta"><span>${esc(t.list_name)}</span>${t.due_on ? `<span class="${t.due_on < today ? "overdue" : ""}">${shortDate(t.due_on)}</span>` : ""}${t.notify ? "<span>Reminder requested</span>" : ""}${t.memory_id ? "<span>From your memory</span>" : ""}</span></button>${t.priority !== "normal" ? `<span class="priority">${esc(t.priority)}</span>` : ""}</div>`).join("")}</div>`;
            })
            .join("")
    }`;
  }
  dialog(title, html) {
    this.opener = this.shadowRoot.activeElement;
    const dialog = this.shadowRoot.querySelector("dialog");
    dialog.querySelector("h2").textContent = title;
    dialog.querySelector(".dialog-content").innerHTML = html;
    dialog.querySelector(".dialog-error").hidden = true;
    dialog.showModal();
    dialog.querySelector("input,textarea,select,button[type=submit]")?.focus();
  }
  closeDialog() {
    this.shadowRoot.querySelector("dialog")?.close();
  }
  projectOptions(selected) {
    return `<option value="">No project</option>${this.state.projects.map((p) => `<option value="${esc(p.id)}" ${selected === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}`;
  }
  taskForm(task = null) {
    this.editing = task;
    this.formKey = requestKey();
    const local = task?.remind_at
      ? new Date(
          new Date(task.remind_at).valueOf() -
            new Date(task.remind_at).getTimezoneOffset() * 60000,
        )
          .toISOString()
          .slice(0, 16)
      : "";
    this.dialog(
      task ? "Edit task" : "A next step",
      `<form data-form="task"><div class="fields"><label class="field wide">What needs doing?<input name="title" value="${esc(task?.title)}" required maxlength="240"></label><label class="field wide">Context <span class="muted">optional</span><textarea name="notes" maxlength="4000">${esc(task?.notes)}</textarea></label><label class="field">Due date<input type="date" name="due_on" value="${esc(task?.due_on)}"></label><label class="field">Priority<select name="priority">${["low", "normal", "high", "urgent"].map((p) => `<option ${p === (task?.priority || "normal") ? "selected" : ""}>${p}</option>`).join("")}</select></label><label class="field">List<input name="list_name" value="${esc(task?.list_name || "Inbox")}" required maxlength="120"></label><label class="field">Project<select name="project_id">${this.projectOptions(task?.project_id)}</select></label><label class="field wide">Remind me at <span class="muted">your browser’s local time</span><input type="datetime-local" name="remind_at" value="${local}"></label><label class="field checkbox wide"><input type="checkbox" name="notify" ${task?.notify ? "checked" : ""}>Request a reminder (requires the global reminder switch)</label></div><div class="dialog-actions">${task ? `<button class="left danger" type="button" data-action="archive" data-id="${task.id}">Archive</button>` : ""}<button type="button" data-action="close">Cancel</button><button class="primary" type="submit">${task ? "Save changes" : "Add task"}</button></div></form>`,
    );
  }
  find(id) {
    return [...this.state.items, ...this.state.tasks].find(
      (item) => String(item.id) === id,
    );
  }
  async click(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const { action, id } = button.dataset;
    try {
      if (action === "more-sources" || action === "more-memories") {
        await this.loadMore(action.slice(5));
        return;
      }
      if (action === "close") {
        this.closeDialog();
        return;
      }
      if (action === "view") {
        this.state.view = button.dataset.view;
        this.state.query = "";
        this.state.project = "";
        this.notice = "";
        await this.load();
        return;
      }
      if (action === "refresh") {
        await this.load();
        return;
      }
      if (action === "clear-search") {
        this.state.query = "";
        await this.load();
        return;
      }
      if (action === "project") {
        this.state.query = "";
        this.state.project = id;
        this.state.view = "projects";
        await this.load();
        return;
      }
      if (action === "add-task") {
        this.taskForm();
        return;
      }
      if (action === "edit-task") {
        this.taskForm(this.find(id));
        return;
      }
      if (action === "toggle" || action === "archive") {
        const t = this.find(id);
        await this.mutate(
          `/tasks/${id}`,
          "PATCH",
          {
            status:
              action === "archive"
                ? "archived"
                : t.status === "done"
                  ? "open"
                  : "done",
            expected_version: t.version,
          },
          action === "archive" ? "Task archived." : "Task updated.",
        );
        return;
      }
      if (action === "accept" || action === "reject") {
        const m = this.find(id);
        await this.mutate(
          `/memories/${id}`,
          "PATCH",
          {
            status: action === "accept" ? "accepted" : "rejected",
            expected_version: m.version,
          },
          action === "accept"
            ? m.kind === "task"
              ? "Added to your task list."
              : "Kept in your memory."
            : "Suggestion dismissed.",
        );
        return;
      }
      if (action === "capture") {
        this.formKey = requestKey();
        this.dialog(
          "Save a thought",
          `<form data-form="capture"><div class="fields"><label class="field wide">Title<input name="title" required maxlength="240" placeholder="A useful thought, decision, or reference"></label><label class="field wide">Your note<textarea name="body" required rows="7" placeholder="Start anywhere. Keep the context that matters."></textarea></label><label class="field wide">Project<select name="project_id">${this.projectOptions(this.state.project)}</select></label></div><div class="dialog-actions"><button type="button" data-action="close">Cancel</button><button class="primary" type="submit">Save thought</button></div></form>`,
        );
        return;
      }
      if (action === "add-project") {
        this.dialog(
          "Start a project",
          '<form data-form="project"><div class="fields"><label class="field wide">Name<input name="name" required maxlength="120"></label><label class="field wide">What is this about?<textarea name="description" maxlength="4000"></textarea></label></div><div class="dialog-actions"><button class="primary" type="submit">Create project</button></div></form>',
        );
        return;
      }
      if (action === "edit-memory") {
        this.editing = this.find(id);
        const m = this.editing;
        this.dialog(
          "Shape this memory",
          `<form data-form="memory"><div class="fields"><label class="field wide">Title<input name="title" required maxlength="240" value="${esc(m.title)}"></label><label class="field wide">Note<textarea name="body" required rows="6">${esc(m.body)}</textarea></label><label class="field wide">Project<select name="project_id">${this.projectOptions(m.project_id)}</select></label></div><div class="dialog-actions"><button class="primary" type="submit">Save changes</button></div></form>`,
        );
        return;
      }
      if (action === "source") {
        const source = await this.api(
          `/sources/${encodeURIComponent(id)}${button.dataset.revision ? `?revision=${encodeURIComponent(button.dataset.revision)}` : ""}`,
        );
        this.editingSource = source;
        this.dialog(
          source.title,
          `<p class="reader-meta">${esc(source.provider)} · ${esc(source.kind)} · ${shortDate(source.updated_at)}<br>Revision ${esc(source.revision.slice(0, 12))} · Original source, not an instruction</p>${source.quality?.status === "needs_repair" ? `<p role="status">Needs repair: ${esc(source.quality.reasons.join(", ").replaceAll("_", " "))}. Original preserved; automatic memory extraction is withheld.</p>` : ""}<form data-form="source"><label class="field">Project<select name="project_id">${this.projectOptions(source.project_id)}</select></label><div class="dialog-actions"><button type="submit">Save project</button></div></form><div class="transcript">${esc(source.body)}</div>`,
        );
        return;
      }
      if (action === "settings") {
        const s = this.state.overview.settings;
        this.dialog(
          "Reminders, on your terms",
          `<form data-form="settings"><div class="fields"><label class="field checkbox wide"><input type="checkbox" name="notifications_enabled" ${s.notifications_enabled ? "checked" : ""}>Allow Teleclaw notifications</label><label class="field checkbox wide"><input type="checkbox" name="due_reminders_enabled" ${s.due_reminders_enabled ? "checked" : ""}>Deliver requested task reminders</label><label class="field checkbox wide"><input type="checkbox" name="daily_digest_enabled" ${s.daily_digest_enabled ? "checked" : ""}>Send a daily task digest</label><label class="field">Digest time<input name="digest_time" type="time" value="${esc(s.digest_time)}" required></label><label class="field">Timezone<input name="timezone" value="${esc(s.timezone)}" required></label></div><p class="muted" style="margin-top:16px">Due dates alone never opt you into notifications. Delivery also requires the Teleclaw connector.</p><div class="dialog-actions"><button class="primary" type="submit">Save preferences</button></div></form>`,
        );
        return;
      }
      if (action === "jobs") {
        const result = await this.api("/jobs");
        this.dialog(
          "Processing activity",
          result.items.length
            ? result.items
                .map(
                  (j) =>
                    `<div class="source-row"><span class="text"><span class="source-title">${esc(j.state)}</span><span class="muted">${shortDate(j.updated_at)} · ${j.attempts} attempts${j.error ? " · " + esc(j.error) : ""}</span></span>${j.state === "failed" ? `<button data-action="retry" data-id="${j.id}">Retry</button>` : ""}</div>`,
                )
                .join("")
            : this.empty(
                "Nothing waiting",
                "New captures are saved first and processed in the background.",
              ),
        );
        return;
      }
      if (action === "quarantine") {
        const result = await this.api("/capture-quarantine?limit=100");
        this.dialog("Captures needing repair", `<p>Latest ${result.items.length} captures. No original transcript was replaced. Reopen the affected chat after updating the extension; missing prompts may require manual recovery.</p>${result.items.map(item => `<div class="source-row"><span class="text"><span class="source-title">${esc(item.provider)} · ${shortDate(item.created_at)}</span><span>${esc(item.quality.reasons.join(", ").replaceAll("_", " "))}</span></span></div>`).join("")}`);
        return;
      }
      if (action === "retry") {
        await this.mutate(
          `/jobs/${id}/retry`,
          "POST",
          {},
          "Processing retry queued.",
        );
        return;
      }
      if (action === "export") {
        const response = await fetch(`${this.base}/export`, {
          headers: this._token
            ? { authorization: `Bearer ${this._token}` }
            : {},
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Export failed");
        const url = URL.createObjectURL(await response.blob());
        const a = document.createElement("a");
        a.href = url;
        a.download = "SaveMyContext.md";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) {
      this.error = error.message;
      this.render();
    }
  }
  async submit(event) {
    event.preventDefault();
    const form = event.target;
    const data = new FormData(form);
    const values = Object.fromEntries(data);
    if (form.dataset.form === "search") {
      this.state.query = String(values.q).trim();
      await this.load();
      return;
    }
    if (form.dataset.form === "login") {
      this._token = String(values.token);
      await this.load();
      return;
    }
    if (form.dataset.form === "task") {
      const payload = {
        ...values,
        due_on: values.due_on || null,
        remind_at: values.remind_at
          ? new Date(values.remind_at).toISOString()
          : null,
        project_id: values.project_id || null,
        notify: data.has("notify"),
      };
      if (this.editing) payload.expected_version = this.editing.version;
      await this.mutate(
        this.editing ? `/tasks/${this.editing.id}` : "/tasks",
        this.editing ? "PATCH" : "POST",
        payload,
        "Task saved.",
        { "idempotency-key": this.formKey },
      );
      return;
    }
    if (form.dataset.form === "capture") {
      await this.mutate(
        "/captures",
        "POST",
        {
          ...values,
          key: this.formKey,
          project_id: values.project_id || null,
          interface: "web",
        },
        "Saved. Processing will continue in the background.",
      );
      return;
    }
    if (form.dataset.form === "project") {
      await this.mutate("/projects", "POST", values, "Project created.");
      return;
    }
    if (form.dataset.form === "memory") {
      await this.mutate(
        `/memories/${this.editing.id}`,
        "PATCH",
        {
          ...values,
          project_id: values.project_id || null,
          expected_version: this.editing.version,
        },
        "Memory updated.",
      );
      return;
    }
    if (form.dataset.form === "source") {
      await this.mutate(
        `/sources/${encodeURIComponent(this.editingSource.id)}`,
        "PATCH",
        {
          project_id: values.project_id || null,
          expected_revision: this.editingSource.revision,
        },
        "Source assigned to project.",
      );
      return;
    }
    if (form.dataset.form === "settings") {
      await this.mutate(
        "/settings",
        "PATCH",
        {
          ...values,
          notifications_enabled: data.has("notifications_enabled"),
          due_reminders_enabled: data.has("due_reminders_enabled"),
          daily_digest_enabled: data.has("daily_digest_enabled"),
        },
        "Reminder preferences saved.",
      );
    }
  }
}
if (!customElements.get("smc-workspace"))
  customElements.define("smc-workspace", SMCWorkspace);
