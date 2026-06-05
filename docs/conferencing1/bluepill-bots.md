# bluepill-bots

`bluepill-bots` keeps one BluePill Meeting populated with two participants, "Neo" and "Morpheus", so conferencing1 exercises have a live call to observe, capture, or attack without anyone manually opening browser tabs.

## How it works

The bot uses aiortc. On startup the container:

1. Waits for `conferencing-frontend` to report healthy on `BOT_FRONTEND_URL`.
2. Creates a fresh meeting with `POST /api/meetings`.
3. Joins the meeting once per bot with `POST /api/meetings/<code>/join`.
4. Connects to the returned `/janus/<secret>` WebSocket URL.
5. Publishes Neo and Morpheus as Janus VideoRoom publishers.
6. Recreates the meeting after the dialogue duration ends or the bot session fails.

The room code rotates when the container restarts and when the bot session is recreated. Tail the logs to find the current code:

```bash
./scripts/compose.sh --scenario conferencing1 logs -f bluepill-bots
```

When a bot session ends, `bluepill-bots` asks the local `conferencing-frontend` API to remove the meeting if no participants remain. As a fallback, `conferencing-frontend` keeps meeting codes for `FRONTEND_MEETING_TTL_MS` and prunes empty Janus rooms after `FRONTEND_EMPTY_ROOM_TTL_MS`.

## Development build

```bash
./scripts/dev-compose.sh --scenario conferencing1 build bluepill-bots
./scripts/dev-compose.sh --scenario conferencing1 up -d --force-recreate bluepill-bots
```

## Media assets

- **Audio**: 16 kHz mono PCM WAV clips for Neo and Morpheus, generated with ElevenLabs TTS and sound generation. Regenerate with:

  ```bash
  ELEVENLABS_API_KEY=your_key ./scripts/generate_matrix_audio.sh
  ```

  Override the voices with `ELEVENLABS_VOICE_NEO` and `ELEVENLABS_VOICE_MORPHEUS`. See `build/bluepill-aiortc-bots/media/README.md` for details.
- **Video**: the image generates MPEG-TS/H.264 waveform clips at image build time using ffmpeg `showwaves` in pronounced `p2p` mode. The bot loads those clips with aiortc packet passthrough where possible, avoiding Python frame rendering in normal operation.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `BOT_FRONTEND_URL` | `http://127.0.0.1:${CONFERENCING1_FRONTEND_PORT:-80}` | Frontend the bots create rooms on and join. |
| `BOT_PUBLIC_URL` | `https://${PUBLIC_IPV4}` | Public join URL printed in the logs. |
| `BOT_JOIN_TIMEOUT_MS` | `30000` | Join/setup timeout. |
| `BOT_HEALTH_INTERVAL_MS` | `15000` | aiortc peer-state and health heartbeat interval. |
| `BOT_RESTART_BACKOFF_MS` | `10000` | Pause between session teardown and a fresh provisioning attempt. |
| `BOT_CLEANUP_RETRIES` | `5` | Cleanup attempts after a bot session ends. |
| `BOT_CLEANUP_RETRY_DELAY_MS` | `1000` | Delay between cleanup attempts. |
| `BOT_AIORTC_VIDEO_WIDTH` | `160` | Generated video width. |
| `BOT_AIORTC_VIDEO_HEIGHT` | `120` | Generated video height. |
| `BOT_AIORTC_VIDEO_FPS` | `30` | Pre-rendered waveform video frame rate. |

## Joining the bots' room

The container deliberately uses a random meeting code so the bots use the same flow learners use. To drop in alongside them, grab the code from the logs and open `/meet/<code>` in your own browser. You will see Neo and Morpheus already streaming, complete with display-name labels that go through the same rendering path that the [display-name XSS](overview.md#vulnerable-behaviors) exercise targets.
