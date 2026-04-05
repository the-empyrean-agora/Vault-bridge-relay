"""WebSocket client — connects to the relay and dispatches tool calls to vault_ops."""

from __future__ import annotations

import asyncio
import json
import logging
import platform
import sys
from pathlib import Path

import websockets
from websockets.asyncio.client import connect

from . import __version__
from .vault_ops import list_directory, read_file, write_file, search_files

log = logging.getLogger("vault-bridge-client")

# Exponential backoff: 2 → 4 → 8 → 16 → 30 → 60 (cap)
BACKOFF_BASE = 2
BACKOFF_CAP = 60

# Tool name → handler function
TOOLS = {
    "list_directory": list_directory,
    "read_file": read_file,
    "write_file": write_file,
    "search_files": search_files,
}


async def run(relay_url: str, token: str, vault_path: Path) -> None:
    """Main loop — connect to relay, handle tool calls, reconnect on failure."""
    ws_url = f"{relay_url}?token={token}"
    attempt = 0

    while True:
        try:
            log.info("Connecting to relay...")
            async with connect(ws_url) as ws:
                log.info("Connected. Sending handshake...")
                await _send_connect(ws, token, vault_path)
                # Wait for connected ack
                ack = json.loads(await ws.recv())
                if ack.get("type") == "connected":
                    log.info("Handshake accepted. Listening for tool calls.")
                else:
                    log.warning("Unexpected handshake response: %s", ack)

                attempt = 0  # reset backoff on successful connection
                await _message_loop(ws, vault_path)

        except (
            websockets.ConnectionClosed,
            websockets.InvalidStatus,
            OSError,
        ) as exc:
            log.warning("Disconnected: %s", exc)
        except asyncio.CancelledError:
            log.info("Shutting down.")
            return
        except Exception:
            log.exception("Unexpected error")

        # Exponential backoff
        delay = min(BACKOFF_BASE * (2 ** attempt), BACKOFF_CAP)
        attempt += 1
        log.info("Reconnecting in %ds (attempt %d)...", delay, attempt)
        await asyncio.sleep(delay)


async def _send_connect(ws: websockets.ClientConnection, token: str, vault_path: Path) -> None:
    """Send the connect handshake message."""
    msg = {
        "type": "connect",
        "token": token,
        "vault_path_hint": str(vault_path),
        "client_version": __version__,
        "platform": platform.system().lower(),
    }
    await ws.send(json.dumps(msg))


async def _message_loop(ws: websockets.ClientConnection, vault_path: Path) -> None:
    """Receive and dispatch tool calls until the connection drops."""
    async for raw in ws:
        if isinstance(raw, bytes):
            raw = raw.decode()

        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            log.warning("Received invalid JSON, ignoring")
            continue

        if msg.get("type") != "tool_call":
            log.debug("Ignoring message type: %s", msg.get("type"))
            continue

        request_id = msg.get("request_id", "")
        tool = msg.get("tool", "")
        params = msg.get("params", {})

        log.info("Tool call: %s (id=%s)", tool, request_id[:8])
        result = await _handle_tool(vault_path, tool, params)
        result["request_id"] = request_id
        await ws.send(json.dumps(result))


async def _handle_tool(
    vault_path: Path, tool: str, params: dict
) -> dict:
    """Execute a tool call and return the result message."""
    handler = TOOLS.get(tool)
    if not handler:
        return {"type": "tool_result", "result": None, "error": f"Unknown tool: {tool}"}

    try:
        # Run sync vault_ops in a thread to avoid blocking the event loop
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, lambda: handler(vault_path, **params))

        # Normalise to string
        if isinstance(result, list):
            result = "\n".join(result) if result else "(empty)"

        return {"type": "tool_result", "result": result, "error": None}

    except Exception as exc:
        log.error("Tool %s failed: %s", tool, exc)
        return {"type": "tool_result", "result": None, "error": str(exc)}
