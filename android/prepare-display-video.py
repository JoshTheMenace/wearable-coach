"""Prepare local DAT playback fixtures; keep private media outside the APK/repository."""
import argparse
import json
from pathlib import Path
import subprocess
import struct
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("source", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("--compact", action="store_true", help="Compare a smaller, lower-bitrate encoding")
parser.add_argument("--pad-short-clips", action="store_true", help="Experimental: pad small MP4s to the tested 200 KB size")
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
results = []


def make(name, options, source_start):
    output = args.output / name
    started = time.monotonic()
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *options, str(output)], check=True)
    padding = max(8, 200_000 - output.stat().st_size) if args.pad_short_clips and output.stat().st_size < 200_000 else 0
    if padding:
        with output.open("ab") as stream:
            stream.write(struct.pack(">I4s", padding, b"free") + bytes(padding - 8))
    elapsed = time.monotonic() - started
    metadata = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration,size:stream=codec_name,codec_type,width,height,start_time,duration",
        "-of", "json", str(output),
    ]))
    results.append(dict(file=name, source_start_seconds=source_start, preparation_seconds=round(elapsed, 3), padding_bytes=padding, **metadata))
    print(f"{name}: {metadata['format']['size']} bytes; prepared in {elapsed:.3f}s", flush=True)


master = args.output / "master-120s.mp4"
width, height, fps, bitrate, maximum = (266, 150, 15, "48k", "72k") if args.compact else (320, 180, 24, "120k", "160k")
make(master.name, [
    "-ss", "60", "-i", str(args.source), "-t", "120", "-map", "0:v:0", "-map", "0:a:0",
    "-vf", f"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,fps={fps}",
    "-c:v", "libx264", "-preset", "fast", "-profile:v", "baseline", "-pix_fmt", "yuv420p",
    "-b:v", bitrate, "-maxrate", maximum, "-bufsize", "240k", "-g", str(fps), "-keyint_min", str(fps), "-sc_threshold", "0",
    "-c:a", "aac", "-ac", "1", "-ar", "32000", "-b:a", "24k", "-movflags", "+faststart",
], 60)
for name, offset in [("excerpt-a.mp4", 20), ("excerpt-b.mp4", 65)]:
    # Whole-second boundaries match the master's one-second keyframes; arbitrary cuts may need re-encoding.
    make(name, ["-ss", str(offset), "-i", str(master), "-t", "12", "-map", "0:v:0", "-map", "0:a:0",
                "-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart"], 60 + offset)
(args.output / "manifest.json").write_text(json.dumps(dict(source=str(args.source.resolve()), fixtures=results), indent=2) + "\n")
