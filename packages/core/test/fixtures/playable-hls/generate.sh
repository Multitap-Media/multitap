#!/bin/sh
# Regenerates the playable test clip for core's fake engine (`playableMedia`).
# A generated test pattern (lavfi testsrc2) with a 440 Hz tone and a burned-in
# clock: no third-party content. 480x270, H.264 Main yuv420p + AAC-LC mono,
# 120 s in 30 MPEG-TS segments of 4 s (keyframe at every segment start).
# Needs an ffmpeg with libx264 and drawtext. FONT is a TrueType font file; the
# ffmpeg filter wants the path escaped (drive-colon as `C\:/...`).
# The .bin extension keeps linters and tsc from parsing MPEG-TS as TypeScript.
set -eu
cd "$(dirname "$0")"
FONT="${FONT:-C\:/Windows/Fonts/arial.ttf}"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=480x270:rate=24:duration=120" \
  -f lavfi -i "sine=frequency=440:sample_rate=44100:duration=120" \
  -vf "drawtext=fontfile='$FONT':text='%{pts\:hms}':x=(w-tw)/2:y=h-th-12:fontsize=36:fontcolor=white:box=1:boxcolor=black@0.6" \
  -c:v libx264 -profile:v main -pix_fmt yuv420p -preset slow \
  -b:v 40k -maxrate 60k -bufsize 120k -g 96 -keyint_min 96 -sc_threshold 0 \
  -force_key_frames "expr:gte(t,n_forced*4)" \
  -c:a aac -b:a 24k -ac 1 \
  -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_type mpegts \
  -hls_segment_filename seg%d.bin playlist.m3u8
