from __future__ import annotations

from datetime import datetime, timezone

from app.models import ChatMessage, ChatSession, MessageRole, ProviderName, SessionCategory
from app.services.markdown import MarkdownExporter


def test_markdown_renderer_includes_transcript() -> None:
    session = ChatSession(
        provider=ProviderName.CHATGPT,
        external_session_id="session-1",
        title="Test Session",
        category=SessionCategory.JOURNAL,
        custom_tags=["daily"],
        last_captured_at=datetime.now(timezone.utc),
    )
    session.messages = [
        ChatMessage(
            session_id="session-1",
            external_message_id="m-1",
            role=MessageRole.USER,
            content="Need to review the project plan.",
            sequence_index=1,
        )
    ]

    markdown = MarkdownExporter().render(session)
    assert "# Test Session" in markdown
    assert "## Transcript" in markdown
    assert "Need to review the project plan." in markdown

