#!/usr/bin/env bash
#
# The ground truth for smooth slow motion: clips whose missing frames are KNOWN.
#
# Every scene is made at 120 fps, and every fourth frame of it is the 30 fps "recording" an engine
# is given. Slowed to 0.5x, the frame an engine has to invent halfway between two recorded ones is
# the 120 fps frame two along; slowed to 0.25x, the three it invents are the three frames between.
# So an interpolated frame can be scored against the picture that really was there, rather than
# judged by eye - which is how "flow beats blend" becomes a number (score.sh).
#
# The scenes are the cases the brief names, each a different way to be right or wrong:
#
#   panzoom  a detailed picture panned and zoomed at once, sub-pixel exact (perspective filter):
#            motion everywhere, none of it a plain translation.
#   objects  a still background with a spinning textured disc crossing in front of a textured
#            card moving the other way: two motions, an occlusion, rotation.
#   whip     a whip pan that eases up to 120 px per recorded frame and back: inside the flow's
#            search range at the ends, far beyond it in the middle.
#   static   a still picture with fresh sensor noise on every frame: flow has to find NOTHING.
#   cut      a hard cut between two recorded frames: no motion explains it.
#   flash    a slow pan through a burst of light: the brightness changes, the picture does not move.
#
# The texture is procedural, so the benchmark is reproducible from this file alone: a Mandelbrot
# region (smooth gradients, fine detail, flat dark areas), coloured noise at two scales over it, text
# (sharp edges) and a grid (long straight edges, the aperture problem).
#
# Usage: generate.sh OUT_DIR [WIDTH HEIGHT]     default 720 1280; 360 640 for quick runs
#
# Writes OUT_DIR/<scene>/f000.png .. f119.png (every frame at 120 fps; f000, f004, ... are the
# recording), and OUT_DIR/bench-30fps.mp4: the six recordings end to end at 30 fps, H.264, for a
# post on the phone.

set -euo pipefail

OUT=${1:?usage: generate.sh OUT_DIR [WIDTH HEIGHT]}
OW=${2:-720}
OH=${3:-1280}
FRAMES=120
mkdir -p "$OUT"
TEX="$OUT/textures"
mkdir -p "$TEX"

ff() { ffmpeg -hide_banner -v error -y "$@"; }

# Fonts for the text: Windows' own. Any bold sans will do elsewhere.
FONT_BOLD='C\:/Windows/Fonts/arialbd.ttf'
FONT='C\:/Windows/Fonts/arial.ttf'

# texture NAME MANDELBROT_X MANDELBROT_Y SCALE TEXT HUE
texture() {
  local name=$1 mx=$2 my=$3 scale=$4 text=$5 hue=$6
  ff -f lavfi -i "mandelbrot=s=1600x1600:start_scale=$scale:start_x=$mx:start_y=$my:end_pts=1:inner=period,format=rgb24" \
     -f lavfi -i "nullsrc=s=1600x1600,format=rgb24,geq=r='random(1)*255':g='random(2)*255':b='random(3)*255'" \
     -filter_complex "[1:v]split=2[n1][n2];[n1]gblur=sigma=3,eq=contrast=4[f];[n2]gblur=sigma=14,eq=contrast=10[c];[f][c]blend=all_mode=overlay[noise];[0:v][noise]blend=all_mode=softlight:all_opacity=0.8,hue=h=$hue,drawtext=fontfile='$FONT_BOLD':text='$text':fontsize=110:fontcolor=white:borderw=6:bordercolor=black:x=60:y=300,drawtext=fontfile='$FONT':text='the quick brown fox 45 67':fontsize=80:fontcolor=yellow:x=100:y=1200,drawgrid=w=200:h=200:t=3:c=white@0.6,format=rgb24[out]" \
     -map "[out]" -frames:v 1 "$TEX/$name.png"
}

texture a -0.7453 0.1127 0.02 'LIGHTSNAP 0123456789' 0
texture c -0.1011 0.9563 0.01 'SLOW MOTION 2468' 140
# The whip needs a long strip: the picture, its mirror, the picture.
ff -i "$TEX/a.png" -filter_complex "[0:v]split=3[p][q][r];[q]hflip[m];[p][m][r]hstack=3" "$TEX/wide.png"

# The final size. Everything below is drawn at 720x1280 and scaled once, so a small run is the same
# motion at half the pixels. Square pixels, said out loud: `scale` keeps the DISPLAY shape, so after
# the panzoom's 1600x1600 it would label its 720x1280 frames 16:9-pixelled, and a player - Media3
# included - would stretch them.
FINAL="scale=${OW}:${OH}:flags=area,setsar=1,format=rgb24"

# scene NAME INPUTS... -- FILTERGRAPH (ending in [out])
scene() {
  local name=$1
  shift
  local inputs=()
  while [[ $1 != -- ]]; do inputs+=("$1"); shift; done
  shift
  mkdir -p "$OUT/$name"
  rm -f "$OUT/$name"/f*.png
  ff "${inputs[@]}" -filter_complex "$1" -map '[out]' -frames:v $FRAMES -start_number 0 "$OUT/$name/f%03d.png"
  echo "$name: $(ls "$OUT/$name" | wc -l) frames"
}

still() { echo -loop 1 -framerate 120 -i "$TEX/$1.png"; }

# panzoom: the window's centre moves 400 px right and 150 px down in the second while it zooms 1.0 to
# 1.3x. The perspective filter maps the window onto the whole 1600x1600 frame, and the scale after it
# undoes that stretch, so the net mapping is 1:1 and every step is resampled, never rounded.
PZ_T='(in/120)'
PZ_Z="(1+0.3*$PZ_T)"
PZ_CX="(500+400*$PZ_T)"
PZ_CY="(760+150*$PZ_T)"
PZ_HW="(360/$PZ_Z)"
PZ_HH="(640/$PZ_Z)"
scene panzoom $(still a) -- \
  "[0:v]perspective=x0='$PZ_CX-$PZ_HW':y0='$PZ_CY-$PZ_HH':x1='$PZ_CX+$PZ_HW':y1='$PZ_CY-$PZ_HH':x2='$PZ_CX-$PZ_HW':y2='$PZ_CY+$PZ_HH':x3='$PZ_CX+$PZ_HW':y3='$PZ_CY+$PZ_HH':interpolation=cubic:sense=source:eval=frame,scale=720:1280:flags=lanczos,$FINAL[out]"

# objects: the background still; a 300 px disc of the other picture, spinning 1.5 rad/s, crossing
# left to right at 8 px a frame (32 per recorded frame) in FRONT of a card moving right to left at 3.
scene objects $(still a) $(still c) -- \
  "[0:v]crop=720:1280:440:160[bg];[1:v]split=2[c1][c2];[c1]crop=420:420:600:500,rotate=a='1.5*t':c=none,crop=300:300,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*clip(150.5-hypot(X-149.5,Y-149.5),0,1)'[disc];[c2]crop=280:180:200:900,hue=h=200,format=rgba[card];[bg][card]overlay=x='700-3*n':y=560:eval=frame[mid];[mid][disc]overlay=x='-300+8*n':y=500:eval=frame,$FINAL[out]"

# whip: eases from rest up to 120 px per recorded frame at the middle of the second and back.
scene whip $(still wide) -- \
  "[0:v]crop=720:1280:x='140+1800*(t-sin(2*PI*t)/(2*PI))':y=160,$FINAL[out]"

# static: nothing moves, and every frame has noise of its own.
scene static $(still a) -- \
  "[0:v]crop=720:1280:440:160,noise=alls=5:allf=t,$FINAL[out]"

# cut: a slow pan of one picture, then from frame 62 - between recorded frames 60 and 64 - another.
scene cut $(still a) $(still c) -- \
  "[0:v]crop=720:1280:x='200+2*n':y=160[p];[1:v]crop=720:1280:x=300:y='100+2*n'[q];[p][q]overlay=enable='gte(n,62)',$FINAL[out]"

# flash: a slow pan, and a burst of light peaking ON recorded frame 60.
scene flash $(still a) -- \
  "[0:v]crop=720:1280:x='300+n':y=160,eq=brightness='0.35*exp(-pow((n-60)/4,2))':eval=frame,$FINAL[out]"

# The recordings, end to end, for the phone: every fourth frame of each scene at 30 fps.
LIST="$OUT/bench-list.txt"
: >"$LIST"
for name in panzoom objects whip static cut flash; do
  ff -framerate 120 -start_number 0 -i "$OUT/$name/f%03d.png" -vf "select='not(mod(n\,4))',setpts=N/30/TB,setsar=1" -r 30 \
     -c:v libx264 -crf 8 -preset slow -pix_fmt yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709 "$OUT/$name-30fps.mp4"
  echo "file '$name-30fps.mp4'" >>"$LIST"
done
ff -f concat -safe 0 -i "$LIST" -c copy "$OUT/bench-30fps.mp4"
echo "bench-30fps.mp4: $(ffprobe -v error -count_frames -select_streams v -show_entries stream=nb_read_frames -of csv=p=0 "$OUT/bench-30fps.mp4") frames"
