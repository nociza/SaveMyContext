from __future__ import annotations

import httpx

from app.core.config import get_settings
from app.services.llm.base import LLMClient, SchemaT
from app.services.text import extract_json_object


class OpenAIClient(LLMClient):
    name = "openai"

    def __init__(self) -> None:
        settings = get_settings()
        self.api_key = settings.openai_api_key
        self.model = settings.openai_model
        self.timeout = settings.request_timeout_seconds

    async def generate_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        schema: type[SchemaT],
    ) -> SchemaT:
        if not self.api_key:
            raise RuntimeError("OpenAI API key is not configured.")

        payload = {
            "model": self.model,
            "temperature": 0.2,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers=headers,
                json=payload,
            )
            response.raise_for_status()
            data = response.json()

        content = data["choices"][0]["message"]["content"]
        parsed = extract_json_object(content)
        return schema.model_validate(parsed)

