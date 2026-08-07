"""End-to-end test: MCP HTTP → mini relay → WS → real client → vault_ops → response.

Simulates the full data path that Claude.ai uses:
  1. POST JSON-RPC to /mcp (like Claude does)
  2. Relay brokers tool_call over WebSocket to connected client
  3. Client executes vault_ops against a real vault directory
  4. Result flows back: client → WS → relay → HTTP response
"""

import asyncio
import json
import uuid
import pytest
from pathlib import Path

import aiohttp
from aiohttp import web

from vault_bridge_client.client import run as run_client


# ---------------------------------------------------------------------------
# Mini Relay — simulates Worker + Durable Object in a single aiohttp server
# ---------------------------------------------------------------------------


class MiniRelay:
    """Combined HTTP (MCP) + WebSocket server mimicking the real relay."""

    def __init__(self):
        self.client_ws: web.WebSocketResponse | None = None
        self.pending: dict[str, asyncio.Future] = {}
        self._client_connected = asyncio.Event()

    # --- WebSocket handler (client connects here) ---

    async def ws_handler(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse()
        await ws.prepare(request)

        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                data = json.loads(msg.data)
                if data["type"] == "connect":
                    self.client_ws = ws
                    await ws.send_json({"type": "connected"})
                    self._client_connected.set()
                elif data["type"] == "tool_result":
                    req_id = data["request_id"]
                    if req_id in self.pending:
                        self.pending[req_id].set_result(data)

        self.client_ws = None
        self._client_connected.clear()
        return ws

    # --- MCP HTTP handler (Claude sends JSON-RPC here) ---

    async def mcp_handler(self, request: web.Request) -> web.Response:
        body = await request.json()
        method = body.get("method", "")
        msg_id = body.get("id")

        # Notifications (no id) — 202 Accepted
        if msg_id is None:
            return web.Response(status=202)

        if method == "initialize":
            return _jsonrpc_ok(msg_id, {
                "protocolVersion": "2025-03-26",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "Vault Bridge", "version": "0.1.0"},
            })

        if method == "tools/list":
            return _jsonrpc_ok(msg_id, {"tools": [
                {"name": "list_directory", "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}}},
                {"name": "read_file", "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}},
                {"name": "write_file", "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}},
                {"name": "search_files", "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
            ]})

        if method == "tools/call":
            return await self._handle_tool_call(body)

        return _jsonrpc_error(msg_id, -32601, f"Method not found: {method}")

    async def _handle_tool_call(self, body: dict) -> web.Response:
        msg_id = body["id"]
        params = body.get("params", {})
        tool_name = params.get("name", "")
        tool_args = params.get("arguments", {})

        if not self.client_ws:
            return _jsonrpc_ok(msg_id, {
                "content": [{"type": "text", "text": "Client not connected. Ensure Vault Bridge is running on your machine."}],
                "isError": True,
            })

        request_id = str(uuid.uuid4())
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future

        await self.client_ws.send_json({
            "type": "tool_call",
            "request_id": request_id,
            "tool": tool_name,
            "params": tool_args,
        })

        result = await asyncio.wait_for(future, timeout=10)
        del self.pending[request_id]

        if result.get("error"):
            return _jsonrpc_ok(msg_id, {
                "content": [{"type": "text", "text": result["error"]}],
                "isError": True,
            })

        return _jsonrpc_ok(msg_id, {
            "content": [{"type": "text", "text": result["result"]}],
        })

    # --- Health ---

    async def health_handler(self, request: web.Request) -> web.Response:
        return web.Response(text="OK")


def _jsonrpc_ok(msg_id, result):
    return web.json_response({"jsonrpc": "2.0", "id": msg_id, "result": result})


def _jsonrpc_error(msg_id, code, message):
    return web.json_response({"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}})


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def vault(tmp_path):
    """Create a test vault with known contents."""
    (tmp_path / "notes").mkdir()
    (tmp_path / "daily").mkdir()
    (tmp_path / "notes" / "hello.md").write_text("Hello world\nThis is a test note.")
    (tmp_path / "notes" / "project.md").write_text("# Project\nTasks and plans.")
    (tmp_path / "daily" / "2026-04-05.md").write_text("Daily log for today.")
    (tmp_path / "readme.md").write_text("# My Vault\nWelcome to the vault.")
    return tmp_path


# ---------------------------------------------------------------------------
# Helper — run relay + client + MCP requests in one test
# ---------------------------------------------------------------------------


async def _run_e2e(vault: Path, mcp_requests: list[dict]) -> list[dict]:
    """Spin up relay + client, send MCP requests, return responses."""
    relay = MiniRelay()

    app = web.Application()
    app.router.add_get("/ws", relay.ws_handler)
    app.router.add_post("/mcp", relay.mcp_handler)
    app.router.add_get("/health", relay.health_handler)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()

    port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
    base_url = f"http://127.0.0.1:{port}"
    ws_url = f"ws://127.0.0.1:{port}/ws"

    # Start client
    client_task = asyncio.create_task(run_client(ws_url, "test-token", vault))

    # Wait for client to connect
    await asyncio.wait_for(relay._client_connected.wait(), timeout=5)

    # Send MCP requests and collect responses
    responses = []
    async with aiohttp.ClientSession() as session:
        for req in mcp_requests:
            async with session.post(f"{base_url}/mcp", json=req) as resp:
                if resp.status == 202:
                    responses.append({"status": 202})
                else:
                    responses.append(await resp.json())

    # Cleanup
    client_task.cancel()
    await client_task
    await runner.cleanup()

    return responses


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_e2e_initialize(vault):
    """MCP initialize handshake returns server info."""
    responses = await _run_e2e(vault, [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"clientInfo": {"name": "test"}}},
    ])
    result = responses[0]["result"]
    assert result["serverInfo"]["name"] == "Vault Bridge"
    assert result["capabilities"]["tools"] == {}


@pytest.mark.asyncio
async def test_e2e_tools_list(vault):
    """tools/list returns all four tools."""
    responses = await _run_e2e(vault, [
        {"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
    ])
    tools = responses[0]["result"]["tools"]
    names = {t["name"] for t in tools}
    assert names == {"list_directory", "read_file", "write_file", "search_files"}


@pytest.mark.asyncio
async def test_e2e_read_file(vault):
    """Full round-trip: MCP read_file → relay → WS → client → vault → response."""
    responses = await _run_e2e(vault, [
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
            "name": "read_file", "arguments": {"path": "notes/hello.md"},
        }},
    ])
    content = responses[0]["result"]["content"]
    assert len(content) == 1
    assert "Hello world" in content[0]["text"]


@pytest.mark.asyncio
async def test_e2e_list_directory(vault):
    """Full round-trip: list_directory on vault root."""
    responses = await _run_e2e(vault, [
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
            "name": "list_directory", "arguments": {"path": ""},
        }},
    ])
    text = responses[0]["result"]["content"][0]["text"]
    assert "notes/" in text
    assert "daily/" in text
    assert "readme.md" in text


@pytest.mark.asyncio
async def test_e2e_write_file(vault):
    """Full round-trip: write_file creates a new file in the vault."""
    responses = await _run_e2e(vault, [
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
            "name": "write_file", "arguments": {"path": "new-note.md", "content": "Created via MCP e2e"},
        }},
    ])
    text = responses[0]["result"]["content"][0]["text"]
    assert "Written" in text
    assert (vault / "new-note.md").read_text() == "Created via MCP e2e"


@pytest.mark.asyncio
async def test_e2e_search_files(vault):
    """Full round-trip: search_files finds content matches."""
    responses = await _run_e2e(vault, [
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
            "name": "search_files", "arguments": {"query": "Tasks and plans"},
        }},
    ])
    text = responses[0]["result"]["content"][0]["text"]
    assert "project.md" in text


@pytest.mark.asyncio
async def test_e2e_multiple_tools_sequential(vault):
    """Multiple tool calls in sequence within one session."""
    responses = await _run_e2e(vault, [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
            "name": "read_file", "arguments": {"path": "readme.md"},
        }},
        {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {
            "name": "list_directory", "arguments": {"path": "notes"},
        }},
    ])
    # initialize
    assert responses[0]["result"]["serverInfo"]["name"] == "Vault Bridge"
    # notification — 202
    assert responses[1] == {"status": 202}
    # tools/list
    assert len(responses[2]["result"]["tools"]) == 4
    # read_file
    assert "My Vault" in responses[3]["result"]["content"][0]["text"]
    # list_directory
    assert "hello.md" in responses[4]["result"]["content"][0]["text"]


@pytest.mark.asyncio
async def test_e2e_client_offline_error(vault):
    """MCP request when no client is connected returns an error."""
    relay = MiniRelay()

    app = web.Application()
    app.router.add_get("/ws", relay.ws_handler)
    app.router.add_post("/mcp", relay.mcp_handler)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]

    # Send MCP request WITHOUT a connected client
    async with aiohttp.ClientSession() as session:
        async with session.post(f"http://127.0.0.1:{port}/mcp", json={
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "read_file", "arguments": {"path": "readme.md"}},
        }) as resp:
            data = await resp.json()

    await runner.cleanup()

    assert data["result"]["isError"] is True
    assert "Client not connected" in data["result"]["content"][0]["text"]
