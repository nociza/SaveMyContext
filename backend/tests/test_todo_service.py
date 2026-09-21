from __future__ import annotations

import pytest

from app.services.todo import TodoListConflictError, TodoListService


def test_todo_revision_prevents_overwriting_a_newer_manual_edit(tmp_path) -> None:
    service = TodoListService(base_dir=tmp_path)
    _, original_revision = service.read_with_revision()
    manual_markdown = "# To-Do List\n\n## Active\n- [ ] Keep manual edit\n\n## Done\n"
    service.write_markdown(manual_markdown)

    with pytest.raises(TodoListConflictError, match="changed"):
        service.write_markdown(
            "# To-Do List\n\n## Active\n- [ ] Stale AI edit\n\n## Done\n",
            expected_revision=original_revision,
        )

    assert "Keep manual edit" in service.read_markdown()
    assert "Stale AI edit" not in service.read_markdown()
