from __future__ import annotations

import json
from pathlib import Path

from app.core.config import get_settings
from app.models import ChatSession


class MarkdownExporter:
    def __init__(self) -> None:
        settings = get_settings()
        self.base_dir = settings.resolved_markdown_dir

    async def write_session(self, session: ChatSession) -> Path:
        self.base_dir.mkdir(parents=True, exist_ok=True)
        filename = f"{session.provider.value}--{session.external_session_id}.md".replace("/", "-")
        target = self.base_dir / filename
        target.write_text(self.render(session), encoding="utf-8")
        return target

    def render(self, session: ChatSession) -> str:
        lines = [
            f"# {session.title or session.external_session_id}",
            "",
            f"- Provider: `{session.provider.value}`",
            f"- External Session ID: `{session.external_session_id}`",
            f"- Category: `{session.category.value if session.category else 'unclassified'}`",
            f"- Source URL: {session.source_url or 'n/a'}",
            f"- Tags: {', '.join(session.custom_tags) if session.custom_tags else 'none'}",
            f"- Last Captured: {session.last_captured_at.isoformat() if session.last_captured_at else 'n/a'}",
            "",
            "## Transcript",
            "",
        ]
        for message in session.messages:
            header = f"### {message.role.value.title()}"
            if message.occurred_at:
                header += f" ({message.occurred_at.isoformat()})"
            lines.extend([header, "", message.content.strip(), ""])

        if session.journal_entry:
            lines.extend(["## Journal Entry", "", session.journal_entry.strip(), ""])

        if session.triplets:
            lines.extend(["## Fact Triplets", ""])
            for triplet in session.triplets:
                lines.append(f"- {triplet.subject} | {triplet.predicate} | {triplet.object}")
            lines.append("")

        if session.idea_summary:
            lines.extend(
                [
                    "## Idea Summary",
                    "",
                    "```json",
                    json.dumps(session.idea_summary, indent=2),
                    "```",
                    "",
                ]
            )

        if session.share_post:
            lines.extend(["## Share Post", "", session.share_post.strip(), ""])

        return "\n".join(lines).strip() + "\n"
