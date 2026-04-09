from fastapi import APIRouter, HTTPException, Path, Query

from db.mongo_helper import get_session_result_audio, list_session_results_paginated, list_sessions_paginated

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


@router.get("")
async def list_sessions(
    page: int = Query(1, ge=1, description="Page number (1-indexed)"),
    page_size: int = Query(20, ge=1, le=100, description="Number of sessions per page"),
):
    return await list_sessions_paginated(page=page, page_size=page_size)


@router.get("/{session_id}/results")
async def list_session_results(
    session_id: str = Path(..., min_length=1, description="Session identifier"),
    page: int = Query(1, ge=1, description="Page number (1-indexed)"),
    page_size: int = Query(20, ge=1, le=100, description="Number of results per page"),
    include_audio: bool = Query(False, description="Include base64 audio in list response"),
):
    return await list_session_results_paginated(
        session_id,
        page=page,
        page_size=page_size,
        include_audio=include_audio,
    )


@router.get("/{session_id}/results/{result_id}/audio")
async def get_result_audio(
    session_id: str = Path(..., min_length=1, description="Session identifier"),
    result_id: str = Path(..., min_length=1, description="Result document identifier"),
):
    payload = await get_session_result_audio(session_id, result_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="Result not found")
    return payload
