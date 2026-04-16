---
title: Using SaveMyContext
---

# Using SaveMyContext

Once the backend and extension are connected, SaveMyContext has four main workflows: automatic chat sync, manual source capture, search, and vault browsing.

## Automatic conversation sync

Visit ChatGPT, Gemini, or Grok while signed in. If `Auto Sync History` is enabled, SaveMyContext pulls conversation history from the provider site and mirrors it into your local archive.

What happens during sync:

1. the extension detects the provider tab
2. it normalizes the provider response into a common session format
3. it syncs the session to the backend
4. the backend writes a readable note and a matching source document
5. the backend classifies the session and updates the vault, graph, and dashboards

When the provider supplies a full conversation snapshot, SaveMyContext rewrites the local message list to match that snapshot instead of only appending new messages. That keeps message order and message removals aligned with the latest provider copy.

## Indexing rules

SaveMyContext can either index everything or require trigger words.

- `all`: every supported conversation is indexed
- `trigger_word`: a conversation is indexed only if its opening request matches one of your trigger words

Blacklist words always win and skip indexing.

The rule check looks at the first one or two user messages, with a focus on the opening one or two sentences. This keeps the filter simple and predictable for natural prompts and dictation.

## How conversations are organized

Each synced conversation is classified into one of four categories:

- `journal`: reflections, planning, and personal context
- `factual`: coding, research, explanations, and objective question answering
- `ideas`: brainstorming and concept development
- `todo`: explicit requests to edit the shared to-do list

### Journal

Journal notes include a cleaned transcript plus a short journal entry with action items.

### Factual

Factual notes extract subject-predicate-object triplets and feed the graph views. SaveMyContext also writes separate entity notes under `Graph/Entities/`.

Entity note filenames are stable and collision-resistant, so closely named concepts such as `C`, `C#`, and `C++` stay separate instead of collapsing into one file.

### Ideas

Ideas notes include a structured summary:

- core idea
- pros
- cons
- next steps
- a short share post

### To-Do

`todo` is reserved for explicit shared-list editing requests. General planning does not update the shared to-do list unless the conversation clearly asks to add, remove, complete, reopen, or change list items.

## Saving a full page

From the popup, choose `Save page`.

That sends the current page through SaveMyContext's AI-enriched source capture flow. If no AI backend is configured, SaveMyContext falls back to a local title, classification, and cleanup pass.

Saved pages are written into:

- `Captures/` for the readable note
- `Sources/` for the raw source document

## Saving a text selection

Turn on `Selection Capture` in the extension settings. Then select text on a regular web page.

SaveMyContext shows a small capture bubble with two choices:

- `Add to Knowledge Base`: stores the selection as a raw capture
- `Save with AI`: stores it with title cleanup, classification, and summary when AI processing is available

Selection captures are separate from provider chat sync. They are good for articles, docs, error messages, code examples, and snippets you want to keep alongside your conversation archive.

## Quick search on any page

SaveMyContext includes a page-level quick search:

- Windows and Linux: `Ctrl+Shift+Y`
- macOS: `Command+Shift+Y`

You can also open it from the popup with `Search page`.

Quick search runs against your saved knowledge and can search:

- session notes
- graph entities
- saved source captures
- the shared to-do list

If you open it while focused in an input, textarea, or rich-text editor, SaveMyContext can insert the selected result into that field.

## Processing modes

SaveMyContext supports three practical processing paths:

- immediate backend processing with an OpenAI-compatible key
- immediate backend processing with a Google key
- heuristic fallback when no AI provider is configured

There is also an experimental browser-based processing mode. When enabled, the popup shows a queue action so the extension can process pending notes using a provider tab.

## Read next

- [Dashboard and Search](dashboard-and-search.md)
- [Vault and Storage](vault-and-storage.md)
