"""Shared dispatch for synchronous and asynchronous extension handlers."""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar, cast

import anyio.to_thread
from pydantic import BaseModel

ResultT = TypeVar("ResultT", bound=BaseModel)


async def call_handler(handler: Callable[..., ResultT | Awaitable[ResultT]], *args: Any) -> ResultT:
    if inspect.iscoroutinefunction(handler) or inspect.iscoroutinefunction(handler.__call__):
        result = handler(*args)
    else:
        result = await anyio.to_thread.run_sync(handler, *args)
    return cast(ResultT, await result if inspect.isawaitable(result) else result)
