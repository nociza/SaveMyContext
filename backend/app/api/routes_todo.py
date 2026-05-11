from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.dependencies import AuthContext, require_scope
from app.db.session import get_db_session
from app.models import ChatSession, BuiltInPileSlug
from app.schemas.todo import TodoGitStatus, TodoListItem, TodoListRead, TodoListUpdate
from app.services.git_versioning import GitVersioningService, GitRepositoryStatus
from app.services.accounts import session_account_key, session_account_label
from app.services.text import normalize_whitespace
from app.services.todo import TODO_TITLE, TodoItem, TodoListService, parse_todo_items, render_todo_markdown, sanitize_todo_items


router = APIRouter()


def _serialize_git(status: GitRepositoryStatus) -> TodoGitStatus:
    return TodoGitStatus(
        versioning_enabled=status.versioning_enabled,
        available=status.available,
        repository_ready=status.repository_ready,
        branch=status.branch,
        clean=status.clean,
        last_commit_short=status.last_commit_short,
        last_commit_message=status.last_commit_message,
        last_commit_at=status.last_commit_at,
    )


async def _todo_item_accounts(db: AsyncSession, items: list[TodoItem]) -> dict[str, tuple[str, str]]:
    item_keys = {normalize_whitespace(item.text).casefold() for item in items if normalize_whitespace(item.text)}
    if not item_keys:
        return {}

    result = await db.execute(
        select(ChatSession)
        .where(ChatSession.built_in_pile == BuiltInPileSlug.TODO)
        .order_by(ChatSession.updated_at.desc())
        .limit(200)
    )
    sessions = list(result.scalars().all())
    account_by_item: dict[str, tuple[str, str]] = {}
    for item_key in item_keys:
        for session in sessions:
            haystack = normalize_whitespace(
                " ".join([session.title or "", session.todo_summary or "", session.share_post or ""])
            ).casefold()
            if item_key and item_key in haystack:
                account_by_item[item_key] = (session_account_key(session), session_account_label(session))
                break
    return account_by_item


async def _build_todo_response(
    todo_service: TodoListService,
    git_service: GitVersioningService,
    db: AsyncSession,
) -> TodoListRead:
    content = todo_service.read_markdown()
    items = parse_todo_items(content)
    accounts = await _todo_item_accounts(db, items)
    completed_count = sum(1 for item in items if item.done)
    return TodoListRead(
        title=TODO_TITLE,
        content=content,
        items=[
            TodoListItem(
                text=item.text,
                done=item.done,
                account_key=accounts.get(normalize_whitespace(item.text).casefold(), (None, None))[0],
                account_label=accounts.get(normalize_whitespace(item.text).casefold(), (None, None))[1],
            )
            for item in items
        ],
        active_count=len(items) - completed_count,
        completed_count=completed_count,
        total_count=len(items),
        git=_serialize_git(await git_service.describe()),
    )


@router.get("/todo", response_model=TodoListRead, response_model_exclude_none=True)
async def read_todo_list(
    _: AuthContext = Depends(require_scope("read")),
    db: AsyncSession = Depends(get_db_session),
) -> TodoListRead:
    todo_service = TodoListService()
    git_service = GitVersioningService(repo_root=todo_service.vault_root)
    return await _build_todo_response(todo_service, git_service, db)


@router.put("/todo", response_model=TodoListRead, response_model_exclude_none=True)
async def update_todo_list(
    payload: TodoListUpdate,
    _: AuthContext = Depends(require_scope("ingest")),
    db: AsyncSession = Depends(get_db_session),
) -> TodoListRead:
    todo_service = TodoListService()
    git_service = GitVersioningService(repo_root=todo_service.vault_root)
    items = sanitize_todo_items([TodoItem(text=item.text, done=item.done) for item in payload.items])
    todo_service.write_markdown(render_todo_markdown(items))
    summary = normalize_whitespace(payload.summary or "") or "Update shared to-do list"
    await git_service.ensure_repo()
    await git_service.commit_all(message=summary)
    return await _build_todo_response(todo_service, git_service, db)
