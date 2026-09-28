"""
NetTwin Core — SSH collector sidecar (read-only).

This is the ONLY component that touches real devices. It is deliberately tiny
and read-only: it connects over SSH via Netmiko, runs a fixed set of whitelisted
`show`/`get` commands, and returns their raw output. There is no config-mode
path and no free-form command execution.

Host-key verification (TOFU): on first connect the presented host key is
captured and returned; on later connects the caller pins the expected key and a
mismatch is rejected BEFORE credentials are used (paramiko checks the host key
during the handshake, before authentication).

Runs on the internal Docker network only; the Node app authenticates with
COLLECTOR_TOKEN. Never expose this service publicly.
"""
import os
import base64
import hashlib
import hmac
import tempfile
from typing import List, Dict, Optional

from fastapi import FastAPI, HTTPException, Header
from pydantic import BaseModel, Field
from netmiko import ConnectHandler

# Without a token the sidecar refuses every request (fail closed): anything on
# the network could otherwise make it log in to devices.
TOKEN = os.environ.get("COLLECTOR_TOKEN", "")
if not TOKEN:
    print("WARNING: COLLECTOR_TOKEN is not set; all /collect requests will be rejected.", flush=True)

# Read-only whitelist, mirrored from the Node side as defense-in-depth. The
# sidecar refuses any command not listed here, regardless of what it is sent.
ALLOWED: Dict[str, set] = {
    "cisco_ios": {
        "show running-config", "show ip route", "show ip route vrf *", "show ip arp",
        "show cdp neighbors detail",
    },
    "juniper_junos": {
        "show configuration | display set", "show route", "show arp", "show lldp neighbors",
    },
    "juniper_screenos": {
        "get config", "get route", "get arp",
    },
    "fortinet": {
        "show full-configuration", "get router info routing-table all", "get system arp",
    },
    "paloalto_panos": {
        "show config running", "show routing route", "show arp all",
    },
}

app = FastAPI(title="NetTwin Collector", docs_url=None, redoc_url=None)


class Cmd(BaseModel):
    intent: str
    command: str


class CollectReq(BaseModel):
    host: str = Field(min_length=1, max_length=255, pattern=r"^[A-Za-z0-9.:_\-\[\]]+$")
    port: int = Field(default=22, ge=1, le=65535)
    device_type: str
    username: str
    password: str
    commands: List[Cmd] = Field(max_length=10)
    expected_host_key: Optional[str] = None  # "keytype base64" when pinned


def _fingerprint(key) -> str:
    digest = hashlib.sha256(key.asbytes()).digest()
    return "SHA256:" + base64.b64encode(digest).decode().rstrip("=")


def _known_hosts_name(host: str, port: int) -> str:
    return host if port == 22 else f"[{host}]:{port}"


@app.get("/health")
def health():
    return {"ok": True, "vendors": list(ALLOWED.keys())}


@app.post("/collect")
def collect(req: CollectReq, authorization: str = Header(default="")):
    if not TOKEN or not hmac.compare_digest(authorization.encode(), f"Bearer {TOKEN}".encode()):
        raise HTTPException(status_code=401, detail="unauthorized")

    allowed = ALLOWED.get(req.device_type)
    if allowed is None:
        raise HTTPException(status_code=400, detail=f"unsupported device_type: {req.device_type}")

    # Hard read-only guarantee: reject anything outside the whitelist.
    for c in req.commands:
        if c.command not in allowed:
            raise HTTPException(status_code=400, detail=f"command not allowed: {c.command}")

    # When a host key is pinned, verify it during the handshake. paramiko checks
    # the known_hosts entry before authentication, so a mismatch means creds are
    # never sent to the impostor.
    extra = {}
    alt_path = None
    if req.expected_host_key:
        f = tempfile.NamedTemporaryFile("w", delete=False, suffix=".known")
        f.write(f"{_known_hosts_name(req.host, req.port)} {req.expected_host_key}\n")
        f.flush()
        f.close()
        alt_path = f.name
        extra = {"ssh_strict": True, "alt_host_keys": True, "alt_key_file": alt_path}

    conn = None
    results: Dict[str, str] = {}
    host_key = None
    fingerprint = None
    try:
        conn = ConnectHandler(
            device_type=req.device_type,
            host=req.host,
            port=req.port,
            username=req.username,
            password=req.password,
            fast_cli=False,
            conn_timeout=20,
            banner_timeout=20,
            auth_timeout=20,
            **extra,
        )
        # Capture the presented host key for TOFU pinning / display.
        try:
            k = conn.remote_conn_pre.get_transport().get_remote_server_key()
            host_key = f"{k.get_name()} {k.get_base64()}"
            fingerprint = _fingerprint(k)
        except Exception:
            pass

        for c in req.commands:
            results[c.intent] = conn.send_command(c.command, read_timeout=60)
    except Exception as e:
        msg = str(e)
        if "host key" in msg.lower() or "BadHostKey" in msg or "not found in" in msg.lower():
            raise HTTPException(status_code=409, detail=f"HOST_KEY_MISMATCH: {msg}")
        raise HTTPException(status_code=502, detail=msg)
    finally:
        if conn is not None:
            try:
                conn.disconnect()
            except Exception:
                pass
        if alt_path:
            try:
                os.unlink(alt_path)
            except Exception:
                pass

    return {"results": results, "host_key": host_key, "fingerprint": fingerprint}
