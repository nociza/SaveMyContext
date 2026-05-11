from __future__ import annotations

from typing import Any

import httpx

from app.core.config import (
    DEFAULT_OPENROUTER_BASE_URL,
    DEFAULT_OPENROUTER_MODEL,
    DEFAULT_OPENROUTER_MODEL_FALLBACKS,
    Settings,
    get_settings,
    unique_nonempty_models,
)
from app.schemas.llm import LLMModelOption, LLMOptionsResponse, LLMServiceStatus
from app.services.processing_worker import immediate_processing_model, uses_extension_browser_processing


CATALOG_TIMEOUT_SECONDS = 8.0


class LLMOptionsService:
    def __init__(self, *, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()

    async def options(self, *, include_openrouter_catalog: bool = False, limit: int = 200) -> LLMOptionsResponse:
        catalog: list[LLMModelOption] = []
        catalog_error: str | None = None
        if include_openrouter_catalog:
            try:
                catalog = await self._fetch_openrouter_models(limit=limit)
            except Exception as exc:  # noqa: BLE001 - catalog failure should not break settings UI
                catalog_error = str(exc)

        candidates = self.settings.resolved_openai_model_candidates
        suggested = unique_nonempty_models(
            [
                *candidates,
                DEFAULT_OPENROUTER_MODEL,
                *DEFAULT_OPENROUTER_MODEL_FALLBACKS,
            ]
        )

        return LLMOptionsResponse(
            current_backend=self.settings.llm_backend,
            openrouter_configured=self._openrouter_configured(),
            openrouter_base_url=DEFAULT_OPENROUTER_BASE_URL,
            default_model=immediate_processing_model(self.settings) or self.settings.browser_llm_model,
            model_candidates=candidates,
            suggested_models=suggested,
            services=self._service_statuses(),
            openrouter_models=catalog,
            catalog_error=catalog_error,
        )

    def _service_statuses(self) -> list[LLMServiceStatus]:
        direct_model = immediate_processing_model(self.settings)
        direct_available = direct_model is not None
        browser_enabled = uses_extension_browser_processing(self.settings)
        browser_available = self.settings.experimental_browser_automation and self.settings.llm_backend.lower() == "browser_proxy"
        backend = self.settings.llm_backend.lower()
        direct_backend = "openai_compatible" if direct_model == self.settings.resolved_openai_model else backend

        return [
            LLMServiceStatus(
                id="chat_ingest.classifier",
                label="Chat ingest classifier",
                backend=direct_backend,
                model=direct_model,
                available=direct_available,
                notes="Routes captured chat sessions into built-in, discarded, or user-defined piles.",
            ),
            LLMServiceStatus(
                id="chat_ingest.extractors",
                label="Pile extractors",
                backend=direct_backend,
                model=direct_model,
                available=direct_available,
                notes="Runs journal, factual, ideas, todo, and custom pile extraction; per-pile OpenRouter overrides can replace this model.",
            ),
            LLMServiceStatus(
                id="source_capture.enrichment",
                label="Source capture enrichment",
                backend=direct_backend,
                model=direct_model,
                available=direct_available,
                notes="Cleans and classifies saved page or selection captures when AI save mode is used.",
            ),
            LLMServiceStatus(
                id="browser_queue.worker",
                label="Extension browser worker",
                backend="browser_proxy",
                model=self.settings.browser_llm_model if browser_available else None,
                available=browser_enabled,
                notes="Only used when llm_backend=browser_proxy and browser automation is enabled.",
            ),
        ]

    def _openrouter_configured(self) -> bool:
        return (
            self.settings.openrouter_key_detected
            or self.settings.resolved_openai_base_url.rstrip("/") == DEFAULT_OPENROUTER_BASE_URL
        )

    async def _fetch_openrouter_models(self, *, limit: int) -> list[LLMModelOption]:
        headers: dict[str, str] = {}
        if self.settings.openai_api_key and self._openrouter_configured():
            headers["Authorization"] = f"Bearer {self.settings.openai_api_key}"
        async with httpx.AsyncClient(timeout=CATALOG_TIMEOUT_SECONDS) as client:
            response = await client.get(f"{DEFAULT_OPENROUTER_BASE_URL}/models", headers=headers)
            response.raise_for_status()
            payload = response.json()

        items = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(items, list):
            return []
        models: list[LLMModelOption] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            model_id = item.get("id")
            if not isinstance(model_id, str) or not model_id.strip():
                continue
            models.append(self._model_option(item, model_id.strip()))
            if len(models) >= max(1, min(limit, 1000)):
                break
        return models

    @staticmethod
    def _model_option(item: dict[str, Any], model_id: str) -> LLMModelOption:
        pricing = item.get("pricing") if isinstance(item.get("pricing"), dict) else {}
        context_length = item.get("context_length")
        return LLMModelOption(
            id=model_id,
            name=item.get("name") if isinstance(item.get("name"), str) else None,
            context_length=context_length if isinstance(context_length, int) else None,
            prompt_price=pricing.get("prompt") if isinstance(pricing.get("prompt"), str) else None,
            completion_price=pricing.get("completion") if isinstance(pricing.get("completion"), str) else None,
        )
