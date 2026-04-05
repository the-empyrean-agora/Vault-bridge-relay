"""Integration test — mock relay server ↔ client WebSocket loop."""

import asyncio
import json
import pytest
from pathlib import Path

import websockets
from websockets.asyncio.server import serve

from vault_bridge_client.client import run


@pytest.fixture
def vault(tmp_path):
    """Minimal vault for tool call testing."""
    (tmp_path / "notes").mkdir()
    (tmp_path / "notes" / "hello.md").write_text("Hello from vault")
    (tmp_path / "readme.md").write_text("Top-level readme")
    return tmp_path


class MockRelay:
    """A mock WebSocket relay that sends tool calls and collects results."""

    def __init__(self):
        self.results: list[dict] = []
        self.tool_calls: list[dict] = []
        self._client_connected = asyncio.Event()
        self._all_done = asyncio.Event()

    def queue_tool_call(self, tool: str, params: dict):
        self.tool_calls.append({"tool": tool, "params": params})

    async def handler(self, ws):
        # Wait for connect handshake
        raw = await ws.recv()
        msg = json.loads(raw)
        assert msg["type"] == "connect"

        # Send connected ack
        await ws.send(json.dumps({"type": "connected"}))
        self._client_connected.set()

        # Send queued tool calls
        for i, call in enumerate(self.tool_calls):
            request_id = f"req-{i}"
            await ws.send(json.dumps({
                "type": "tool_call",
                "request_id": request_id,
                "tool": call["tool"],
                "params": call["params"],
            }))

            # Wait for result
            raw = await ws.recv()
            result = json.loads(raw)
            assert result["request_id"] == request_id
            self.results.append(result)

        self._all_done.set()
        await ws.close()


@pytest.mark.asyncio
async def test_client_handles_read_file(vault):
    relay = MockRelay()
    relay.queue_tool_call("read_file", {"path": "notes/hello.md"})

    async with serve(relay.handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        url = f"ws://127.0.0.1:{port}"

        # Run client in background — it will reconnect forever, so we cancel after test
        client_task = asyncio.create_task(run(url, "test-token", vault))

        await asyncio.wait_for(relay._all_done.wait(), timeout=5)
        client_task.cancel()
        await client_task  # run() catches CancelledError and returns cleanly

    assert len(relay.results) == 1
    assert relay.results[0]["error"] is None
    assert "Hello from vault" in relay.results[0]["result"]


@pytest.mark.asyncio
async def test_client_handles_list_directory(vault):
    relay = MockRelay()
    relay.queue_tool_call("list_directory", {"path": ""})

    async with serve(relay.handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        url = f"ws://127.0.0.1:{port}"

        client_task = asyncio.create_task(run(url, "test-token", vault))
        await asyncio.wait_for(relay._all_done.wait(), timeout=5)
        client_task.cancel()
        await client_task

    assert len(relay.results) == 1
    assert relay.results[0]["error"] is None
    assert "notes/" in relay.results[0]["result"]
    assert "readme.md" in relay.results[0]["result"]


@pytest.mark.asyncio
async def test_client_handles_write_file(vault):
    relay = MockRelay()
    relay.queue_tool_call("write_file", {"path": "new-note.md", "content": "Created by test"})

    async with serve(relay.handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        url = f"ws://127.0.0.1:{port}"

        client_task = asyncio.create_task(run(url, "test-token", vault))
        await asyncio.wait_for(relay._all_done.wait(), timeout=5)
        client_task.cancel()
        await client_task

    assert relay.results[0]["error"] is None
    assert (vault / "new-note.md").read_text() == "Created by test"


@pytest.mark.asyncio
async def test_client_handles_unknown_tool(vault):
    relay = MockRelay()
    relay.queue_tool_call("delete_everything", {})

    async with serve(relay.handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        url = f"ws://127.0.0.1:{port}"

        client_task = asyncio.create_task(run(url, "test-token", vault))
        await asyncio.wait_for(relay._all_done.wait(), timeout=5)
        client_task.cancel()
        await client_task

    assert relay.results[0]["result"] is None
    assert "Unknown tool" in relay.results[0]["error"]


@pytest.mark.asyncio
async def test_client_handles_multiple_calls(vault):
    relay = MockRelay()
    relay.queue_tool_call("read_file", {"path": "readme.md"})
    relay.queue_tool_call("search_files", {"query": "hello"})
    relay.queue_tool_call("list_directory", {"path": "notes"})

    async with serve(relay.handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        url = f"ws://127.0.0.1:{port}"

        client_task = asyncio.create_task(run(url, "test-token", vault))
        await asyncio.wait_for(relay._all_done.wait(), timeout=5)
        client_task.cancel()
        await client_task

    assert len(relay.results) == 3
    assert "Top-level readme" in relay.results[0]["result"]
    assert "hello.md" in relay.results[1]["result"]
    assert "hello.md" in relay.results[2]["result"]
