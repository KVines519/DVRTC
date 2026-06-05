#!/bin/bash
#
# Generate Matrix-themed audio for the conferencing1 BluePill Meeting bots.
#
# The dialogue is generated turn by turn so each bot's WAV contains only that
# speaker's lines, padded with silence wherever the other speaker is talking.
# Both final WAVs end up the same length, so when Chromium loops them through
# --use-file-for-fake-audio-capture the speakers don't talk over each other.
#
# Continuity: each ElevenLabs request passes previous_text (the prior turn,
# regardless of speaker) and previous_request_ids (up to 3 prior request IDs
# from the SAME speaker). The audio-level chaining via previous_request_ids
# is what keeps a speaker's tone, breathing and intonation consistent across
# their turns; without it each clip sounds like a different take of the same
# voice. See https://elevenlabs.io/docs/api-reference/text-to-speech/convert
#
# Per-line WAV cache: cache keys are content-hashed across (speaker, voice_id,
# model, voice settings, text, previous_text, previous_request_ids), so changes
# to the dialogue invalidate only the affected lines while reordering/inserting
# preserves cache hits where the surrounding context didn't change.
#
# Output: 16 kHz mono 16-bit PCM WAV, one per speaker, plus dialogue.json:
#   build/bluepill-aiortc-bots/media/neo.wav
#   build/bluepill-aiortc-bots/media/morpheus.wav
#   build/bluepill-aiortc-bots/media/dialogue.json
#
# Prerequisites:
#   - ELEVENLABS_API_KEY environment variable set
#   - sox + soxi installed (apt-get install sox libsox-fmt-all)
#   - curl, file, shasum, python3
#
# Usage:
#   ELEVENLABS_API_KEY=your_key ./scripts/generate_matrix_audio.sh
#
# Voice overrides:
#   ELEVENLABS_VOICE_NEO=<voice_id>
#   ELEVENLABS_VOICE_MORPHEUS=<voice_id>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="${SCRIPT_DIR}/../build/bluepill-aiortc-bots/media"
PARTS_DIR="${OUTPUT_DIR}/parts"

if [ -z "${ELEVENLABS_API_KEY:-}" ]; then
    echo "ERROR: ELEVENLABS_API_KEY environment variable is not set"
    echo "Get an API key at https://elevenlabs.io"
    exit 1
fi

for cmd in curl sox soxi file shasum python3; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "ERROR: $cmd is required but not installed"
        exit 1
    fi
done

mkdir -p "$OUTPUT_DIR" "$PARTS_DIR"

#
# Voice + model defaults
#
# Picked from the ElevenLabs public Voice Library by character tone (no
# celebrity clones - those get taken down). Override with the env vars.
#   Neo:      Grant - Engaging, Friendly & Bright
#   Morpheus: Lamin - Deep, Calm and Composed
VOICE_NEO="${ELEVENLABS_VOICE_NEO:-4hQGiNXzNgJFIkfUJCQT}"
VOICE_MORPHEUS="${ELEVENLABS_VOICE_MORPHEUS:-hILdTfuUq4LRBMrxHERr}"
ELEVENLABS_MODEL_ID="${ELEVENLABS_MODEL_ID:-eleven_multilingual_v2}"

MAX_PREV_REQUEST_IDS="${BOT_AUDIO_MAX_PREV_REQS:-3}"

# Pause between turns so the dialogue doesn't feel rushed.
TURN_GAP_SECONDS="${BOT_AUDIO_TURN_GAP:-0.5}"

#
# Dialogue
#
# Format: "speaker|text". The script generates lines in order, threading
# previous_text and previous_request_ids through each call so the per-speaker
# voice keeps consistent prosody across turns.
DIALOGUE=(
    "neo|Hello?"
    "morpheus|Mister Anderson."
    "morpheus|I imagine that right now, you're feeling a bit like Alice. Tumbling down the rabbit hole."
    "neo|You could say that."
    "morpheus|I see it in your eyes. You have the look of a man who accepts what he sees because he is expecting to wake up."
    "neo|Do you believe in fate, Morpheus?"
    "morpheus|No."
    "neo|Why not?"
    "morpheus|Because I don't like the idea that I'm not in control of my life."
    "neo|I know what you mean."
    "morpheus|Let me tell you why you are here. You're here because you know something. What you know, you can't explain, but you feel it. You've felt it your entire life. That there is something wrong with the world."
    "neo|The Matrix?"
    "morpheus|Do you want to know what it is?"
    "neo|Yes."
    "morpheus|This is your last chance. After this, there is no turning back. You take the blue pill, the story ends. You take the red pill, you stay in Wonderland, and I show you how deep the rabbit hole goes. Remember, all I am offering is the truth. Nothing more."
    "neo|I'll take the red pill."
    "morpheus|Then follow me."
)

#
# Per-side preamble / outro knobs
#
# Morpheus is the caller, Neo picks up. After "Then follow me." Morpheus hangs
# up first and Neo is left with the fast-busy tone.
DIAL_SECONDS="${BOT_AUDIO_DIAL_SECONDS:-1.5}"
RING_BURST_SECONDS="${BOT_AUDIO_RING_BURST_SECONDS:-2.0}"
RING_GAP_SECONDS="${BOT_AUDIO_RING_GAP_SECONDS:-4.0}"
PRE_PICKUP_SECONDS="${BOT_AUDIO_PRE_PICKUP_SECONDS:-0.3}"
POST_PICKUP_SECONDS="${BOT_AUDIO_POST_PICKUP_SECONDS:-0.6}"
POST_DIALOGUE_PAUSE_SECONDS="${BOT_AUDIO_POST_DIALOGUE_PAUSE:-1.6}"
POST_SLAM_SECONDS="${BOT_AUDIO_POST_SLAM_SECONDS:-0.4}"
BUSY_BURST_SECONDS="${BOT_AUDIO_BUSY_BURST_SECONDS:-0.5}"
BUSY_GAP_SECONDS="${BOT_AUDIO_BUSY_GAP_SECONDS:-0.5}"
BUSY_TOTAL_SECONDS="${BOT_AUDIO_BUSY_TOTAL_SECONDS:-10}"

#
# Helpers
#

hash_key() {
    printf '%s' "$1" | shasum -a 1 | cut -c1-16
}

silence_wav() {
    local seconds="$1" out="$2"
    sox -n -r 16000 -c 1 -b 16 "$out" trim 0.0 "$seconds"
}

# Per-speaker request-id history as newline-separated strings (most recent
# first). Strings avoid the bash 3.2 / set -u empty-array expansion quirks.
NEO_PREV_REQS=""
MORPHEUS_PREV_REQS=""

push_prev_req() {
    local speaker="$1" reqid="$2"
    [ -z "$reqid" ] && return 0
    local current
    case "$speaker" in
        neo) current="$NEO_PREV_REQS" ;;
        morpheus) current="$MORPHEUS_PREV_REQS" ;;
        *) return 0 ;;
    esac
    local trimmed=""
    if [ -n "$current" ]; then
        trimmed=$(printf '%s\n' "$current" | head -n $((MAX_PREV_REQUEST_IDS - 1)))
    fi
    local new
    if [ -n "$trimmed" ]; then
        new=$(printf '%s\n%s' "$reqid" "$trimmed")
    else
        new="$reqid"
    fi
    case "$speaker" in
        neo) NEO_PREV_REQS="$new" ;;
        morpheus) MORPHEUS_PREV_REQS="$new" ;;
    esac
}

get_prev_reqs_csv() {
    local speaker="$1" current=""
    case "$speaker" in
        neo) current="$NEO_PREV_REQS" ;;
        morpheus) current="$MORPHEUS_PREV_REQS" ;;
    esac
    [ -z "$current" ] && return 0
    printf '%s' "$current" | tr '\n' ',' | sed 's/,$//'
}

# Globals set by generate_line on return.
CURRENT_PART_WAV=""
CURRENT_REQUEST_ID=""

# generate_line speaker voice_id text previous_text
# Populates CURRENT_PART_WAV and CURRENT_REQUEST_ID.
generate_line() {
    local speaker="$1" voice_id="$2" text="$3" prev_text="$4"
    local stability=0.5 similarity=0.78
    if [ "$speaker" = "morpheus" ]; then
        stability=0.4
        similarity=0.85
    fi

    local prev_ids_csv
    prev_ids_csv=$(get_prev_reqs_csv "$speaker")

    local key
    key=$(hash_key "v2|${speaker}|${voice_id}|${ELEVENLABS_MODEL_ID}|${stability}|${similarity}|${prev_text}|${prev_ids_csv}|${text}")
    local part_wav="${PARTS_DIR}/${key}.wav"
    local part_reqid="${PARTS_DIR}/${key}.reqid"

    if [ -f "$part_wav" ] && [ -f "$part_reqid" ]; then
        local cached_id
        cached_id=$(cat "$part_reqid")
        echo "  [cache] $speaker: ${text:0:60}..." >&2
        CURRENT_PART_WAV="$part_wav"
        CURRENT_REQUEST_ID="$cached_id"
        return 0
    fi

    echo "  [gen]   $speaker: ${text:0:60}..." >&2

    local payload
    payload=$(python3 - "$text" "$ELEVENLABS_MODEL_ID" "$stability" "$similarity" "$prev_text" "$prev_ids_csv" <<'PY'
import json, sys
text, model, stab, sim, prev_text, prev_ids = sys.argv[1:7]
data = {
    "text": text,
    "model_id": model,
    "voice_settings": {"stability": float(stab), "similarity_boost": float(sim)},
}
if prev_text:
    data["previous_text"] = prev_text
prev_list = [i for i in prev_ids.split(",") if i]
if prev_list:
    data["previous_request_ids"] = prev_list
print(json.dumps(data))
PY
)

    local part_mp3="${part_wav%.wav}.mp3"
    local headers_file="${PARTS_DIR}/_headers_${key}"

    curl -s -D "$headers_file" -X POST "https://api.elevenlabs.io/v1/text-to-speech/${voice_id}" \
        -H "xi-api-key: ${ELEVENLABS_API_KEY}" \
        -H "Content-Type: application/json" \
        -d "$payload" \
        -o "$part_mp3"

    if [ ! -s "$part_mp3" ] || file "$part_mp3" | grep -qi "text\|json\|html"; then
        echo "  [error] $speaker - non-audio response:" >&2
        cat "$part_mp3" >&2 || true
        rm -f "$part_mp3" "$headers_file"
        return 1
    fi

    local request_id=""
    if [ -f "$headers_file" ]; then
        request_id=$(awk 'tolower($1)=="request-id:" { gsub(/\r/, "", $2); print $2; exit }' "$headers_file")
    fi
    printf '%s' "$request_id" > "$part_reqid"
    rm -f "$headers_file"

    sox "$part_mp3" -r 16000 -c 1 -b 16 -e signed-integer "$part_wav"
    rm -f "$part_mp3"

    CURRENT_PART_WAV="$part_wav"
    CURRENT_REQUEST_ID="$request_id"
}

generate_sound() {
    local prompt="$1" out_wav="$2" duration_seconds="$3"

    local key
    key=$(hash_key "sound|v2|${duration_seconds}|${prompt}")
    local cache_wav="${PARTS_DIR}/sound_${key}.wav"

    if [ -f "$cache_wav" ]; then
        echo "  [cache] sound: ${prompt:0:60}..." >&2
        cp "$cache_wav" "$out_wav"
        return 0
    fi

    echo "  [gen]   sound: ${prompt:0:60}..." >&2

    local payload
    payload=$(python3 - "$prompt" "$duration_seconds" <<'PY'
import json, sys
text, duration_seconds = sys.argv[1:3]
data = {"text": text}
if duration_seconds:
    data["duration_seconds"] = float(duration_seconds)
print(json.dumps(data))
PY
)

    local part_mp3="${cache_wav%.wav}.mp3"

    curl -s -X POST "https://api.elevenlabs.io/v1/sound-generation" \
        -H "xi-api-key: ${ELEVENLABS_API_KEY}" \
        -H "Content-Type: application/json" \
        -d "$payload" \
        -o "$part_mp3"

    if [ ! -s "$part_mp3" ] || file "$part_mp3" | grep -qi "text\|json\|html"; then
        echo "  [error] sound - non-audio response:" >&2
        cat "$part_mp3" >&2 || true
        rm -f "$part_mp3"
        return 1
    fi

    sox "$part_mp3" -r 16000 -c 1 -b 16 -e signed-integer "$cache_wav"
    rm -f "$part_mp3"

    cp "$cache_wav" "$out_wav"
}

#
# Synthesised call sounds (dial, ring, pickup, hangup slam, busy)
#

dial_tone_wav() {
    local out="$1"
    sox -n -r 16000 -c 1 -b 16 "$out" \
        synth "$DIAL_SECONDS" sine 350 sine 440 channels 1 vol 0.35
}

ring_tone_wav() {
    local out="$1"
    local on="${PARTS_DIR}/_ring_on.wav"
    local gap="${PARTS_DIR}/_ring_gap.wav"
    sox -n -r 16000 -c 1 -b 16 "$on" \
        synth "$RING_BURST_SECONDS" sine 440 sine 480 channels 1 vol 0.30
    silence_wav "$RING_GAP_SECONDS" "$gap"
    sox "$on" "$gap" "$on" "$out"
    rm -f "$on" "$gap"
}

pickup_click_wav() {
    local out="$1"
    generate_sound "telephone handset being lifted off cradle, brief plastic click, single sharp hookswitch tick" "$out" 1.0
}

hangup_slam_wav() {
    local out="$1"
    generate_sound "close-up foley recording of an old landline telephone receiver being placed firmly onto its cradle, single hard plastic clack and hookswitch click, abrupt stop, no rattle, no repeated clicking" "$out" 0.8
}

busy_tone_wav() {
    local out="$1"
    local on="${PARTS_DIR}/_busy_on.wav"
    local gap="${PARTS_DIR}/_busy_gap.wav"
    sox -n -r 16000 -c 1 -b 16 "$on" \
        synth "$BUSY_BURST_SECONDS" sine 480 sine 620 channels 1 vol 0.35
    silence_wav "$BUSY_GAP_SECONDS" "$gap"

    local cycle_len
    cycle_len=$(awk -v b="$BUSY_BURST_SECONDS" -v g="$BUSY_GAP_SECONDS" 'BEGIN{ printf "%f", b + g }')
    local cycles
    cycles=$(awk -v t="$BUSY_TOTAL_SECONDS" -v c="$cycle_len" 'BEGIN{ n = int(t / c); if (n < 1) n = 1; printf "%d", n }')

    local args=()
    local i=0
    while [ $i -lt "$cycles" ]; do
        args+=("$on" "$gap")
        i=$((i+1))
    done

    sox "${args[@]}" "$out"
    rm -f "$on" "$gap"
}

#
# Pass 1: generate every dialogue line in order, threading per-speaker
# previous_request_ids so each generation has acoustic context. Records the
# per-turn part WAV path in TURN_AUDIO[idx].
#
echo "Generating dialogue (with per-speaker request-id chaining)..."
echo "Output: ${OUTPUT_DIR}"
echo ""

declare -a TURN_AUDIO
declare -a TURN_SPEAKER

prev_text=""
for idx in "${!DIALOGUE[@]}"; do
    entry="${DIALOGUE[$idx]}"
    speaker="${entry%%|*}"
    text="${entry#*|}"
    case "$speaker" in
        neo) voice="$VOICE_NEO" ;;
        morpheus) voice="$VOICE_MORPHEUS" ;;
        *) echo "ERROR: unknown speaker '$speaker' at turn $idx" >&2; exit 1 ;;
    esac

    generate_line "$speaker" "$voice" "$text" "$prev_text"
    TURN_AUDIO[$idx]="$CURRENT_PART_WAV"
    TURN_SPEAKER[$idx]="$speaker"
    push_prev_req "$speaker" "$CURRENT_REQUEST_ID"
    prev_text="$text"
done

#
# Pass 2: build per-speaker inner tracks from the cached per-turn audio.
#
build_track() {
    local target_speaker="$1" output_wav="$2"
    local track_parts=()

    for idx in "${!DIALOGUE[@]}"; do
        local speaker="${TURN_SPEAKER[$idx]}"
        local part_wav="${TURN_AUDIO[$idx]}"
        local turn_duration
        turn_duration="$(soxi -D "$part_wav")"

        local clip="${PARTS_DIR}/_build_${target_speaker}_$(printf '%02d' "$idx").wav"
        if [ "$speaker" = "$target_speaker" ]; then
            cp "$part_wav" "$clip"
        else
            silence_wav "$turn_duration" "$clip"
        fi
        track_parts+=("$clip")

        if [ "$TURN_GAP_SECONDS" != "0" ] && [ "$idx" -lt $((${#DIALOGUE[@]} - 1)) ]; then
            local gap="${PARTS_DIR}/_build_${target_speaker}_$(printf '%02d' "$idx")_gap.wav"
            silence_wav "$TURN_GAP_SECONDS" "$gap"
            track_parts+=("$gap")
        fi
    done

    sox "${track_parts[@]}" "$output_wav"
}

#
# Pass 3: synthesised call sounds and per-side preamble + outro.
#
echo ""
echo "Synthesising dial / ring / pickup / hangup / busy tones..."
DIAL_WAV="${PARTS_DIR}/_dial.wav"
RING_WAV="${PARTS_DIR}/_ring.wav"
PICKUP_WAV="${PARTS_DIR}/_pickup.wav"
SLAM_WAV="${PARTS_DIR}/_slam.wav"
BUSY_WAV="${PARTS_DIR}/_busy.wav"
dial_tone_wav "$DIAL_WAV"
ring_tone_wav "$RING_WAV"
pickup_click_wav "$PICKUP_WAV"
hangup_slam_wav "$SLAM_WAV"
busy_tone_wav "$BUSY_WAV"

PICKUP_LEN="$(soxi -D "$PICKUP_WAV")"
SLAM_LEN="$(soxi -D "$SLAM_WAV")"
RING_LEN="$(soxi -D "$RING_WAV")"

# Preamble slot timings (matched on both sides; only the emitting side has
# audible content, the other side has silence of the same duration):
#   DIAL          - Morpheus dials.
#   RING          - Caller-side ringback while Neo's phone rings.
#   PRE_PICKUP    - Both silent (gap between last ring and pickup).
#   PICKUP        - Neo's handset click as he answers.
#   POST_PICKUP   - Both silent (line stabilises before Neo speaks).
#
# Outro slot timings:
#   POST_DIALOGUE - Both silent (Morpheus pauses after "Then follow me.").
#   SLAM          - Morpheus drops the handset.
#   POST_SLAM     - Both silent (line settles into fast-busy).
#   BUSY          - Neo hears fast-busy.
echo "Assembling per-side preamble + outro..."

PRE_M="${PARTS_DIR}/_preamble_morpheus.wav"
PRE_N="${PARTS_DIR}/_preamble_neo.wav"
OUT_M="${PARTS_DIR}/_outro_morpheus.wav"
OUT_N="${PARTS_DIR}/_outro_neo.wav"

# Silence slots reused across sides.
SIL_DIAL="${PARTS_DIR}/_s_dial.wav"
SIL_RING="${PARTS_DIR}/_s_ring.wav"
SIL_PRE_PU="${PARTS_DIR}/_s_pre_pu.wav"
SIL_PICKUP="${PARTS_DIR}/_s_pickup.wav"
SIL_POST_PU="${PARTS_DIR}/_s_post_pu.wav"
SIL_POST_DIA="${PARTS_DIR}/_s_post_dia.wav"
SIL_SLAM="${PARTS_DIR}/_s_slam.wav"
SIL_POST_SLAM="${PARTS_DIR}/_s_post_slam.wav"
SIL_BUSY="${PARTS_DIR}/_s_busy.wav"
BUSY_LEN="$(soxi -D "$BUSY_WAV")"

silence_wav "$DIAL_SECONDS"               "$SIL_DIAL"
silence_wav "$RING_LEN"                   "$SIL_RING"
silence_wav "$PRE_PICKUP_SECONDS"         "$SIL_PRE_PU"
silence_wav "$PICKUP_LEN"                 "$SIL_PICKUP"
silence_wav "$POST_PICKUP_SECONDS"        "$SIL_POST_PU"
silence_wav "$POST_DIALOGUE_PAUSE_SECONDS" "$SIL_POST_DIA"
silence_wav "$SLAM_LEN"                   "$SIL_SLAM"
silence_wav "$POST_SLAM_SECONDS"          "$SIL_POST_SLAM"
silence_wav "$BUSY_LEN"                   "$SIL_BUSY"

# Morpheus preamble: dial + ring + (pre-pickup silence) + (silent during pickup) + (post-pickup silence)
sox "$DIAL_WAV" "$RING_WAV" "$SIL_PRE_PU" "$SIL_PICKUP" "$SIL_POST_PU" "$PRE_M"
# Neo preamble: silence(dial) + silence(ring) + silence(pre-pickup) + pickup click + silence(post-pickup)
sox "$SIL_DIAL" "$SIL_RING" "$SIL_PRE_PU" "$PICKUP_WAV" "$SIL_POST_PU" "$PRE_N"

# Morpheus outro: post-dialogue silence + hangup slam + silence(post-slam) + silence(busy)
sox "$SIL_POST_DIA" "$SLAM_WAV" "$SIL_POST_SLAM" "$SIL_BUSY" "$OUT_M"
# Neo outro: post-dialogue silence + silence(slam) + silence(post-slam) + busy tone
sox "$SIL_POST_DIA" "$SIL_SLAM" "$SIL_POST_SLAM" "$BUSY_WAV" "$OUT_N"

PREAMBLE_LEN="$(soxi -D "$PRE_M")"
OUTRO_LEN="$(soxi -D "$OUT_M")"

#
# Pass 4: per-speaker inner tracks, then final assembly.
#
echo "Assembling per-speaker inner tracks..."
INNER_N="${PARTS_DIR}/_inner_neo.wav"
INNER_M="${PARTS_DIR}/_inner_morpheus.wav"
build_track neo      "$INNER_N"
build_track morpheus "$INNER_M"

rm -f "${OUTPUT_DIR}/neo.wav" "${OUTPUT_DIR}/morpheus.wav"
sox "$PRE_N" "$INNER_N" "$OUT_N" "${OUTPUT_DIR}/neo.wav"
sox "$PRE_M" "$INNER_M" "$OUT_M" "${OUTPUT_DIR}/morpheus.wav"

# Clean up transient build slices; keep the per-line content-hashed cache so
# subsequent runs only re-bill ElevenLabs for new or changed lines.
find "$PARTS_DIR" -maxdepth 1 \( -name '_build_*.wav' -o -name '_s_*.wav' \
    -o -name '_dial.wav' -o -name '_ring.wav' -o -name '_pickup.wav' \
    -o -name '_slam.wav' -o -name '_busy.wav' \
    -o -name '_preamble_*.wav' -o -name '_outro_*.wav' \
    -o -name '_inner_*.wav' -o -name '_headers_*' \) -delete

neo_len="$(soxi -D "${OUTPUT_DIR}/neo.wav")"
mor_len="$(soxi -D "${OUTPUT_DIR}/morpheus.wav")"
duration_ms=$(awk -v s="$neo_len" 'BEGIN{ printf "%d", s * 1000 }')

cat > "${OUTPUT_DIR}/dialogue.json" <<EOF
{
  "durationMs": ${duration_ms},
  "neoSeconds": ${neo_len},
  "morpheusSeconds": ${mor_len},
  "preambleSeconds": ${PREAMBLE_LEN},
  "outroSeconds": ${OUTRO_LEN}
}
EOF

echo ""
printf '  neo.wav      %.2fs  (%s)\n' "$neo_len" "$(du -h "${OUTPUT_DIR}/neo.wav" | cut -f1)"
printf '  morpheus.wav %.2fs  (%s)\n' "$mor_len" "$(du -h "${OUTPUT_DIR}/morpheus.wav" | cut -f1)"
echo "  dialogue.json: $(cat "${OUTPUT_DIR}/dialogue.json" | tr -d '\n' | tr -s ' ')"
echo ""
echo "Audio generation complete."
