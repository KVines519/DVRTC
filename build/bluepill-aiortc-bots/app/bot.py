#!/usr/bin/env python3
"""Lightweight BluePill Meeting bots using aiortc and the frontend API flow."""

import asyncio
import json
import os
import random
import secrets
import signal
import string
import time
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any, Callable

import aiohttp
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCRtpSender, VideoStreamTrack
from aiortc.contrib.media import MediaPlayer
from av import VideoFrame
from PIL import Image, ImageDraw, ImageFont

FRONTEND_URL = os.environ.get("BOT_FRONTEND_URL", "http://127.0.0.1:80").rstrip("/")
PUBLIC_URL = os.environ.get("BOT_PUBLIC_URL", FRONTEND_URL).rstrip("/")
MEDIA_DIR = Path(os.environ.get("BOT_MEDIA_DIR", "/opt/dvrtc-bluepill-aiortc-bots/media"))
JOIN_TIMEOUT_MS = int(os.environ.get("BOT_JOIN_TIMEOUT_MS", "30000"))
HEALTH_INTERVAL_MS = int(os.environ.get("BOT_HEALTH_INTERVAL_MS", "15000"))
RESTART_BACKOFF_MS = int(os.environ.get("BOT_RESTART_BACKOFF_MS", "10000"))
CLEANUP_RETRIES = int(os.environ.get("BOT_CLEANUP_RETRIES", "5"))
CLEANUP_RETRY_DELAY_MS = int(os.environ.get("BOT_CLEANUP_RETRY_DELAY_MS", "1000"))
CALL_TAIL_MS = int(os.environ.get("BOT_CALL_TAIL_MS", "1000"))
VIDEO_WIDTH = int(os.environ.get("BOT_AIORTC_VIDEO_WIDTH", "160"))
VIDEO_HEIGHT = int(os.environ.get("BOT_AIORTC_VIDEO_HEIGHT", "120"))
VIDEO_FPS = max(1, int(os.environ.get("BOT_AIORTC_VIDEO_FPS", "30")))
HEARTBEAT_PATH = Path(os.environ.get("BOT_HEARTBEAT_PATH", "/tmp/bluepill-aiortc-bots.heartbeat"))

PARTICIPANTS = [
    {"name": "Neo", "audio": MEDIA_DIR / "neo.wav", "video": MEDIA_DIR / "neo.ts", "tint": "#001a08"},
    {"name": "Morpheus", "audio": MEDIA_DIR / "morpheus.wav", "video": MEDIA_DIR / "morpheus.ts", "tint": "#041a00"},
]


def load_dialogue_manifest() -> dict[str, Any]:
    try:
        parsed = json.loads((MEDIA_DIR / "dialogue.json").read_text())
        if isinstance(parsed.get("durationMs"), (int, float)) and parsed["durationMs"] > 0:
            return parsed
    except Exception:
        pass
    return {"durationMs": 180000}


CALL_DURATION_MS = int(load_dialogue_manifest()["durationMs"]) + CALL_TAIL_MS


def log(message: str, extra: Any | None = None) -> None:
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + f".{int(time.time() * 1000) % 1000:03d}Z"
    if extra is None:
        print(f"[{stamp}] {message}", flush=True)
    else:
        print(f"[{stamp}] {message} {extra}", flush=True)


async def sleep_ms(ms: int) -> None:
    await asyncio.sleep(ms / 1000)


async def wait_for_frontend(http: aiohttp.ClientSession) -> None:
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        try:
            async with http.get(f"{FRONTEND_URL}/healthz") as response:
                if response.status == 200:
                    return
        except Exception:
            pass
        await asyncio.sleep(2)
    raise RuntimeError(f"Frontend at {FRONTEND_URL} did not become healthy in time")


async def create_meeting(http: aiohttp.ClientSession) -> str:
    async with http.post(f"{FRONTEND_URL}/api/meetings", json={}) as response:
        body = await response.json()
        if response.status != 201:
            raise RuntimeError(f"Meeting creation failed: HTTP {response.status}: {body}")
    code = body.get("meeting", {}).get("code")
    if not code:
        raise RuntimeError(f"Meeting creation returned unexpected payload: {body}")
    return code


async def join_meeting(http: aiohttp.ClientSession, code: str, display_name: str) -> dict[str, Any]:
    url = f"{FRONTEND_URL}/api/meetings/{code}/join"
    async with http.post(url, json={"displayName": display_name}) as response:
        body = await response.json()
        if response.status != 200:
            raise RuntimeError(f"Join failed for {display_name}: HTTP {response.status}: {body}")
    return body


async def cleanup_meeting(http: aiohttp.ClientSession, code: str) -> None:
    attempts = CLEANUP_RETRIES if CLEANUP_RETRIES > 0 else 1
    for attempt in range(1, attempts + 1):
        try:
            async with http.post(f"{FRONTEND_URL}/api/meetings/{code}/cleanup", json={}) as response:
                if response.status == 404:
                    log(f"Meeting {code} already cleaned up")
                    return
                body = await response.json()
                if response.status >= 400:
                    raise RuntimeError(f"HTTP {response.status}: {body}")
                if body.get("removed"):
                    log(f"Cleaned up BluePill room {code}")
                    return
                log(f"BluePill room {code} still has participants; cleanup retry {attempt}/{attempts}")
        except Exception as error:
            log(f"Cleanup request for room {code} failed on attempt {attempt}/{attempts}: {error}")
        if attempt < attempts:
            await sleep_ms(CLEANUP_RETRY_DELAY_MS)


def transaction_id() -> str:
    return "".join(random.choice(string.ascii_letters) for _ in range(12))


class JanusSocket:
    def __init__(self, url: str, http: aiohttp.ClientSession):
        self.url = url
        self.http = http
        self.ws: aiohttp.ClientWebSocketResponse | None = None
        self.session_id: int | None = None
        self.pending: dict[str, asyncio.Future] = {}
        self.waiters: list[tuple[int, Callable[[dict[str, Any]], bool], asyncio.Future]] = []
        self.reader_task: asyncio.Task | None = None
        self.keepalive_task: asyncio.Task | None = None

    async def connect(self) -> None:
        self.ws = await self.http.ws_connect(self.url, protocols=("janus-protocol",), heartbeat=30)
        self.reader_task = asyncio.create_task(self._reader())
        created = await self.request({"janus": "create"})
        self.session_id = created["data"]["id"]
        self.keepalive_task = asyncio.create_task(self._keepalive())

    async def attach(self, plugin: str = "janus.plugin.videoroom") -> int:
        response = await self.request({"janus": "attach", "plugin": plugin, "session_id": self.session_id})
        return int(response["data"]["id"])

    async def request(self, message: dict[str, Any], timeout: float = 10.0) -> dict[str, Any]:
        if not self.ws:
            raise RuntimeError("Janus WebSocket is not connected")
        transaction = transaction_id()
        payload = {**message, "transaction": transaction}
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self.pending[transaction] = future
        await self.ws.send_json(payload)
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        finally:
            self.pending.pop(transaction, None)

    async def message(self, handle_id: int, body: dict[str, Any], jsep: dict[str, Any] | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "janus": "message",
            "session_id": self.session_id,
            "handle_id": handle_id,
            "body": body,
        }
        if jsep:
            payload["jsep"] = jsep
        return await self.request(payload)

    async def message_and_wait(
        self,
        handle_id: int,
        body: dict[str, Any],
        predicate: Callable[[dict[str, Any]], bool],
        jsep: dict[str, Any] | None = None,
        timeout: float = 15.0,
    ) -> dict[str, Any]:
        waiter = asyncio.create_task(self.wait_for(handle_id, predicate, timeout=timeout))
        await self.message(handle_id, body, jsep=jsep)
        return await waiter

    async def wait_for(
        self,
        handle_id: int,
        predicate: Callable[[dict[str, Any]], bool],
        timeout: float = 15.0,
    ) -> dict[str, Any]:
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        entry = (handle_id, predicate, future)
        self.waiters.append(entry)
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        finally:
            if entry in self.waiters:
                self.waiters.remove(entry)

    async def destroy(self) -> None:
        if self.keepalive_task:
            self.keepalive_task.cancel()
        if self.session_id:
            try:
                await self.request({"janus": "destroy", "session_id": self.session_id}, timeout=3)
            except Exception:
                pass
        if self.ws:
            await self.ws.close()
        if self.reader_task:
            self.reader_task.cancel()

    async def _keepalive(self) -> None:
        while True:
            await asyncio.sleep(25)
            try:
                await self.request({"janus": "keepalive", "session_id": self.session_id}, timeout=3)
            except Exception as error:
                log(f"Janus keepalive failed: {error}")

    async def _reader(self) -> None:
        assert self.ws is not None
        async for message in self.ws:
            if message.type != aiohttp.WSMsgType.TEXT:
                continue
            data = json.loads(message.data)
            transaction = data.get("transaction")
            future = self.pending.get(transaction) if transaction else None
            if future and not future.done():
                if data.get("janus") == "error":
                    future.set_exception(RuntimeError(data.get("error", {}).get("reason", "Janus error")))
                else:
                    future.set_result(data)
                continue

            sender = data.get("sender")
            if not sender:
                continue
            for handle_id, predicate, waiter in list(self.waiters):
                if handle_id == sender and not waiter.done() and predicate(data):
                    waiter.set_result(data)
                    break


class NameVideoTrack(VideoStreamTrack):
    kind = "video"

    def __init__(self, name: str, tint: str, width: int, height: int, fps: int):
        super().__init__()
        self.name = name
        self.width = width
        self.height = height
        self.fps = fps
        self.timestamp = 0
        self.image = self._build_image(name, tint, width, height)

    async def recv(self) -> VideoFrame:
        await asyncio.sleep(1 / self.fps)
        self.timestamp += int(90000 / self.fps)
        frame = VideoFrame.from_image(self.image)
        frame.pts = self.timestamp
        frame.time_base = Fraction(1, 90000)
        return frame

    @staticmethod
    def _build_image(name: str, tint: str, width: int, height: int) -> Image.Image:
        image = Image.new("RGB", (width, height), tint)
        draw = ImageDraw.Draw(image)
        try:
            font = ImageFont.truetype("DejaVuSansMono-Bold.ttf", 28 if len(name) <= 3 else 20)
            small = ImageFont.truetype("DejaVuSansMono.ttf", 8)
        except Exception:
            font = ImageFont.load_default()
            small = ImageFont.load_default()
        label = name.upper()
        binary_groups = [f"{ord(char):08b}" for char in name]
        draw.rectangle((2, 2, width - 3, height - 3), outline="#00ff66", width=2)

        binary_lines: list[str] = []
        current = ""
        for group in binary_groups:
            candidate = group if not current else f"{current} {group}"
            if draw.textlength(candidate, font=small) <= width - 12:
                current = candidate
            else:
                if current:
                    binary_lines.append(current)
                current = group
        if current:
            binary_lines.append(current)
        line_height = max(8, draw.textbbox((0, 0), "01010101", font=small)[3] + 2)
        binary_top = height - 6 - (line_height * len(binary_lines))
        for index, line in enumerate(binary_lines):
            line_width = draw.textlength(line, font=small)
            draw.text(((width - line_width) / 2, binary_top + index * line_height), line, font=small, fill=(0, 255, 102))

        bbox = draw.textbbox((0, 0), label, font=font)
        text_w = bbox[2] - bbox[0]
        text_h = bbox[3] - bbox[1]
        x = max(4, (width - text_w) // 2)
        y = max(4, (binary_top - text_h) // 2 - 1)
        draw.rectangle((x - 6, y - 6, x + text_w + 6, y + text_h + 6), fill="#001100", outline="#00ff66")
        draw.text((x, y), label, font=font, fill="#b8ffd0")
        return image


@dataclass
class BotSession:
    name: str
    janus: JanusSocket
    handle_id: int
    pc: RTCPeerConnection
    players: list[MediaPlayer]

    async def close(self) -> None:
        for transceiver in self.pc.getTransceivers():
            if transceiver.sender and transceiver.sender.track:
                transceiver.sender.track.stop()
        await self.pc.close()
        await self.janus.destroy()


async def publish_bot(http: aiohttp.ClientSession, code: str, participant: dict[str, Any]) -> BotSession:
    name = participant["name"]
    join = await join_meeting(http, code, name)
    room = int(join["meeting"]["room"])
    ws_url = join["janus"]["websocket"]
    janus = JanusSocket(ws_url, http)
    pc: RTCPeerConnection | None = None
    try:
        await janus.connect()
        handle_id = await janus.attach()
        joined = await janus.message_and_wait(
            handle_id,
            {"request": "join", "ptype": "publisher", "room": room, "display": name},
            lambda event: event.get("plugindata", {}).get("data", {}).get("videoroom") == "joined",
        )
        publisher_id = joined.get("plugindata", {}).get("data", {}).get("id")

        pc = RTCPeerConnection()
        players: list[MediaPlayer] = []
        audio_path = Path(participant["audio"])
        has_audio = audio_path.exists()
        if has_audio:
            player = MediaPlayer(str(audio_path), loop=True)
            players.append(player)
            if player.audio:
                pc.addTrack(player.audio)
        else:
            log(f"Audio clip missing for {name}: {audio_path}")

        video_path = Path(participant["video"])
        if video_path.exists():
            # The build pre-renders this as MPEG-TS/H.264. decode=False lets
            # aiortc forward encoded packets instead of rendering frames in
            # Python and re-encoding them for WebRTC.
            video_player = MediaPlayer(str(video_path), loop=True, decode=False)
            players.append(video_player)
            if video_player.video:
                sender = pc.addTrack(video_player.video)
                transceiver = next((item for item in pc.getTransceivers() if item.sender == sender), None)
                h264_codecs = [
                    codec for codec in RTCRtpSender.getCapabilities("video").codecs
                    if codec.mimeType.lower() == "video/h264"
                ]
                if transceiver and h264_codecs:
                    transceiver.setCodecPreferences(h264_codecs)
        else:
            log(f"Video clip missing for {name}: {video_path}; using static fallback")
            pc.addTrack(NameVideoTrack(name, participant["tint"], VIDEO_WIDTH, VIDEO_HEIGHT, VIDEO_FPS))

        offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        jsep = {
            "type": pc.localDescription.type,
            "sdp": pc.localDescription.sdp,
            "trickle": False,
        }
        published = await janus.message_and_wait(
            handle_id,
            {"request": "publish", "audio": has_audio, "video": True, "videocodec": "h264"},
            lambda event: bool(event.get("jsep")),
            jsep=jsep,
            timeout=20,
        )
        await pc.setRemoteDescription(
            RTCSessionDescription(sdp=published["jsep"]["sdp"], type=published["jsep"]["type"])
        )
        log(f"{name} joined room {room} as publisher {publisher_id}")
        return BotSession(name=name, janus=janus, handle_id=handle_id, pc=pc, players=players)
    except Exception:
        if pc:
            await pc.close()
        await janus.destroy()
        raise


async def heartbeat(stop_event: asyncio.Event) -> None:
    while not stop_event.is_set():
        HEARTBEAT_PATH.write_text(str(time.time()))
        await asyncio.sleep(max(5, HEALTH_INTERVAL_MS / 1000))


async def run_session(http: aiohttp.ClientSession, stop_event: asyncio.Event) -> None:
    await wait_for_frontend(http)
    code = await create_meeting(http)
    log(f"BluePill room provisioned: {code}")
    log(f"  join URL: {PUBLIC_URL}/meet/{code}?autojoin")

    sessions: list[BotSession] = []
    heartbeat_task: asyncio.Task | None = None
    try:
        async def launch_participant(index: int, participant: dict[str, Any]) -> BotSession:
            # Start the two publish negotiations almost together. The WAV files
            # contain one coordinated dialogue timeline, so sequential WebRTC
            # setup makes Neo and Morpheus audibly drift by the negotiation gap.
            if index > 0:
                await sleep_ms(150 * index)
            return await publish_bot(http, code, participant)

        sessions = await asyncio.gather(*[
            launch_participant(index, participant)
            for index, participant in enumerate(PARTICIPANTS)
        ])
        heartbeat_task = asyncio.create_task(heartbeat(stop_event))

        deadline = time.monotonic() + (CALL_DURATION_MS / 1000)
        while not stop_event.is_set() and time.monotonic() < deadline:
            for session in sessions:
                if session.pc.connectionState in {"closed", "failed", "disconnected"}:
                    raise RuntimeError(f"{session.name} peer connection {session.pc.connectionState}")
            await sleep_ms(HEALTH_INTERVAL_MS)
        log(f"Session for room {code} ending: call ended ({CALL_DURATION_MS}ms)")
    finally:
        if heartbeat_task:
            heartbeat_task.cancel()
        for session in sessions:
            await session.close()
        await cleanup_meeting(http, code)
        try:
            HEARTBEAT_PATH.unlink()
        except FileNotFoundError:
            pass


async def main() -> None:
    log(f"bluepill-aiortc-bots starting; frontend={FRONTEND_URL}")
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except NotImplementedError:
            pass

    connector = aiohttp.TCPConnector(ssl=False)
    timeout = aiohttp.ClientTimeout(total=None, sock_connect=30, sock_read=None)
    async with aiohttp.ClientSession(connector=connector, timeout=timeout) as http:
        while not stop_event.is_set():
            try:
                await run_session(http, stop_event)
            except Exception as error:
                log(f"Session failed: {error}")
                try:
                    HEARTBEAT_PATH.unlink()
                except FileNotFoundError:
                    pass
            if not stop_event.is_set():
                await sleep_ms(RESTART_BACKOFF_MS)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
