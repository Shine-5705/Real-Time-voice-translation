from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from bson import ObjectId
from bson.errors import InvalidId
from pymongo.asynchronous.mongo_client import AsyncMongoClient

from backend.constants import (
    MONGODB_COLLECTION_CONVERSATION_INFO,
    MONGODB_CONN_URL,
    MONGODB_DB_NAME,
)

_mongo_client: AsyncMongoClient | None = None


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _utc_now_dt() -> datetime:
    return datetime.now(timezone.utc)


def _coerce_utc_dt(value: datetime | str | None) -> datetime:
    if value is None:
        return _utc_now_dt()
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _round_seconds_ms_precision(value: float) -> float:
    # Keep at most 3 digits after decimal point.
    return round(float(value), 3)


def _round_optional_seconds_ms_precision(value: float | None) -> float | None:
    if value is None:
        return None
    return _round_seconds_ms_precision(value)


def _dt_to_iso_utc(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    else:
        value = value.astimezone(timezone.utc)
    return value.isoformat().replace("+00:00", "Z")


def _get_client() -> AsyncMongoClient:
    global _mongo_client
    if _mongo_client is None:
        _mongo_client = AsyncMongoClient(MONGODB_CONN_URL)
    return _mongo_client


def _get_collection():
    client = _get_client()
    return client[MONGODB_DB_NAME][MONGODB_COLLECTION_CONVERSATION_INFO]


async def init_conversation(
    session_id: str,
    source: str,
    metadata: dict[str, Any] | None = None,
) -> None:
    collection = _get_collection()
    await collection.update_one(
        {"_id": session_id},
        {
            "$setOnInsert": {
                "_id": session_id,
                "doc_type": "session",
                "source": source,
                "metadata": metadata or {},
                "created_at": _utc_now_dt(),
                "first_final_result_timestamp": None,
            }
        },
        upsert=True,
    )


async def append_final_result(
    session_id: str,
    *,
    source_text: str,
    translated_texts: dict[str, str],
    audio_base64: str,
    audio_base64s: dict[str, str] | None = None,
    llm_latency_seconds: float,
    tts_generation_delay_seconds: float,
    tts_first_token_latency_seconds: float | None = None,
    timestamp_iso: datetime | str | None = None,
    speaker_id: str | None = None,
) -> dict[str, int | str]:
    collection = _get_collection()
    now_dt = _coerce_utc_dt(timestamp_iso)
    session_result = await collection.update_one(
        {"_id": session_id},
        {
            "$setOnInsert": {
                "_id": session_id,
                "doc_type": "session",
                "created_at": _utc_now_dt(),
                "first_final_result_timestamp": None,
            }
        },
        upsert=True,
    )
    doc = {
        "doc_type": "final_result",
        "session_id": session_id,
        "timestamp": now_dt,
        "source_text": source_text,
        "source_text_length": len(source_text or ""),
        "translated_texts": translated_texts,
        "audio_base64": audio_base64,
        "audio_base64s": audio_base64s or {},
        "llm_latency_seconds": _round_seconds_ms_precision(llm_latency_seconds),
        "tts_generation_delay_seconds": _round_seconds_ms_precision(tts_generation_delay_seconds),
        "tts_first_token_latency_seconds": _round_optional_seconds_ms_precision(
            tts_first_token_latency_seconds
        ),
        "speaker_id": speaker_id,
        "created_at": _utc_now_dt(),
        "updated_at": _utc_now_dt(),
    }
    insert_result = await collection.insert_one(doc)
    first_ts_result = await collection.update_one(
        {
            "_id": session_id,
            "$or": [
                {"first_final_result_timestamp": None},
                {"first_final_result_timestamp": {"$exists": False}},
            ],
        },
        {"$set": {"first_final_result_timestamp": now_dt}},
    )
    return {
        "session_matched_count": int(session_result.matched_count),
        "session_modified_count": int(session_result.modified_count),
        "session_upserted_count": 1 if session_result.upserted_id is not None else 0,
        "result_inserted_count": 1 if insert_result.inserted_id is not None else 0,
        "result_id": str(insert_result.inserted_id),
        "first_ts_matched_count": int(first_ts_result.matched_count),
        "first_ts_modified_count": int(first_ts_result.modified_count),
    }


async def update_final_result_audio(
    session_id: str,
    *,
    timestamp_iso: datetime | str,
    audio_base64: str,
    audio_base64s: dict[str, str] | None = None,
    tts_generation_delay_seconds: float,
    tts_first_token_latency_seconds: float | None = None,
) -> dict[str, int]:
    collection = _get_collection()
    timestamp_dt = _coerce_utc_dt(timestamp_iso)
    update_result = await collection.update_one(
        {"doc_type": "final_result", "session_id": session_id, "timestamp": timestamp_dt},
        {
            "$set": {
                "audio_base64": audio_base64,
                "audio_base64s": audio_base64s or {},
                "tts_generation_delay_seconds": _round_seconds_ms_precision(tts_generation_delay_seconds),
                "tts_first_token_latency_seconds": _round_optional_seconds_ms_precision(
                    tts_first_token_latency_seconds
                ),
                "updated_at": _utc_now_dt(),
            }
        },
    )
    return {
        "matched_count": int(update_result.matched_count),
        "modified_count": int(update_result.modified_count),
    }


async def list_sessions_paginated(*, page: int = 1, page_size: int = 20) -> dict[str, Any]:
    collection = _get_collection()
    skip = (page - 1) * page_size

    total_pipeline = [
        {"$match": {"doc_type": "final_result", "session_id": {"$exists": True}}},
        {"$group": {"_id": "$session_id"}},
        {"$count": "total"},
    ]
    total_cursor = await collection.aggregate(total_pipeline)
    total_result = await total_cursor.to_list(length=1)
    total_count = int(total_result[0]["total"]) if total_result else 0

    pipeline = [
        {"$match": {"doc_type": "final_result", "session_id": {"$exists": True}}},
        {
            "$group": {
                "_id": "$session_id",
                "last_created_at": {"$max": "$created_at"},
                "first_created_at": {"$min": "$created_at"},
                "result_count": {"$sum": 1},
            }
        },
        {"$sort": {"last_created_at": -1}},
        {"$skip": skip},
        {"$limit": page_size},
    ]

    rows_cursor = await collection.aggregate(pipeline)
    rows = await rows_cursor.to_list(length=page_size)
    sessions = [
        {
            "session_id": str(row["_id"]),
            "result_count": int(row.get("result_count", 0)),
            "first_created_at": _dt_to_iso_utc(row.get("first_created_at")),
            "last_created_at": _dt_to_iso_utc(row.get("last_created_at")),
        }
        for row in rows
    ]

    return {
        "items": sessions,
        "pagination": {
            "page": page,
            "page_size": page_size,
            "total_items": total_count,
            "total_pages": max(1, (total_count + page_size - 1) // page_size),
        },
    }


async def list_session_results_paginated(
    session_id: str, *, page: int = 1, page_size: int = 20, include_audio: bool = False
) -> dict[str, Any]:
    collection = _get_collection()
    skip = (page - 1) * page_size
    query = {"doc_type": "final_result", "session_id": session_id}

    total_count = await collection.count_documents(query)
    projection = None
    if not include_audio:
        projection = {"audio_base64": 0, "audio_base64s": 0}

    cursor = collection.find(query, projection=projection).sort("created_at", -1).skip(skip).limit(page_size)
    rows = await cursor.to_list(length=page_size)

    results = [
        {
            "id": str(row.get("_id")),
            "session_id": row.get("session_id"),
            "source_text": row.get("source_text", ""),
            "source_text_length": row.get("source_text_length", len(row.get("source_text", ""))),
            "translated_texts": row.get("translated_texts") or {},
            "audio_base64": row.get("audio_base64") if include_audio else None,
            "audio_base64s": row.get("audio_base64s")
            if include_audio
            else None,
            "speaker_id": row.get("speaker_id"),
            "timestamp": _dt_to_iso_utc(row.get("timestamp")),
            "created_at": _dt_to_iso_utc(row.get("created_at")),
            "updated_at": _dt_to_iso_utc(row.get("updated_at")),
        }
        for row in rows
    ]

    return {
        "items": results,
        "pagination": {
            "page": page,
            "page_size": page_size,
            "total_items": total_count,
            "total_pages": max(1, (total_count + page_size - 1) // page_size),
        },
    }


async def get_session_result_audio(session_id: str, result_id: str) -> dict[str, Any] | None:
    collection = _get_collection()
    query: dict[str, Any] = {"doc_type": "final_result", "session_id": session_id}
    try:
        query["_id"] = ObjectId(result_id)
    except InvalidId:
        query["_id"] = result_id

    row = await collection.find_one(
        query,
        projection={"audio_base64": 1, "audio_base64s": 1, "updated_at": 1},
    )
    if row is None:
        return None

    return {
        "id": str(row.get("_id")),
        "session_id": session_id,
        "audio_base64": row.get("audio_base64"),
        "audio_base64s": row.get("audio_base64s") or {},
        "updated_at": _dt_to_iso_utc(row.get("updated_at")),
    }

