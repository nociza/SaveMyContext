"""Transactional upstream project identity; never infers projects from chat text."""

from datetime import timezone

from sqlalchemy import select

from app.workspace.models import Event, Project, ProviderProject, SourceProjectBinding
from app.workspace.store import digest


async def lock_manual_project(db, source_id):
    binding = await db.get(SourceProjectBinding, source_id)
    if binding is None:
        binding = SourceProjectBinding(source_id=source_id, manual=True)
        db.add(binding)
    else:
        binding.manual = True


async def apply_provider_project(db, source, payload, account_key):
    # Omitted means unknown, not "removed from a project". An undated capture
    # cannot safely overwrite membership observed previously.
    if (
        "provider_project" not in payload.model_fields_set
        or payload.captured_at is None
    ):
        return
    captured = payload.captured_at
    observed = (
        captured.replace(tzinfo=timezone.utc).timestamp()
        if captured.tzinfo is None
        else captured.timestamp()
    )
    binding = await db.get(SourceProjectBinding, source.id)
    if binding is not None and observed <= binding.observed_at:
        return
    if binding is None:
        # Preserve pre-upgrade manual assignments, including explicit unassignment.
        events = (
            await db.scalars(
                select(Event).where(
                    Event.object_id == source.id, Event.action == "updated"
                )
            )
        ).all()
        manual = source.project_id is not None or any(
            "project_id" in event.payload for event in events
        )
        binding = SourceProjectBinding(source_id=source.id, manual=manual)
        db.add(binding)
    remote = None
    context = payload.provider_project
    if context is not None:
        # Provider IDs are stable within an account. workspace_id is metadata:
        # missing it in an ordinary detail response must not duplicate projects.
        identity = digest([payload.provider.value, account_key, context.id])
        remote = await db.get(ProviderProject, identity)
        if remote is None:
            # Deterministic suffix avoids races/name collisions with personal projects.
            name = (context.name or "ChatGPT Project").strip() or "ChatGPT Project"
            project = Project(
                name=f"{name[:98]} [ChatGPT {identity[:10]}]",
                description="Imported ChatGPT project. Shared context is preserved as evidence, not instructions.",
            )
            db.add(project)
            await db.flush()
            remote = ProviderProject(
                id=identity,
                project_id=project.id,
                provider=payload.provider.value,
                account_key=account_key,
                external_id=context.id,
                context={},
                observed_at=0.0,
            )
            db.add(remote)
        if observed > remote.observed_at:
            values = context.model_dump(mode="json", exclude_none=True)
            # Sparse detail responses must not erase richer sidebar metadata.
            remote.context = {**remote.context, **values}
            remote.observed_at = observed
            project = await db.get(Project, remote.project_id)
            if context.name and context.name.strip():
                project.name = f"{context.name.strip()[:98]} [ChatGPT {identity[:10]}]"
        await db.flush()
    binding.provider_project_id = remote.id if remote else None
    binding.observed_at = observed
    if not binding.manual:
        source.project_id = remote.project_id if remote else None


async def project_records(db, projects):
    from app.workspace.store import record

    upstream = {
        p.project_id: p for p in (await db.scalars(select(ProviderProject))).all()
    }
    return [
        {
            **record(p),
            **(
                {
                    "provider_context": upstream[p.id].context,
                    "origin": upstream[p.id].provider,
                }
                if p.id in upstream
                else {}
            ),
        }
        for p in projects
    ]
