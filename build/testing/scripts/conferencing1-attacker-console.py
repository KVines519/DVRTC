#!/usr/bin/env python3
"""Serve the conferencing1 attacker console over TLS."""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import shutil
import ssl
import subprocess
import sys
import tempfile
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DEFAULT_DIRECTORY = Path("/opt/testing/web/conferencing1-attacker")
DEFAULT_CERT = Path("/etc/certstore/fullchain.pem")
DEFAULT_KEY = Path("/etc/certstore/privkey.pem")
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8443


class AttackerConsoleHandler(SimpleHTTPRequestHandler):
    server_version = "DVRTCConferencing1AttackerConsole/1.0"

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] == "/__attacker-config.json":
            public_ipv4 = os.environ.get("PUBLIC_IPV4", "")
            frontend_url = f"https://{public_ipv4}" if valid_ip(public_ipv4) else ""
            client_ip = usable_client_ip(self.client_address[0] if self.client_address else "")
            body = json.dumps({"frontendUrl": frontend_url, "clientIp": client_ip}).encode("utf-8")
            self.send_response(200)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def end_headers(self) -> None:
        self.send_header("cache-control", "no-store")
        self.send_header("x-content-type-options", "nosniff")
        super().end_headers()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Serve the DVRTC conferencing1 attacker console over HTTPS."
    )
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"bind address, default {DEFAULT_HOST}")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"TLS port, default {DEFAULT_PORT}")
    parser.add_argument(
        "--directory",
        type=Path,
        default=DEFAULT_DIRECTORY,
        help=f"console directory, default {DEFAULT_DIRECTORY}",
    )
    parser.add_argument(
        "--cert",
        type=Path,
        default=DEFAULT_CERT,
        help=f"TLS certificate, default {DEFAULT_CERT}",
    )
    parser.add_argument(
        "--key",
        type=Path,
        default=DEFAULT_KEY,
        help=f"TLS private key, default {DEFAULT_KEY}",
    )
    return parser.parse_args()


def valid_ip(value: str | None) -> bool:
    if not value:
        return False
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False


def usable_client_ip(value: str | None) -> str:
    if not value:
        return ""
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        return ""
    if ip.is_loopback or ip.is_unspecified or ip.is_multicast or ip.is_link_local:
        return ""
    if ip.version == 4:
        octets = value.split(".")
        # Docker port publishing commonly makes browser connections appear from
        # the bridge gateway (for example 172.23.0.1), which is not a useful RTP
        # listener address for the browser operator.
        if ip.is_private and len(octets) == 4 and octets[-1] == "1":
            return ""
    return value


def generate_self_signed_cert(tmpdir: Path) -> tuple[Path, Path]:
    openssl = shutil.which("openssl")
    if not openssl:
        raise RuntimeError("openssl is required to generate a fallback self-signed certificate")

    cert = tmpdir / "fullchain.pem"
    key = tmpdir / "privkey.pem"
    san_parts = ["DNS:localhost", "IP:127.0.0.1"]
    public_ipv4 = os.environ.get("PUBLIC_IPV4")
    public_ipv6 = os.environ.get("PUBLIC_IPV6")
    if valid_ip(public_ipv4):
        san_parts.append(f"IP:{public_ipv4}")
    if valid_ip(public_ipv6):
        san_parts.append(f"IP:{public_ipv6}")

    command = [
        openssl,
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "2",
        "-keyout",
        str(key),
        "-out",
        str(cert),
        "-subj",
        "/CN=DVRTC conferencing1 attacker console",
        "-addext",
        f"subjectAltName={','.join(san_parts)}",
    ]
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    key.chmod(0o600)
    return cert, key


def certificate_paths(args: argparse.Namespace, tmpdir: Path) -> tuple[Path, Path, bool]:
    if args.cert.is_file() and args.key.is_file():
        return args.cert, args.key, False

    cert, key = generate_self_signed_cert(tmpdir)
    return cert, key, True


def advertised_urls(host: str, port: int) -> list[str]:
    urls: list[str] = []
    public_ipv4 = os.environ.get("PUBLIC_IPV4")
    public_ipv6 = os.environ.get("PUBLIC_IPV6")

    if host in ("0.0.0.0", "::"):
        if valid_ip(public_ipv4):
            urls.append(f"https://{public_ipv4}:{port}/")
        if valid_ip(public_ipv6):
            urls.append(f"https://[{public_ipv6}]:{port}/")
    else:
        try:
            ip = ipaddress.ip_address(host)
            if ip.version == 6:
                urls.append(f"https://[{host}]:{port}/")
            else:
                urls.append(f"https://{host}:{port}/")
        except ValueError:
            urls.append(f"https://{host}:{port}/")

    urls.append(f"https://127.0.0.1:{port}/")
    return list(dict.fromkeys(urls))


def main() -> int:
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except AttributeError:
        pass

    args = parse_args()
    directory = args.directory.resolve()
    index = directory / "index.html"
    if not index.is_file():
        print(f"ERROR: attacker console not found: {index}", file=sys.stderr)
        return 1

    with tempfile.TemporaryDirectory(prefix="dvrtc-attacker-console-") as tmp:
        tmpdir = Path(tmp)
        cert, key, generated = certificate_paths(args, tmpdir)

        handler = partial(AttackerConsoleHandler, directory=str(directory))
        server = ThreadingHTTPServer((args.host, args.port), handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile=str(cert), keyfile=str(key))
        server.socket = context.wrap_socket(server.socket, server_side=True)

        print("DVRTC conferencing1 attacker console")
        print(f"Serving {directory}")
        print(f"TLS certificate: {cert}")
        if generated:
            print("WARNING: using an ephemeral self-signed certificate; the browser will show a certificate warning.")
            print("Mount data/certs at /etc/certstore to use the DVRTC scenario certificate.")
        print("Open from the user's computer:")
        for url in advertised_urls(args.host, args.port):
            print(f"  {url}")
        print("Press Ctrl-C to stop.")

        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("Stopping attacker console.")
        finally:
            server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
