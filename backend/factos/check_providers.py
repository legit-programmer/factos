"""Explicit operator smoke check. Requires credentials and makes small paid API requests."""

import asyncio
import io
import json

from google.genai import types
from PIL import Image

from .config import Settings
from .providers import Providers
from .retrieval import normalize


async def main():
    settings = Settings()
    provider = Providers(settings)
    try:
        provider.ready()
        provider.ready(embeddings=True)
        vectors = await provider.embed_documents(["Factos capability check"])
        normalize(vectors, settings.embedding_dimension)
        image_bytes = io.BytesIO()
        Image.new("RGB", (8, 8), "white").save(image_bytes, format="PNG")
        contents = [
            types.Content(
                role="user",
                parts=[
                    types.Part.from_text(text="Reply with the word ready."),
                    types.Part.from_bytes(data=image_bytes.getvalue(), mime_type="image/png"),
                ],
            )
        ]
        stream = await provider.google.aio.models.generate_content_stream(
            model=settings.gemini_model,
            contents=contents,
            config=types.GenerateContentConfig(max_output_tokens=128),
        )
        output, finish = "", None
        async for chunk in stream:
            output += chunk.text or ""
            if chunk.candidates and chunk.candidates[0].finish_reason:
                finish = chunk.candidates[0].finish_reason
        if not output.strip() or finish != types.FinishReason.STOP:
            raise RuntimeError("Gemini streaming/image-input capability check failed")
        response = await provider.google.aio.models.generate_content(
            model=settings.gemini_model,
            contents="Return JSON with ready=true.",
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_json_schema={
                    "type": "object",
                    "properties": {"ready": {"type": "boolean"}},
                    "required": ["ready"],
                },
            ),
        )
        if json.loads(response.text) != {"ready": True}:
            raise RuntimeError("Gemini structured-output capability check failed")
        declaration = types.FunctionDeclaration(
            name="ready_check",
            description="Signal readiness",
            parameters_json_schema={"type": "object", "properties": {}},
        )
        response = await provider.google.aio.models.generate_content(
            model=settings.gemini_model,
            contents="Call ready_check.",
            config=types.GenerateContentConfig(
                tools=[types.Tool(function_declarations=[declaration])],
                tool_config=types.ToolConfig(function_calling_config=types.FunctionCallingConfig(mode="ANY")),
                automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
            ),
        )
        if not response.function_calls or response.function_calls[0].name != "ready_check":
            raise RuntimeError("Gemini function-calling capability check failed")
        # Preserve signatures and call IDs in a follow-up tools-disabled request.
        call = response.function_calls[0]
        paired = [
            types.Content(role="user", parts=[types.Part.from_text(text="Call ready_check.")]),
            response.candidates[0].content,
            types.Content(
                role="user",
                parts=[
                    types.Part(
                        function_response=types.FunctionResponse(
                            id=call.id, name=call.name, response={"ready": True}
                        )
                    )
                ],
            ),
        ]
        final = await provider.google.aio.models.generate_content(
            model=settings.gemini_model, contents=paired
        )
        if not final.text:
            raise RuntimeError("Gemini function-result pairing check failed")
        print(
            "OpenAI embeddings and Gemini streaming, image input, structured output and function pairing passed."
        )
        print(
            "Firecrawl requires a separate bounded source-ingestion smoke check against an approved public website."
        )
    finally:
        await provider.close()


if __name__ == "__main__":
    asyncio.run(main())
