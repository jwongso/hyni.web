#!/usr/bin/env python3
"""Minimal stub MCP server for hyni's integration tests.

Implements just enough of the MCP protocol to verify the C++ client:
- initialize (returns protocol version + server info)
- notifications/initialized (no-op)
- tools/list (returns two test tools)
- tools/call (echoes the args back, with a deterministic body)

Wire format: newline-delimited JSON on stdin/stdout.

Why not depend on the real `mcp` Python SDK? So this test can run in any
environment without pulling 100s of MB of transformers / torch.
"""
import json
import sys


TOOLS = [
    {
        "name": "echo",
        "description": "Echoes its `text` argument back, prefixed with [echo].",
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "The text to echo."},
            },
            "required": ["text"],
        },
    },
    {
        "name": "add",
        "description": "Returns the sum of `a` and `b` as text.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "a": {"type": "number"},
                "b": {"type": "number"},
            },
            "required": ["a", "b"],
        },
    },
]


def write(msg: dict) -> None:
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue

        rid = req.get("id")
        method = req.get("method", "")

        # Notifications have no id, no response.
        if rid is None:
            continue

        if method == "initialize":
            write({
                "jsonrpc": "2.0",
                "id": rid,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "serverInfo": {"name": "hyni-stub", "version": "0.1"},
                    "capabilities": {"tools": {}},
                },
            })
            continue

        if method == "tools/list":
            write({"jsonrpc": "2.0", "id": rid, "result": {"tools": TOOLS}})
            continue

        if method == "tools/call":
            params = req.get("params") or {}
            name = params.get("name", "")
            args = params.get("arguments") or {}
            if name == "echo":
                text = str(args.get("text", ""))
                write({
                    "jsonrpc": "2.0", "id": rid,
                    "result": {
                        "content": [{"type": "text", "text": f"[echo] {text}"}],
                        "isError": False,
                    },
                })
            elif name == "add":
                try:
                    s = float(args["a"]) + float(args["b"])
                    write({
                        "jsonrpc": "2.0", "id": rid,
                        "result": {
                            "content": [{"type": "text", "text": f"{s}"}],
                            "isError": False,
                        },
                    })
                except Exception as e:  # noqa: BLE001
                    write({
                        "jsonrpc": "2.0", "id": rid,
                        "result": {
                            "content": [{"type": "text", "text": str(e)}],
                            "isError": True,
                        },
                    })
            else:
                write({
                    "jsonrpc": "2.0", "id": rid,
                    "error": {"code": -32601, "message": f"Unknown tool: {name}"},
                })
            continue

        # Unknown method.
        write({
            "jsonrpc": "2.0", "id": rid,
            "error": {"code": -32601, "message": f"Method not found: {method}"},
        })


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
