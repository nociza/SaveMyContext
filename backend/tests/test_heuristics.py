from __future__ import annotations

from app.models import MessageRole, SessionCategory
import pytest

from app.schemas.processing import ClassificationResult
from app.services.heuristics import (
    heuristic_classification,
    heuristic_idea,
    heuristic_journal,
    heuristic_triplets,
    is_explicit_todo_request,
)
from app.services.orchestrator import ProcessingOrchestrator
from app.services.todo import heuristic_todo_result


class StubMessage:
    def __init__(self, role: MessageRole, content: str) -> None:
        self.role = role
        self.content = content


def test_classifies_journal_like_conversation() -> None:
    messages = [
        StubMessage(MessageRole.USER, "Today I need to sort out my schedule and family plans."),
        StubMessage(MessageRole.ASSISTANT, "Start by blocking the important errands."),
    ]

    result = heuristic_classification(messages)  # type: ignore[arg-type]
    assert result.category == SessionCategory.JOURNAL


def test_extracts_triplets_from_factual_text() -> None:
    messages = [
        StubMessage(MessageRole.USER, "FastAPI uses uvloop. SQLite supports lightweight local storage."),
    ]

    triplets = heuristic_triplets(messages)  # type: ignore[arg-type]
    assert any(triplet.subject == "FastAPI" and triplet.predicate == "uses" for triplet in triplets)


def test_classifies_todo_like_conversation() -> None:
    messages = [
        StubMessage(MessageRole.USER, "Add buy milk to my to-do list and mark file taxes as done."),
        StubMessage(MessageRole.ASSISTANT, "I'll update the shared list."),
    ]

    result = heuristic_classification(messages)  # type: ignore[arg-type]
    assert result.category == SessionCategory.TODO
    assert is_explicit_todo_request(messages) is True


def test_does_not_treat_personal_planning_as_explicit_shared_todo_request() -> None:
    messages = [
        StubMessage(
            MessageRole.USER,
            "I felt scattered today. Help me plan tomorrow, remind me to call my mom, and make sure I finish the release notes before lunch.",
        ),
        StubMessage(MessageRole.ASSISTANT, "Start with a narrow morning reset and one focused writing block."),
    ]

    assert is_explicit_todo_request(messages) is False


@pytest.mark.asyncio
async def test_orchestrator_rejects_llm_todo_result_without_explicit_shared_list_request() -> None:
    messages = [
        StubMessage(
            MessageRole.USER,
            "I felt scattered today. Help me plan tomorrow, remind me to call my mom, and make sure I finish the release notes before lunch.",
        ),
        StubMessage(MessageRole.ASSISTANT, "Start with a narrow morning reset and one focused writing block."),
    ]

    class StubClient:
        async def generate_json(self, **kwargs) -> ClassificationResult:
            return ClassificationResult(category=SessionCategory.TODO, reason="Wrongly treated reminders as a todo list.")

    orchestrator = ProcessingOrchestrator()
    orchestrator.client = StubClient()  # type: ignore[assignment]

    result = await orchestrator.classify(messages)  # type: ignore[arg-type]

    assert result.category == SessionCategory.JOURNAL


def test_does_not_extract_triplet_from_question_prompt() -> None:
    messages = [
        StubMessage(MessageRole.USER, "Explain how FastAPI uses uvloop in an async backend."),
        StubMessage(MessageRole.ASSISTANT, "FastAPI uses uvloop to run the event loop with high-performance async I/O."),
    ]

    triplets = heuristic_triplets(messages)  # type: ignore[arg-type]
    assert not any(triplet.subject.lower().startswith("explain") for triplet in triplets)
    assert any(triplet.subject == "FastAPI" and triplet.predicate == "uses" for triplet in triplets)


def test_idea_summary_generates_share_post() -> None:
    messages = [
        StubMessage(MessageRole.USER, "Brainstorm a local-first extension that turns AI chats into structured notes."),
        StubMessage(MessageRole.ASSISTANT, "A prototype would help validate the workflow quickly."),
    ]

    result = heuristic_idea(messages)  # type: ignore[arg-type]
    assert result.share_post
    assert len(result.share_post) <= 280


def test_journal_summary_includes_action_items() -> None:
    messages = [
        StubMessage(MessageRole.USER, "I need to call the contractor and should book the inspection tomorrow."),
        StubMessage(MessageRole.ASSISTANT, "Next, consider preparing the permit paperwork."),
    ]

    result = heuristic_journal(messages)  # type: ignore[arg-type]
    assert "call the contractor" in " ".join(result.action_items).lower()


def test_journal_summary_does_not_emit_ellipsis_for_long_assistant_message() -> None:
    messages = [
        StubMessage(MessageRole.USER, "What should I bring on a ski trip tomorrow?"),
        StubMessage(
            MessageRole.ASSISTANT,
            (
                "For your trip tomorrow, bring warm layers and waterproof gloves. "
                "Check the snow forecast before you leave. "
                "Pack sunscreen because the snow reflects UV strongly."
            ),
        ),
    ]

    result = heuristic_journal(messages)  # type: ignore[arg-type]
    assert "…" not in result.entry
    assert "For your trip tomorrow, bring warm layers and waterproof gloves." in result.entry


def test_journal_fallback_action_items_do_not_match_partial_words() -> None:
    messages = [
        StubMessage(MessageRole.USER, "What should I bring on a ski trip tomorrow?"),
        StubMessage(
            MessageRole.ASSISTANT,
            "Snow is starting in the late evening, but the current forecast is still uncertain.",
        ),
    ]

    result = heuristic_journal(messages)  # type: ignore[arg-type]
    assert not any("starting in the late evening" in item.lower() for item in result.action_items)


def test_heuristic_todo_update_rewrites_shared_file() -> None:
    messages = [
        StubMessage(MessageRole.USER, "Add buy milk to my to-do list and mark file taxes as done."),
    ]

    result = heuristic_todo_result(  # type: ignore[arg-type]
        messages,
        "# To-Do List\n\n## Active\n- [ ] File taxes\n\n## Done\n",
    )

    assert "buy milk" in result.summary.lower()
    assert "- [ ] buy milk" in result.updated_markdown
    assert "- [x] File taxes" in result.updated_markdown


def test_todo_items_parse_date_prefix_and_render_round_trip() -> None:
    from app.services.todo import parse_todo_items, render_todo_markdown

    markdown = (
        "# To-Do List\n\n"
        "## Active\n"
        "- [ ] (2026-05-01) Ship release\n"
        "- [ ] Buy milk\n\n"
        "## Done\n"
        "- [x] File taxes\n"
    )
    items = parse_todo_items(markdown)
    by_text = {item.text: item for item in items}
    assert by_text["Ship release"].deadline == "2026-05-01"
    assert by_text["Ship release"].is_persistent is False
    assert by_text["Buy milk"].deadline is None
    assert by_text["Buy milk"].is_persistent is True

    rendered = render_todo_markdown(items)
    # Dated item floats above the persistent one inside Active.
    assert rendered.index("- [ ] (2026-05-01) Ship release") < rendered.index("- [ ] Buy milk")
    assert "- [x] File taxes" in rendered


@pytest.mark.asyncio
async def test_classify_segments_splits_mixed_session_across_piles() -> None:
    from app.schemas.processing import SegmentedClassificationResult, SegmentRouting

    messages = [
        StubMessage(MessageRole.USER, "Today I had a great walk with mom and we talked about the garden."),
        StubMessage(MessageRole.ASSISTANT, "Sounds grounding."),
        StubMessage(MessageRole.USER, "Also, can you explain how FastAPI uses uvloop under the hood?"),
        StubMessage(MessageRole.ASSISTANT, "FastAPI delegates the event loop to uvloop."),
    ]

    class StubClient:
        async def generate_json(self, **kwargs) -> SegmentedClassificationResult:
            return SegmentedClassificationResult(
                segments=[
                    SegmentRouting(
                        pile_slug="journal",
                        reason="Personal day-to-day talk about the user's walk.",
                        start_index=0,
                        end_index=1,
                    ),
                    SegmentRouting(
                        pile_slug="factual",
                        reason="Technical explanation of FastAPI internals.",
                        start_index=2,
                        end_index=3,
                    ),
                ]
            )

    orchestrator = ProcessingOrchestrator()
    orchestrator.client = StubClient()  # type: ignore[assignment]

    segments = await orchestrator.classify_segments(messages)  # type: ignore[arg-type]
    assert [seg.pile_slug for seg in segments] == ["journal", "factual"]
    assert segments[0].start_index == 0 and segments[0].end_index == 1
    assert segments[1].start_index == 2 and segments[1].end_index == 3


@pytest.mark.asyncio
async def test_classify_segments_fills_trailing_gap_and_drops_bogus_todo() -> None:
    from app.schemas.processing import SegmentedClassificationResult, SegmentRouting

    messages = [
        StubMessage(MessageRole.USER, "I felt tired today and need to breathe."),
        StubMessage(MessageRole.ASSISTANT, "Rest helps."),
        StubMessage(MessageRole.USER, "Also add milk to something."),
        StubMessage(MessageRole.ASSISTANT, "ok."),
    ]

    class StubClient:
        async def generate_json(self, **kwargs) -> SegmentedClassificationResult:
            return SegmentedClassificationResult(
                segments=[
                    SegmentRouting(pile_slug="journal", reason="reflection", start_index=0, end_index=1),
                    # LLM mislabeled; not an explicit shared-list edit — should be dropped.
                    SegmentRouting(pile_slug="todo", reason="looks like a todo", start_index=2, end_index=2),
                ]
            )

    orchestrator = ProcessingOrchestrator()
    orchestrator.client = StubClient()  # type: ignore[assignment]

    segments = await orchestrator.classify_segments(messages)  # type: ignore[arg-type]
    # Bogus todo is dropped; the surviving journal segment is extended to cover the trailing messages.
    assert len(segments) == 1
    assert segments[0].pile_slug == "journal"
    assert segments[0].end_index == 3
