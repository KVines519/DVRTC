# conferencing1 Scenario Overview

`conferencing1` is the WebRTC Conferencing Platform 1 scenario in DVRTC. It models a browser-based conferencing application backed by a conferencing frontend/API and Janus WebRTC Server.

## Start

```bash
./scripts/compose.sh --scenario conferencing1 up -d
```

## Components

- **conferencing-frontend**: serves the meeting UI, conferencing API, and Janus WebSocket proxy.
- **Janus**: provides the WebRTC VideoRoom backend.
- **bluepill-bots**: aiortc bot pair that creates a fresh BluePill Meeting on startup and joins it as "Neo" and "Morpheus" with looping Matrix-themed audio/video, so the scenario always has a live two-participant call to study. See [bluepill-bots.md](bluepill-bots.md).

## Vulnerable behaviors

- Participant display names are rendered as HTML in the meeting UI, allowing display-name XSS when another participant joins with an HTML payload as their name.
- Meeting links can include `?janus=<websocket-url>`, causing the meeting page to use the supplied Janus WebSocket endpoint instead of the endpoint returned by the frontend API. A crafted link can therefore redirect a participant's signaling path to attacker-controlled or unintended Janus signaling infrastructure.
- A valid meeting WebSocket secret gives broad Janus VideoRoom control through the frontend proxy.

## Default ports

- Conferencing frontend HTTP: `80`
- Conferencing frontend HTTPS: `443`
- Janus HTTP API: `8088` bound to localhost on the DVRTC host
- Janus WebSocket API: `8188` bound to localhost on the DVRTC host
- Janus RTP range: `40001-45000`
- Manual attacker console HTTPS: `8443` when launched with `conferencing1-attacker-console`

## Browser signaling path

Browsers use the conferencing frontend for signaling. The meeting UI and attacker console should connect to `wss://<dvrtc-host>/janus/<secret>`, which is the frontend proxy. Janus HTTP and WebSocket listeners stay local to the DVRTC host.

## URL helpers

- Meeting pages use `/meet/<meeting-code>` as the join URL.
- The main meeting page accepts a hidden `?janus=<websocket-url>` query parameter. When present, the page still uses the meeting code for room metadata, but it connects to the supplied Janus WebSocket URL instead of the URL returned by the frontend API.
- The home page carries `?janus=<websocket-url>` into created and manually joined meeting URLs. Meeting pages also preserve it in copied meeting links.
- The attacker console accepts `?janus=<websocket-url>`, `?frontend=<frontend-url>`, and `?name=<display-name>` for pre-filling the operator console. `?janus` uses the supplied WebSocket URL, typically a frontend `/janus/<secret>` URL. `?frontend` creates a disposable meeting through the frontend API when no Janus URL is supplied.

## Attacker console

Start the attacker console as a one-off HTTPS server from the attacker container after the `conferencing1` stack is running:

```bash
./scripts/compose.sh --scenario conferencing1 run --rm \
  -p 8443:8443 \
  attacker conferencing1-attacker-console
```

Open it from the user's computer:

```text
https://<dvrtc-host-or-public-ip>:8443/
```

Keep the command running while using the console. Stop it with `Ctrl-C` when finished. The host firewall or cloud security group must allow inbound TCP `8443` from the user's computer.

The command uses the DVRTC certificates mounted from `data/certs` when available. If they are not available, it generates an ephemeral self-signed certificate and prints a warning.

By default, the console uses the attacker's `PUBLIC_IPV4` environment variable for the frontend URL, producing `https://<PUBLIC_IPV4>`. Use `?frontend=<frontend-url>` if the conferencing frontend is on a different host or port.

## Notes

- Only one DVRTC scenario runs at a time.
- `conferencing1` is selected explicitly with `./scripts/compose.sh --scenario conferencing1 up -d`.
- The browser-facing app is available over HTTPS on the configured host when certificates exist under `data/certs`.
- HTTP remains available on port `80` for health checks and simple reachability tests.
