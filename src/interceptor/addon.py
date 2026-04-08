# mitmproxy addon — redirects api.anthropic.com traffic to CC-Router.
#
# Installed and launched by `cc-router client start-desktop`.
# Target URL comes from the CC_ROUTER_TARGET env var (set by the launcher).
#
# Why not set the target as a script argument: mitmproxy's addon loader
# does not pass argv through reliably, and env vars give us a single
# unambiguous channel that survives the spawn boundary.

import os
from urllib.parse import urlparse

from mitmproxy import http

_target_raw = os.environ.get("CC_ROUTER_TARGET", "http://localhost:3456")
_target = _target_raw.rstrip("/")
_target_parsed = urlparse(_target)

# Fail closed on boot if the target is unusable — better than silently
# forwarding to a broken URL and seeing Claude Desktop timeout.
if not _target_parsed.scheme or not _target_parsed.netloc:
    raise RuntimeError(f"CC_ROUTER_TARGET is not a valid URL: {_target_raw!r}")


def request(flow: http.HTTPFlow) -> None:
    if flow.request.pretty_host != "api.anthropic.com":
        return

    # Preserve path + query (e.g. /v1/messages?beta=oauth-2025-04-20)
    # and swap only the scheme + host.
    flow.request.scheme = _target_parsed.scheme
    flow.request.host = _target_parsed.hostname or "localhost"
    flow.request.port = _target_parsed.port or (443 if _target_parsed.scheme == "https" else 80)
    # Rewrite the Host header so CC-Router sees itself, not api.anthropic.com.
    flow.request.headers["host"] = flow.request.host + (
        f":{flow.request.port}"
        if flow.request.port not in (80, 443)
        else ""
    )
