from __future__ import annotations

from dataclasses import dataclass

from pydantic import BaseModel, Field


@dataclass(slots=True)
class VaultSearchHit:
    path: str
    score: int
    snippet: str
    line_number: int | None = None


class VaultSearchCandidate(BaseModel):
    path: str
    reason: str
    snippet: str = ""


class VaultSearchResponse(BaseModel):
    results: list[VaultSearchCandidate] = Field(default_factory=list)


# Compatibility aliases for integrations that imported the pre-0.2.4 names.
AgenticSearchCandidate = VaultSearchCandidate
AgenticSearchResponse = VaultSearchResponse
