"""Exercise mention handler dispatch through the real MCP SDK."""

from __future__ import annotations

import asyncio
import threading
import unittest
from collections.abc import Awaitable
from contextvars import ContextVar
from typing import Any
from unittest.mock import patch

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.context import Context
from mcp.server.mcpserver.exceptions import UnexpectedToolError

from openai_mcp_extensions import (
    OpenAIExtensions,
    OpenAIMentionResource,
    OpenAIMentionSearchParams,
    OpenAIMentionSearchResult,
)


class MentionHandlerTests(unittest.IsolatedAsyncioTestCase):
    async def test_blocking_sync_handler_keeps_loop_responsive(self) -> None:
        extensions = OpenAIExtensions()
        started = threading.Event()
        released = threading.Event()
        request_id = ContextVar("request_id", default="unset")
        token = request_id.set("request-42")
        loop_thread = threading.get_ident()
        observations: list[tuple[int, str, bool]] = []

        @extensions.mentions.search
        def search(
            params: OpenAIMentionSearchParams, ctx: Context[Any, Any]
        ) -> OpenAIMentionSearchResult:
            self.assertEqual(params.query, "needle")
            self.assertIs(ctx.mcp_server, server)
            started.set()
            progressed = released.wait(timeout=5)
            observations.append((threading.get_ident(), request_id.get(), progressed))
            return OpenAIMentionSearchResult(
                items=[OpenAIMentionResource(resource_uri="file:///result", title="Found")]
            )

        server = MCPServer("mentions", extensions=[extensions])

        async def release_from_loop() -> None:
            while not started.is_set():
                await asyncio.sleep(0.001)
            released.set()

        peer = asyncio.create_task(release_from_loop())
        try:
            result = await asyncio.wait_for(
                server.call_tool("search_mentions", {"query": "needle"}), timeout=10
            )
            await peer
        finally:
            released.set()
            peer.cancel()
            await asyncio.gather(peer, return_exceptions=True)
            request_id.reset(token)

        self.assertTrue(observations[0][2], "the event loop could not release the handler")
        self.assertNotEqual(observations[0][0], loop_thread)
        self.assertEqual(observations[0][1], "request-42")
        self.assertEqual(result.content, [])
        self.assertEqual(
            result.structured_content,
            {"items": [{"type": "resource", "resourceUri": "file:///result", "title": "Found"}]},
        )

    async def test_async_handlers_run_on_loop(self) -> None:
        loop = asyncio.get_running_loop()
        loop_thread = threading.get_ident()
        observations: list[tuple[asyncio.AbstractEventLoop, int]] = []

        async def search(
            params: OpenAIMentionSearchParams, ctx: Context[Any, Any]
        ) -> OpenAIMentionSearchResult:
            observations.append((asyncio.get_running_loop(), threading.get_ident()))
            await asyncio.sleep(0)
            return OpenAIMentionSearchResult(items=[])

        class AsyncSearch:
            async def __call__(
                self, params: OpenAIMentionSearchParams, ctx: Context[Any, Any]
            ) -> OpenAIMentionSearchResult:
                return await search(params, ctx)

        for handler in (search, AsyncSearch()):
            with self.subTest(handler=type(handler).__name__):
                extensions = OpenAIExtensions()
                extensions.mentions.search(handler)
                server = MCPServer("mentions", extensions=[extensions])
                with patch(
                    "openai_mcp_extensions.mentions.anyio.to_thread.run_sync",
                    side_effect=AssertionError("async handlers must not be offloaded"),
                ):
                    result = await server.call_tool("search_mentions", {"query": ""})
                self.assertEqual(result.structured_content, {"items": []})
        self.assertEqual(observations, [(loop, loop_thread), (loop, loop_thread)])

    async def test_sync_handler_returning_awaitable_is_awaited_on_loop(self) -> None:
        loop = asyncio.get_running_loop()
        loop_thread = threading.get_ident()
        extensions = OpenAIExtensions()
        handler_threads: list[int] = []
        awaited_threads: list[int] = []

        async def finish() -> OpenAIMentionSearchResult:
            self.assertIs(asyncio.get_running_loop(), loop)
            awaited_threads.append(threading.get_ident())
            return OpenAIMentionSearchResult(items=[])

        @extensions.mentions.search
        def search(
            params: OpenAIMentionSearchParams, ctx: Context[Any, Any]
        ) -> Awaitable[OpenAIMentionSearchResult]:
            handler_threads.append(threading.get_ident())
            return finish()

        server = MCPServer("mentions", extensions=[extensions])
        result = await server.call_tool("search_mentions", {"query": ""})
        self.assertEqual(len(handler_threads), 1)
        self.assertNotEqual(handler_threads[0], loop_thread)
        self.assertEqual(awaited_threads, [loop_thread])
        self.assertEqual(result.structured_content, {"items": []})

    async def test_sync_exception_keeps_sdk_error_cause(self) -> None:
        extensions = OpenAIExtensions()
        error = ValueError("search failed")

        @extensions.mentions.search
        def search(
            params: OpenAIMentionSearchParams, ctx: Context[Any, Any]
        ) -> OpenAIMentionSearchResult:
            raise error

        server = MCPServer("mentions", extensions=[extensions])
        with self.assertRaises(UnexpectedToolError) as raised:
            await server.call_tool("search_mentions", {"query": ""})
        self.assertIs(raised.exception.__cause__, error)


if __name__ == "__main__":
    unittest.main()
