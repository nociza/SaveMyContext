from __future__ import annotations

import asyncio

from app.core.config import Settings, get_settings
from app.services.agentic_search.models import VaultSearchCandidate
from app.services.agentic_search.tools import VaultSearchToolkit


class LocalVaultSearchService:
    """Deterministic local search over the configured SaveMyContext vault."""

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.toolkit = VaultSearchToolkit(self.settings)

    @property
    def available(self) -> bool:
        return bool(self.toolkit.search_roots())

    async def search(self, query: str, *, limit: int = 10) -> list[VaultSearchCandidate]:
        cleaned_query = query.strip()
        if not cleaned_query or not self.available:
            return []
        hits = await asyncio.to_thread(self.toolkit.search, cleaned_query, limit=limit)
        return [
            VaultSearchCandidate(
                path=hit.path,
                reason="Matched the query in the local vault.",
                snippet=hit.snippet,
            )
            for hit in hits
        ]


# Compatibility alias for plugins that imported the original class name.
ADKVaultSearchService = LocalVaultSearchService
