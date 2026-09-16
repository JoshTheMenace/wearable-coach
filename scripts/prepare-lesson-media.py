"""Prepare the user's local CPR video for the lesson; never uploads or bundles media."""
import argparse
import hashlib
import json
import subprocess
import uuid
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('source', type=Path)
parser.add_argument('--output', type=Path, default=Path('.runtime/lesson-media'))
parser.add_argument('--overview-start', type=float, default=50)
parser.add_argument('--overview-duration', type=float, default=55)
parser.add_argument('--placement-start', type=float, default=61.5)
parser.add_argument('--placement-duration', type=float, default=5)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
clips = []
for key, title, start, duration in [('overview', 'Compression-only demonstration', args.overview_start, args.overview_duration), ('hand-placement', 'Hand placement replay', args.placement_start, args.placement_duration)]:
    if start < 0 or not 0 < duration <= 300:
        raise ValueError('Invalid excerpt range')
    target = args.output / f'{key}.mp4'
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-ss', str(start), '-i', str(args.source), '-t', str(duration), '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2,fps=24', '-c:v', 'libx264', '-preset', 'fast', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-b:v', '120k', '-maxrate', '160k', '-bufsize', '240k', '-g', '24', '-keyint_min', '24', '-sc_threshold', '0', '-c:a', 'aac', '-ac', '1', '-ar', '32000', '-b:a', '24k', '-movflags', '+faststart', str(target)], check=True)
    sha = hashlib.sha256(target.read_bytes()).hexdigest()
    actual = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', str(target)]))
    clips.append(dict(id=str(uuid.uuid5(uuid.NAMESPACE_URL, 'coach:'+key+':'+sha)), lessonKey=key, title=title, file=target.name, width=320, height=180, durationMs=round(float(actual['format']['duration'])*1000), mime='video/mp4', sha256=sha, bytes=target.stat().st_size, sourceStartSeconds=start))
(args.output / 'manifest.json').write_text(json.dumps({'clips': clips}, indent=2)+'\n')
print(json.dumps({'clips': [{'key': clip['lessonKey'], 'durationMs': clip['durationMs'], 'bytes': clip['bytes']} for clip in clips]}))
