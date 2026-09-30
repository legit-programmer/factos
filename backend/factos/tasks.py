import asyncio


async def blocking(function, *args):
    """Do not leave a disk-publishing/parser thread behind when its owning task is cancelled."""
    task = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await task
        raise
