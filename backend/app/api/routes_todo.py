from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.dependencies import AuthContext, require_scope
from app.schemas.todo import TodoGitStatus, TodoListItem, TodoListRead, TodoListUpdate
from app.services.git_versioning import GitVersioningService, GitRepositoryStatus
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


async def _build_todo_response(todo_service: TodoListService, git_service: GitVersioningService) -> TodoListRead:
    content = todo_service.read_markdown()
    items = parse_todo_items(content)
    completed_count = sum(1 for item in items if item.done)
    return TodoListRead(
        title=TODO_TITLE,
        content=content,
        items=[TodoListItem(text=item.text, done=item.done) for item in items],
        active_count=len(items) - completed_count,
        completed_count=completed_count,
        total_count=len(items),
        git=_serialize_git(await git_service.describe()),
    )


@router.get("/todo", response_model=TodoListRead)
async def read_todo_list(
    _: AuthContext = Depends(require_scope("read")),
) -> TodoListRead:
    todo_service = TodoListService()
    git_service = GitVersioningService(repo_root=todo_service.vault_root)
    return await _build_todo_response(todo_service, git_service)


@router.put("/todo", response_model=TodoListRead)
async def update_todo_list(
    payload: TodoListUpdate,
    _: AuthContext = Depends(require_scope("ingest")),
) -> TodoListRead:
    todo_service = TodoListService()
    git_service = GitVersioningService(repo_root=todo_service.vault_root)
    items = sanitize_todo_items([TodoItem(text=item.text, done=item.done) for item in payload.items])
    todo_service.write_markdown(render_todo_markdown(items))
    summary = normalize_whitespace(payload.summary or "") or "Update shared to-do list"
    await git_service.ensure_repo()
    await git_service.commit_all(message=summary)
    return await _build_todo_response(todo_service, git_service)
