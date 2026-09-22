---
title: Prompt Management Audit
---

> Historical reference for the pre-workspace backend. The 0.4 extension no longer
> includes pile/graph screens, prompt editing, or a browser inference runner.
> Use [Getting Started](getting-started.md) and [Using SaveMyContext](using-save-my-context.md)
> for the supported workflow. Retained backend compatibility does not imply these
> extension controls still exist.

# Prompt Management Audit

Current review: 2026-07-10

## Current state

Prompt management is partly centralized and already has a real product surface:

- `backend/app/prompts/templates.py` defines stable built-in template keys, variables, defaults, and pile rules.
- `PromptTemplate`, `PromptTemplateService`, and the prompt API persist validated overrides and restore defaults.
- `extension/src/prompts/main.tsx` lets an authorized user inspect and edit those templates.
- Custom piles support a narrower `custom_prompt_addendum` and model override.

Several prompt-bearing flows still live beside orchestration code:

- classification and extraction composition in `backend/app/services/orchestrator.py`
- source-capture cleanup/classification in `backend/app/services/source_capture.py`
- browser-worker batching in `backend/app/services/processing_worker.py`
- transport repair/wrapping in the browser proxy client

The existing registry is therefore useful but not yet the only prompt source. A maintainer still needs to understand
the service graph to predict every prompt sent for one capture.

## Privacy boundary

Vault search is deterministic and local-only. The Google ADK dependency and unused search-agent prompt were removed.
Configuring an enrichment provider does not implicitly authorize sending search queries or existing vault notes to
that provider.

Future remote reranking should be a separate, explicit opt-in with a visible disclosure of what text leaves the
backend. Search should remain local and read-only by default.

## Recommended next steps

1. Move remaining code-owned prompt text into the registry without moving transport or validation logic into the
   template layer.
2. Give every processing result lineage: template key/version, model, provider, start/end time, validation outcome,
   fallback path, and error state.
3. Add fixture-driven evaluations for classification, extraction, and destructive to-do mutations before a prompt
   override can be activated.
4. Add preview/diff and rollback history to the prompt UI; keep variable schemas typed and reject unknown fields.
5. Keep secrets, raw provider payloads, and unrestricted filesystem or shell tools out of user-editable templates.

## Organization decision

Prompt definitions, typed inputs/outputs, model transport, orchestration, and post-validation are separate concerns.
The current template registry is the right foundation. The next improvement is to finish adopting it and add
observable processing runs, not to introduce a second agent framework.
