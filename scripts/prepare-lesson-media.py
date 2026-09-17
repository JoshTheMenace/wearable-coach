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
parser.add_argument('--overview-start', type=float, default=0)
parser.add_argument('--overview-duration', type=float, help='Default: play the source through its end')
parser.add_argument('--placement-start', type=float, default=61.5)
parser.add_argument('--placement-duration', type=float, default=5)
parser.add_argument('--compact', action='store_true', help='Use the lower-bandwidth encoding tested on the glasses')
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
width, height, fps, bitrate, maximum = (266, 150, 15, '48k', '72k') if args.compact else (320, 180, 24, '120k', '160k')
overview_duration = args.overview_duration
if overview_duration is None:
    metadata = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', str(args.source)]))
    overview_duration = float(metadata['format']['duration']) - args.overview_start
clips = []
for key, title, start, duration in [('overview', 'Adult CPR demonstration', args.overview_start, overview_duration), ('hand-placement', 'Hand placement replay', args.placement_start, args.placement_duration)]:
    if start < 0 or not 0 < duration <= 600:
        raise ValueError('Invalid excerpt range')
    target = args.output / f'{key}.mp4'
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-ss', str(start), '-i', str(args.source), '-t', str(duration), '-map', '0:v:0', '-map', '0:a:0?', '-vf', f'scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,fps={fps}', '-c:v', 'libx264', '-preset', 'fast', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-b:v', bitrate, '-maxrate', maximum, '-bufsize', '240k', '-g', str(fps), '-keyint_min', str(fps), '-sc_threshold', '0', '-c:a', 'aac', '-ac', '1', '-ar', '32000', '-b:a', '24k', '-movflags', '+faststart', str(target)], check=True)
    sha = hashlib.sha256(target.read_bytes()).hexdigest()
    actual = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', str(target)]))
    clips.append(dict(id=str(uuid.uuid5(uuid.NAMESPACE_URL, 'coach:'+key+':'+sha)), lessonKey=key, title=title, file=target.name, width=width, height=height, durationMs=round(float(actual['format']['duration'])*1000), mime='video/mp4', sha256=sha, bytes=target.stat().st_size, sourceStartSeconds=start))
(args.output / 'manifest.json').write_text(json.dumps({'clips': clips}, indent=2)+'\n')
print(json.dumps({'clips': [{'key': clip['lessonKey'], 'durationMs': clip['durationMs'], 'bytes': clip['bytes']} for clip in clips]}))
