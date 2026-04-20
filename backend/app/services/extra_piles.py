from __future__ import annotations

from collections import Counter

from app.models.enums import BuiltInPileSlug
from app.services.text import normalize_whitespace


EXTRA_PILE_TAG_PREFIX = "pile:"
LEGACY_EXTRA_PILE_TAG_PREFIX = "category:"
RESERVED_PILE_NAMES = {pile.value for pile in BuiltInPileSlug}


def normalize_extra_pile_name(value: str) -> str:
    return normalize_whitespace(value)


def extra_pile_key(value: str) -> str:
    return normalize_extra_pile_name(value).casefold()


def is_extra_pile_tag(tag: str) -> bool:
    normalized = normalize_whitespace(tag).casefold()
    return normalized.startswith(EXTRA_PILE_TAG_PREFIX) or normalized.startswith(LEGACY_EXTRA_PILE_TAG_PREFIX)


def encode_extra_pile_tag(name: str) -> str:
    cleaned = normalize_extra_pile_name(name)
    return f"{EXTRA_PILE_TAG_PREFIX}{cleaned}"


def extract_extra_piles(tags: list[str] | None) -> list[str]:
    piles: dict[str, str] = {}
    for tag in tags or []:
        cleaned = normalize_whitespace(tag)
        if not cleaned:
            continue
        if not is_extra_pile_tag(cleaned):
            continue
        name = normalize_extra_pile_name(cleaned.split(":", 1)[1] if ":" in cleaned else "")
        if not name:
            continue
        piles[extra_pile_key(name)] = name
    return sorted(piles.values(), key=str.casefold)


def visible_custom_tags(tags: list[str] | None) -> list[str]:
    cleaned_tags: dict[str, str] = {}
    for tag in tags or []:
        cleaned = normalize_whitespace(tag)
        if not cleaned or is_extra_pile_tag(cleaned):
            continue
        cleaned_tags[cleaned.casefold()] = cleaned
    return sorted(cleaned_tags.values(), key=str.casefold)


def merge_extra_piles(tags: list[str] | None, extra_piles: list[str]) -> list[str]:
    merged_tags = visible_custom_tags(tags)
    piles: dict[str, str] = {}
    for pile in extra_piles:
        cleaned = normalize_extra_pile_name(pile)
        if not cleaned:
            continue
        piles[extra_pile_key(cleaned)] = cleaned
    return sorted([*merged_tags, *(encode_extra_pile_tag(name) for name in piles.values())], key=str.casefold)


def has_extra_pile(tags: list[str] | None, value: str) -> bool:
    target = extra_pile_key(value)
    if not target:
        return False
    return any(extra_pile_key(pile) == target for pile in extract_extra_piles(tags))


def summarize_extra_piles(tag_sets: list[list[str] | None]) -> list[tuple[str, int]]:
    counter = Counter()
    labels: dict[str, str] = {}
    for tags in tag_sets:
        for pile in extract_extra_piles(tags):
            key = extra_pile_key(pile)
            counter[key] += 1
            labels[key] = pile
    return [(labels[key], counter[key]) for key, _ in counter.most_common()]
