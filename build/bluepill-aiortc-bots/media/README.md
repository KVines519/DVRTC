# BluePill Bots Media Provenance

The WAV files in this directory are the looping audio tracks published by the
aiortc BluePill Meeting bots for the two participants ("Neo" and "Morpheus").
The aiortc image generates MPEG-TS/H.264 waveform video clips from these WAVs
at image build time, so the visualised waveform stays in sync with the speech.

- Source workflow: `scripts/generate_matrix_audio.sh`
- Generation method: synthetic text-to-speech output
- Current provider used by the script: ElevenLabs
- Required regeneration inputs: `ELEVENLABS_API_KEY`, `curl`, `file`, and `sox`
- Output format: 16 kHz mono 16-bit PCM WAV

The dialog content is paraphrased synthetic material echoing the original
Wachowskis film, intended only to give the lab meeting realistic-sounding
conversation. These files are not recordings of the film's audio.

To regenerate them:

```bash
ELEVENLABS_API_KEY=your_key ./scripts/generate_matrix_audio.sh
```

Override the voices if your ElevenLabs account exposes better matches:

```bash
ELEVENLABS_VOICE_NEO=<voice_id> \
ELEVENLABS_VOICE_MORPHEUS=<voice_id> \
ELEVENLABS_API_KEY=your_key \
./scripts/generate_matrix_audio.sh
```

The generator skips existing `.wav` files. Remove a clip first if you want to
recreate it.

If the audio files are missing at container start the bot still launches; it
just publishes video with a static fallback and no bot audio.
