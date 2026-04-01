from __future__ import annotations

import httpx

from app.core.config import get_settings
from app.services.llm.base import LLMClient, SchemaT
from app.services.text import extract_json_object


class GoogleGenAIClient(LLMClient):
    name = "google"

    def __init__(self) -> None:
        settings = get_settings()
        self.api_key = settings.google_api_key
        self.model = settings.google_model
        self.timeout = settings.request_timeout_seconds

    async def generate_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        schema: type[SchemaT],
    ) -> SchemaT:
        if not self.api_key:
            raise RuntimeError("Google API key is not configured.")

        payload = {
            "systemInstruction": {"parts": [{"text": system_prompt}]},
            "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
            "generationConfig": {
                "temperature": 0.2,
                "responseMimeType": "application/json",
            },
        }
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{self.model}:generateContent?key={self.api_key}"
        )
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(url, json=payload)
            response.raise_for_status()
            data = response.json()

        content = data["candidates"][0]["content"]["parts"][0]["text"]
        parsed = extract_json_object(content)
        return schema.model_validate(parsed)

