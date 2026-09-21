"""Inspect or rebuild the Basic Memory projection, without changing source records."""

import argparse
import asyncio
import json

from sqlalchemy import select, update

from app.db.session import SessionLocal, init_db
from app.workspace.knowledge import inventory, status, sync_once
from app.workspace.models import KnowledgeProjection


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["status", "sync", "rebuild"])
    args = parser.parse_args()
    await init_db()
    if args.action == "rebuild":
        async with SessionLocal() as db:
            await db.execute(
                update(KnowledgeProjection).values(fingerprint="rebuild-requested")
            )
            await db.commit()
    if args.action == "sync":
        print(json.dumps({"processed": await sync_once(SessionLocal)}))
    async with SessionLocal() as db:
        wanted = await inventory(db)
        indexed = {
            p.key: p.fingerprint
            for p in (await db.scalars(select(KnowledgeProjection))).all()
        }
        print(
            json.dumps(
                {
                    **await status(db),
                    "total": len(wanted),
                    "pending": sum(indexed.get(k) != v for k, v in wanted.items()),
                }
            )
        )


if __name__ == "__main__":
    asyncio.run(main())
