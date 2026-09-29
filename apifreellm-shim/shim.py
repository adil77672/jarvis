#!/usr/bin/env python3
"""OpenAI-compatible shim for apifreellm.com.

apifreellm's free API takes a single ``{"message": "..."}`` and returns
``{"response": "..."}``. This shim exposes ``/v1/models`` and
``/v1/chat/completions`` (streaming and non-streaming) on localhost so any
OpenAI-compatible client — OpenJarvis, Continue, Cline, a VS Code extension —
can use it. Chat history is flattened into one prompt per request.

Usage:
    APIFREELLM_API_KEY=... python3 shim.py [--port 1234]

Standard library only; no dependencies.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = "https://apifreellm.com/api/v1/chat"
MODEL_ID = "apifreellm"


def flatten_messages(messages: list[dict]) -> str:
    """Turn an OpenAI message list into a single prompt string."""

    def text_of(content) -> str:
        if isinstance(content, str):
            return content
        if isinstance(content, list):  # [{"type": "text", "text": ...}, ...]
            return "\n".join(p.get("text", "") for p in content if isinstance(p, dict))
        return ""

    msgs = [m for m in messages if text_of(m.get("content"))]
    if len(msgs) == 1 and msgs[0].get("role") == "user":
        return text_of(msgs[0]["content"])

    parts = []
    for m in msgs:
        role = m.get("role", "user")
        label = {"system": "System", "assistant": "Assistant", "tool": "Tool"}.get(role, "User")
        parts.append(f"{label}: {text_of(m['content'])}")
    parts.append("Assistant:")
    return "\n\n".join(parts)


def call_upstream(api_key: str, prompt: str) -> str:
    body = json.dumps({"message": prompt}).encode()
    req = urllib.request.Request(
        UPSTREAM,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "User-Agent": "apifreellm-shim/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:500]
        raise UpstreamError(e.code, detail) from e
    if not data.get("success", True):
        raise UpstreamError(502, json.dumps(data)[:500])
    return data.get("response", "")


class UpstreamError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


class Handler(BaseHTTPRequestHandler):
    api_key = ""

    def log_message(self, fmt, *args):
        sys.stderr.write("[shim] " + fmt % args + "\n")

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self):
        if self.path.rstrip("/") in ("/v1/models", "/models"):
            self._json(200, {
                "object": "list",
                "data": [{"id": MODEL_ID, "object": "model", "owned_by": "apifreellm"}],
            })
        elif self.path in ("/", "/health"):
            self._json(200, {"status": "ok"})
        else:
            self._json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        if self.path.rstrip("/") not in ("/v1/chat/completions", "/chat/completions"):
            self._json(404, {"error": {"message": "not found"}})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._json(400, {"error": {"message": "invalid JSON"}})
            return

        # A key sent by the client (Authorization: Bearer ...) overrides the env key.
        auth = self.headers.get("Authorization", "")
        client_key = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        api_key = client_key if client_key and client_key not in ("none", "lm-studio") else self.api_key
        if not api_key:
            self._json(401, {"error": {"message": "No apifreellm API key. Set APIFREELLM_API_KEY."}})
            return

        prompt = flatten_messages(req.get("messages", []))
        try:
            text = call_upstream(api_key, prompt)
        except UpstreamError as e:
            self._json(e.status, {"error": {"message": f"apifreellm error {e.status}: {e.detail}"}})
            return
        except Exception as e:  # network errors, timeouts
            self._json(502, {"error": {"message": f"apifreellm unreachable: {e}"}})
            return

        cid = f"chatcmpl-{uuid.uuid4().hex[:24]}"
        created = int(time.time())
        model = req.get("model") or MODEL_ID
        usage = {
            "prompt_tokens": len(prompt) // 4,
            "completion_tokens": len(text) // 4,
            "total_tokens": (len(prompt) + len(text)) // 4,
        }

        if not req.get("stream"):
            self._json(200, {
                "id": cid, "object": "chat.completion", "created": created, "model": model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                             "finish_reason": "stop"}],
                "usage": usage,
            })
            return

        # Upstream doesn't stream; send the whole reply as one SSE chunk.
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        def chunk(delta: dict, finish=None, extra=None) -> None:
            payload = {"id": cid, "object": "chat.completion.chunk", "created": created,
                       "model": model,
                       "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            if extra:
                payload.update(extra)
            self.wfile.write(f"data: {json.dumps(payload)}\n\n".encode())

        chunk({"role": "assistant", "content": text})
        chunk({}, finish="stop", extra={"usage": usage})
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=1234)
    args = parser.parse_args()

    Handler.api_key = os.environ.get("APIFREELLM_API_KEY", "")
    if not Handler.api_key:
        print("warning: APIFREELLM_API_KEY not set; clients must send their own key",
              file=sys.stderr)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"apifreellm shim on http://{args.host}:{args.port}/v1", file=sys.stderr)
    server.serve_forever()


if __name__ == "__main__":
    main()
