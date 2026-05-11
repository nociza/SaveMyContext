from __future__ import annotations

from pydantic import BaseModel, Field


class LLMServiceStatus(BaseModel):
    id: str
    label: str
    backend: str
    model: str | None = None
    available: bool
    notes: str | None = None


class LLMModelOption(BaseModel):
    id: str
    name: str | None = None
    context_length: int | None = None
    prompt_price: str | None = None
    completion_price: str | None = None


class LLMOptionsResponse(BaseModel):
    current_backend: str
    openrouter_configured: bool
    openrouter_base_url: str
    default_model: str | None = None
    model_candidates: list[str] = Field(default_factory=list)
    suggested_models: list[str] = Field(default_factory=list)
    services: list[LLMServiceStatus] = Field(default_factory=list)
    openrouter_models: list[LLMModelOption] = Field(default_factory=list)
    catalog_error: str | None = None
