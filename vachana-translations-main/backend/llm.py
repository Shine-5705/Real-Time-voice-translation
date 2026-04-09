import asyncio
from typing import Optional

import aiohttp

# http://172.16.9.11:10021/voice_stream/translation_v2
BASE_URL = "http://172.16.9.11:10021"
TRANSLATION_PATH = "/voice_stream/translation"
# BASE_URL = "https://genvoice-appdevorc.gnani.site"
# TRANSLATION_PATH = "/voice_stream/translation"

_session: Optional[aiohttp.ClientSession] = None


async def get_session() -> aiohttp.ClientSession:
    global _session
    if _session is None or _session.closed:
        _session = aiohttp.ClientSession()
    return _session


async def close_session() -> None:
    global _session
    if _session and not _session.closed:
        await _session.close()
    _session = None


async def translate_text(
    text: str,
    source_lang: str = "en",
    target_lang: str = "hi-IN",
    translation_id: str = "trans_001",
    secret_key: str = "gnani_translate_2026",
) -> str:
    session = await get_session()
    payload = {
        "translation_id": translation_id,
        "secret_key": secret_key,
        "source_lang": source_lang,
        "target_lang": target_lang,
        "text": text,
    }

    async with session.post(
        f"{BASE_URL}{TRANSLATION_PATH}",
        json=payload,
        headers={"Content-Type": "application/json"},
    ) as response:
        response.raise_for_status()
        return await response.json()


async def main() -> None:
    result = await translate_text("What is this call about?")
    print(result)
    await close_session()


# if __name__ == "__main__":
#     asyncio.run(main())