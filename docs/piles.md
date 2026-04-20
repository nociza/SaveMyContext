# Piles

A **pile** is a logical bucket of sessions plus a small contract that tells SaveMyContext how to process the contents. Each pile owns:

- a `slug` (URL-safe identifier),
- a `name` and `description`,
- a `folder_label` (the directory inside the vault),
- a list of `attributes` that drive the pipeline,
- a `pipeline_config` for behavior that doesn't fit the attribute model.

## Built-in piles

Five piles are seeded on first run and can never be deleted:

| Slug | Folder | Attributes | What it does |
| --- | --- | --- | --- |
| `journal` | `Journal/` | `summary`, `chronological`, `queryable_qa` | Personal context, daily planning, reflection. |
| `factual` | `Factual/` | `summary`, `knowledge_graph` | Coding, research, objective Q&A. Triplets feed the shared knowledge graph. |
| `ideas` | `Ideas/` | `summary`, `knowledge_graph`, `share_post`, `alternate_phrasings` | Brainstorming. Includes a tweet-sized share post. |
| `todo` | `Todo/` | `chronological`, `importance`, `deadline`, `completion` | Updates the shared `Dashboards/To-Do List.md`. |
| `discarded` | `Discarded/{YYYY}/...` | `chronological` | Captured-but-shelved. Hidden from the dashboard, recoverable from the Discarded panel. |

You can edit the description, sort order, and (for the discarded pile) the `auto_discard_categories` list. Built-in attributes and folder labels are protected.

## Attributes

Every attribute the pipeline knows about. Set them on a user-defined pile and the orchestrator will produce the matching keys in `ChatSession.pile_outputs`:

| Attribute | What the pipeline produces |
| --- | --- |
| `summary` | A short, neutral 1–3 sentence synopsis. Always recommended. |
| `chronological` | No extra LLM call. The vault writer keeps the pile sorted by capture time. |
| `queryable_qa` | Up to 4 `{question, answer}` pairs suitable for semantic search. |
| `knowledge_graph` | Subject-predicate-object triplets fed into the shared graph. |
| `share_post` | A ≤280-char shareable note. |
| `alternate_phrasings` | Up to 3 reworded restatements of the takeaway. |
| `importance` | Integer 1–5. |
| `deadline` | ISO-8601 date if the transcript clearly mentions one. |
| `completion` | `open` / `in_progress` / `done`. |

Adding an attribute to a pile is a configuration change; you do not need to write any code.

## Creating a user-defined pile

```bash
curl -sS -X POST http://127.0.0.1:18888/api/v1/piles \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "research",
    "name": "Research",
    "description": "Long-form research notes that I want to share later.",
    "attributes": ["summary", "alternate_phrasings", "share_post", "importance"]
  }'
```

The response includes the generated `id`, the inferred `folder_label` (PascalCase from the name), and the canonical attribute list (with `summary` injected if you forgot it).

Sessions get into a user pile two ways:

1. **Automatic LLM routing**. As soon as one or more user piles exist, the classifier sees them by description (capped at 8 to keep the prompt small) and can pick one. The generic attribute pipeline then fills `pile_outputs` and rewrites the markdown into the user pile's folder.
2. **Manual move**: `POST /api/v1/piles/{slug}/sessions/{session_id}/assign`. Useful when you want to override the classifier's choice or move an existing note.

When no user piles exist, classification stays on the legacy four-bucket path so the system behaves identically to the pre-piles era.

## Extension UI

`piles.html` (open from the dashboard "Piles" button) lists every pile with edit / delete / "new pile" controls. Built-in piles can be edited in description and prompt addendum but their attribute set and folder are protected. The discarded pile gets a dedicated `auto_discard_categories` field.

## Discarded pile in detail

The discarded pile is the entry point for three routing paths:

1. **Discard words** (extension-side). Default: `loom`, ON by default. Configure under Settings → Discard pile.
2. **LLM auto-discard pile hints**. `PATCH /api/v1/piles/discarded` with `pipeline_config.auto_discard_categories = ["small talk", "test sessions"]` (legacy config key). The classifier prompt is augmented with these strings.
3. **Manual discard**. `POST /api/v1/piles/discarded/sessions/{id}/discard`.

Recovering: `POST /api/v1/piles/discarded/sessions/{id}/recover` clears the discard flag, re-runs the full classification pipeline, and moves the markdown file from `Discarded/{YYYY}/` into the appropriate pile folder. The dashboard's Discarded panel exposes this with a one-click button.

## API reference

- `GET /api/v1/piles` — list all piles (built-in + user, active only).
- `GET /api/v1/piles/{slug}` — fetch one pile.
- `POST /api/v1/piles` — create a user-defined pile (admin scope).
- `PATCH /api/v1/piles/{slug}` — edit a pile (admin scope; built-in attribute/folder changes blocked).
- `DELETE /api/v1/piles/{slug}` — soft-delete a user pile (admin scope; built-ins refused).
- `GET /api/v1/piles/{slug}/stats` — built-in piles only in this release.
- `GET /api/v1/piles/{slug}/graph` — built-in piles only in this release.
- `GET /api/v1/piles/discarded/sessions` — chronological list of discarded sessions.
- `POST /api/v1/piles/discarded/sessions/{session_id}/recover` — recover a discarded session.
- `POST /api/v1/piles/discarded/sessions/{session_id}/discard` — manually move a session to discarded.
- `POST /api/v1/piles/{slug}/sessions/{session_id}/assign` — move a session into a pile and run its pipeline.
