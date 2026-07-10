from __future__ import annotations

import argparse
import os
from pathlib import Path

from dotenv import load_dotenv
from google.cloud import texttospeech


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate Bright Profile voice-over using Google Cloud TTS")
    parser.add_argument("input", type=Path, help="UTF-8 text or SSML file")
    parser.add_argument("output", type=Path, help="Output MP3 file")
    parser.add_argument("--env-file", type=Path, default=Path("/root/video_api/.env"))
    parser.add_argument("--speaking-rate", type=float, default=1.03)
    args = parser.parse_args()

    load_dotenv(args.env_file)
    credentials = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    if credentials and not Path(credentials).is_absolute():
        credentials = str((args.env_file.parent / credentials).resolve())
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = credentials

    language = os.getenv("GOOGLE_TTS_LANGUAGE", "vi-VN")
    voice_name = os.getenv("GOOGLE_TTS_VOICE", "vi-VN-Neural2-A")
    source = args.input.read_text(encoding="utf-8").strip()
    synthesis_input = (
        texttospeech.SynthesisInput(ssml=source)
        if source.startswith("<speak>")
        else texttospeech.SynthesisInput(text=source)
    )

    client = texttospeech.TextToSpeechClient()
    response = client.synthesize_speech(
        input=synthesis_input,
        voice=texttospeech.VoiceSelectionParams(language_code=language, name=voice_name),
        audio_config=texttospeech.AudioConfig(
            audio_encoding=texttospeech.AudioEncoding.MP3,
            speaking_rate=args.speaking_rate,
        ),
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(response.audio_content)
    print(f"voice={voice_name} language={language} bytes={len(response.audio_content)} output={args.output}")


if __name__ == "__main__":
    main()
