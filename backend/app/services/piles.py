from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.models.enums import PileKind, BuiltInPileSlug


PILE_ATTRIBUTES: frozenset[str] = frozenset(
    {
        "summary",
        "chronological",
        "queryable_qa",
        "knowledge_graph",
        "share_post",
        "alternate_phrasings",
        "importance",
        "deadline",
        "completion",
    }
)


@dataclass(frozen=True)
class PileSeed:
    slug: str
    name: str
    description: str
    kind: PileKind
    folder_label: str
    attributes: tuple[str, ...]
    pipeline_config: dict[str, Any] = field(default_factory=dict)
    is_visible_on_dashboard: bool = True
    sort_order: int = 0

    def attributes_list(self) -> list[str]:
        return list(self.attributes)


DEFAULT_PILES: tuple[PileSeed, ...] = (
    PileSeed(
        slug="journal",
        name="Journal",
        description=(
            "Personal day-to-day progression, relationships, places, activities, travel, and reflection. "
            "Rendered as timeline, location, relationship, and mentioned-item views."
        ),
        kind=PileKind.BUILT_IN_JOURNAL,
        folder_label="Journal",
        attributes=("summary", "chronological", "queryable_qa"),
        sort_order=10,
    ),
    PileSeed(
        slug="factual",
        name="Factual",
        description=(
            "Coding, research, explanation, and objective Q&A. Stored as a lightweight dated backlog "
            "with queryable entities and links back from ideas, journal entries, and other piles."
        ),
        kind=PileKind.BUILT_IN_FACTUAL,
        folder_label="Factual",
        attributes=("summary", "knowledge_graph"),
        sort_order=20,
    ),
    PileSeed(
        slug="ideas",
        name="Ideas",
        description=(
            "Brainstorming, creative exploration, and original concepts. Preserves attributed claims, "
            "reasoning steps, and whether ideas build on, validate, or counter each other."
        ),
        kind=PileKind.BUILT_IN_IDEAS,
        folder_label="Ideas",
        attributes=("summary", "knowledge_graph", "share_post", "alternate_phrasings"),
        sort_order=30,
    ),
    PileSeed(
        slug="todo",
        name="Todo",
        description=(
            "Explicit edits to the shared to-do list. The to-do pile keeps a plain Active/Done checklist "
            "without graph structure or scheduling clutter."
        ),
        kind=PileKind.BUILT_IN_TODO,
        folder_label="Todo",
        attributes=("chronological", "completion"),
        sort_order=40,
    ),
    PileSeed(
        slug="discarded",
        name="Discarded",
        description=(
            "Captured but not processed. Sessions land here when a discard word is detected at the "
            "start of the conversation, when the LLM matches an auto-discard category, or when the "
            "user manually moves them. Discarded notes are kept chronologically and never appear on "
            "the main dashboard, but stay recoverable."
        ),
        kind=PileKind.BUILT_IN_DISCARDED,
        folder_label="Discarded",
        attributes=("chronological",),
        pipeline_config={
            "auto_discard_categories": [],
            "custom_prompt_addendum": None,
        },
        is_visible_on_dashboard=False,
        sort_order=900,
    ),
)


SLUG_BY_BUILT_IN_KIND: dict[PileKind, str] = {seed.kind: seed.slug for seed in DEFAULT_PILES}
BUILT_IN_KIND_BY_SLUG: dict[str, PileKind] = {seed.slug: seed.kind for seed in DEFAULT_PILES}


CATEGORY_TO_BUILT_IN_SLUG: dict[BuiltInPileSlug, str] = {
    BuiltInPileSlug.JOURNAL: "journal",
    BuiltInPileSlug.FACTUAL: "factual",
    BuiltInPileSlug.IDEAS: "ideas",
    BuiltInPileSlug.TODO: "todo",
    BuiltInPileSlug.DISCARDED: "discarded",
}


BUILT_IN_SLUG_TO_CATEGORY: dict[str, BuiltInPileSlug] = {
    slug: category for category, slug in CATEGORY_TO_BUILT_IN_SLUG.items()
}


def category_for_pile_slug(slug: str | None) -> BuiltInPileSlug | None:
    if not slug:
        return None
    return BUILT_IN_SLUG_TO_CATEGORY.get(slug)


def pile_slug_for_category(category: BuiltInPileSlug | None) -> str | None:
    if category is None:
        return None
    return CATEGORY_TO_BUILT_IN_SLUG.get(category)


def is_built_in_slug(slug: str | None) -> bool:
    return bool(slug) and slug in BUILT_IN_KIND_BY_SLUG


def pipeline_prompt_addendum_from_config(config: dict[str, Any] | None) -> str | None:
    if not isinstance(config, dict):
        return None
    for key in ("pipeline_prompt_addendum", "custom_prompt_addendum"):
        value = config.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def pipeline_llm_model_from_config(config: dict[str, Any] | None) -> str | None:
    if not isinstance(config, dict):
        return None
    value = config.get("llm_model")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def restructure_config_from_pipeline_config(config: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(config, dict):
        return {}
    value = config.get("restructure")
    return value if isinstance(value, dict) else {}


def restructure_llm_model_from_config(config: dict[str, Any] | None) -> str | None:
    restructure = restructure_config_from_pipeline_config(config)
    value = restructure.get("llm_model")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return pipeline_llm_model_from_config(config)
