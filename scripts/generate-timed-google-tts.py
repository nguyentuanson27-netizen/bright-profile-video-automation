from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path

from dotenv import load_dotenv
from google.cloud import texttospeech


def run(command: list[str]) -> None:
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)


def duration(path: Path) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(result.stdout.strip())


def atempo_chain(speed: float) -> str:
    filters: list[str] = []
    while speed > 2:
        filters.append("atempo=2")
        speed /= 2
    while speed < 0.5:
        filters.append("atempo=0.5")
        speed /= 0.5
    filters.append(f"atempo={speed:.6f}")
    return ",".join(filters)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate a scene-aligned Google TTS track")
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--env-file", type=Path, default=Path("/root/video_api/.env"))
    parser.add_argument("--speaking-rate", type=float, default=1.03)
    parser.add_argument("--end-gap", type=float, default=0.18)
    parser.add_argument("--max-speed", type=float, default=1.35)
    args = parser.parse_args()

    load_dotenv(args.env_file)
    credentials = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    if credentials and not Path(credentials).is_absolute():
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = str((args.env_file.parent / credentials).resolve())

    language = os.getenv("GOOGLE_TTS_LANGUAGE", "vi-VN")
    voice_name = os.getenv("GOOGLE_TTS_VOICE", "vi-VN-Neural2-A")
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    chunks = sorted(manifest["chunks"], key=lambda item: float(item["start"]))
    total_duration = float(manifest["duration"])
    client = texttospeech.TextToSpeechClient()
    args.output.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="bright-tts-") as temp_name:
        temp = Path(temp_name)
        timeline: list[Path] = []
        cursor = 0.0

        for index, chunk in enumerate(chunks):
            start = float(chunk["start"])
            slot = float(chunk["duration"])
            if start > cursor + 0.001:
                silence = temp / f"{index:02d}-pre-gap.wav"
                run(["ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", f"{start - cursor:.6f}", "-c:a", "pcm_s16le", str(silence)])
                timeline.append(silence)

            raw = temp / f"{index:02d}-raw.mp3"
            response = client.synthesize_speech(
                input=texttospeech.SynthesisInput(text=str(chunk["text"])),
                voice=texttospeech.VoiceSelectionParams(language_code=language, name=voice_name),
                audio_config=texttospeech.AudioConfig(
                    audio_encoding=texttospeech.AudioEncoding.MP3,
                    speaking_rate=float(chunk.get("speakingRate", args.speaking_rate)),
                ),
            )
            raw.write_bytes(response.audio_content)
            raw_duration = duration(raw)
            content_target = max(0.5, slot - args.end_gap)
            required_speed = max(1.0, raw_duration / content_target)
            if required_speed > args.max_speed:
                raise RuntimeError(
                    f"Chunk {chunk.get('id', index)} needs speed {required_speed:.3f}, above max {args.max_speed:.3f}"
                )

            fitted = temp / f"{index:02d}-fitted.wav"
            filters = f"{atempo_chain(required_speed)},apad,atrim=0:{slot:.6f}"
            run(["ffmpeg", "-y", "-i", str(raw), "-af", filters, "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", str(fitted)])
            timeline.append(fitted)
            cursor = start + slot
            print(
                f"chunk={chunk.get('id', index)} slot={slot:.2f}s raw={raw_duration:.2f}s speed={required_speed:.3f}"
            )

        if cursor < total_duration - 0.001:
            silence = temp / "99-tail.wav"
            run(["ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", f"{total_duration - cursor:.6f}", "-c:a", "pcm_s16le", str(silence)])
            timeline.append(silence)

        concat_file = temp / "concat.txt"
        concat_file.write_text("".join(f"file '{item.as_posix()}'\n" for item in timeline), encoding="utf-8")
        run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file), "-t", f"{total_duration:.6f}", "-c:a", "pcm_s16le", str(args.output)])

    print(f"voice={voice_name} language={language} duration={duration(args.output):.3f}s output={args.output}")


if __name__ == "__main__":
    main()
