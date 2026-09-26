#!/usr/bin/env bash
#
# Scores a whole EXPORT of the benchmark post - generate.sh's bench-30fps.mp4 as one clip, inMs 0 to
# outMs 6000, slowed to SPEED and exported at 30 fps (the spec in web-export.harness.ts) - frame by
# frame, in LUMA: the codec's 4:2:0 chroma cannot carry the scenes' saturated colour noise, so an RGB
# score of an export would measure the codec rather than the engine.
#
# Output frame k is shown at k/30 s and samples the source at k*SPEED/30 s, which is frame
# N = 4*k*SPEED of the six 120 fps scenes end to end: scene floor(N/120) (panzoom objects whip static
# cut flash) and its frame n = N mod 120. n mod 4 == 0 is a RECORDED frame, one the engine only has to
# carry through, and the rest are INVENTED. Frames past n = 115 are left out: the ones after a scene's
# last recorded frame are invented across the join into the next scene, where no truth exists
# (score.sh's LAST). Per scene and kind: PSNR from the MEAN squared error over the frames (ffmpeg's
# "average") and the worst single frame. The recorded frames' score is the ceiling the decoder and
# the encoder leave, whatever the interpolation.
#
#   truth BENCH_DIR EXPORT.mp4 SPEED  each frame against the frame that really was there,
#                                     BENCH_DIR/<scene>/fNNN.png, turned into luma the way the
#                                     recording was (see `recorded_matrix`).
#   pair A.mp4 B.mp4 SPEED            each frame of one export against the same frame of another
#                                     (iOS against web): how far two engines agree on one post.
#
# An export must hold exactly 180/SPEED frames (360 at 0.5x, 720 at 0.25x), 8-bit 4:2:0, at k/30 s
# from its first one; anything else stops the script, since a frame out of place would be scored
# against the wrong truth. 4*SPEED must be whole (0.25, 0.5, 0.75): other speeds land between the
# 120 fps frames. FRAMES_CSV=path also writes every frame's score (k,scene,n,kind,mse_y,psnr_y).
# Prints a Markdown table.

set -euo pipefail

usage() {
  echo "usage: score-export.sh truth BENCH_DIR EXPORT.mp4 SPEED" >&2
  echo "       score-export.sh pair A.mp4 B.mp4 SPEED" >&2
  exit 2
}
die() { echo "score-export.sh: $*" >&2; exit 1; }

MODE=${1:-}
[[ $MODE == truth || $MODE == pair ]] || usage
[[ $# -eq 4 ]] || usage
SPEED=$4
SCENES=(panzoom objects whip static cut flash)
LAST=115
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

FRAMES=$(awk -v s="$SPEED" 'BEGIN { if (s + 0 <= 0) exit 1; k = 180 / s; if (k != int(k)) exit 1; print k }') ||
  die "speed $SPEED does not give a whole number of frames"

# ffmpeg runs from inside $TMP so its stats file can be named without a path: a path inside a
# filtergraph is not converted by Git Bash on Windows, and a drive letter's colon would need escaping.
# Its inputs are therefore made absolute first.
absolute() { case $1 in /* | [A-Za-z]:*) echo "$1" ;; *) echo "$PWD/$1" ;; esac; }

# stream FILE FIELD: one field of the file's video stream.
stream() { ffprobe -v error -select_streams v:0 -show_entries "stream=$2" -of csv=p=0 "$1" | head -1; }

# check EXPORT: the frame count, the pixel format, and every frame at k/30 s from the first one.
check() {
  local file=$1 fmt
  [[ -f $file ]] || die "$file: no such file"
  fmt=$(stream "$file" pix_fmt)
  [[ $fmt == yuv420p || $fmt == yuvj420p ]] || die "$file: $fmt, expected 8-bit 4:2:0"
  ffprobe -v error -select_streams v:0 -show_entries frame=best_effort_timestamp_time -of csv=p=0 "$file" |
    awk -F, -v want="$FRAMES" -v file="$file" '
      $1 != "" { t[n++] = $1 }
      END {
        if (n != want) {
          printf "score-export.sh: %s: %d frames, expected %d\n", file, n, want > "/dev/stderr"
          exit 1
        }
        for (k = 0; k < n; k++) {
          off = t[k] - t[0] - k / 30
          if (off > 0.25 / 30 || off < -0.25 / 30) {
            printf "score-export.sh: %s: frame %d at %.6f s, expected %.6f s\n", file, k, t[k] - t[0], k / 30 > "/dev/stderr"
            exit 1
          }
        }
      }' || exit 1
}

# recorded_matrix BENCH_DIR: the matrix the recording's encoder REALLY turned the scenes into YUV
# with, whatever its tag says. generate.sh labels bench-30fps.mp4 BT.709 with `-colorspace bt709`,
# which is only a label: an ffmpeg whose scaler does not follow it (6.0 does not) converts with
# BT.601 all the same. An engine decodes and encodes with one matrix, the tagged one, so its export
# carries the recording's luma through, and the truth has to be turned into luma the way the
# recording was, or every frame, recorded ones included, is marked down for colour alone. The
# recording's first frame is scored against panzoom/f000.png both ways, and the matrix that agrees
# (above 40 dB) is the one. SCORE_MATRIX (bt601, bt709) overrides it.
recorded_matrix() {
  local recording=$1/bench-30fps.mp4 matrix scores=()
  [[ -f $recording ]] || die "$recording: no such file"
  for matrix in bt601 bt709; do
    scores+=("$(ffmpeg -hide_banner -nostats -i "$recording" -i "$1/panzoom/f000.png" -lavfi \
      "[0:v]trim=end_frame=1,settb=1/30,setpts=N,format=yuv420p[r];[1:v]settb=1/30,setpts=N,scale=out_color_matrix=$matrix:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p[t];[r][t]psnr=shortest=1" \
      -f null - 2>&1 | sed -nE 's/.*PSNR y:([0-9.]+|inf) .*/\1/p' | sed 's/inf/999/')")
  done
  awk -v a="${scores[0]}" -v b="${scores[1]}" 'BEGIN {
    if (a + 0 < 40 && b + 0 < 40) exit 1
    print (a + 0 > b + 0 ? "bt601" : "bt709")
  }' || die "$recording: its first frame is not panzoom/f000.png in either matrix (${scores[*]} dB)"
}

# What each output frame stands for, "k scene n kind": kind R (recorded), I (invented), - (no truth).
awk -v s="$SPEED" -v frames="$FRAMES" -v last=$LAST 'BEGIN {
  for (k = 0; k < frames; k++) {
    N = 4 * k * s
    r = int(N + 0.5)
    if (N - r > 1e-9 || r - N > 1e-9) {
      printf "score-export.sh: output frame %d is 120 fps frame %.4f, not a whole frame\n", k, N > "/dev/stderr"
      exit 1
    }
    n = r % 120
    print k, int(r / 120), n, (n > last ? "-" : (n % 4 == 0 ? "R" : "I"))
  }
}' >"$TMP/frames.txt" || exit 1

# Both inputs of the psnr filter are re-timed to frame k at exactly k in a 1/30 time base, so it
# pairs frame k with frame k and nothing else - `check` has proved the export's frames ARE at k/30.
# `setpts=N/30/TB` alone is not enough: the concat demuxer's PNGs come in a 1/25 time base, where
# k/30 rounds two frames onto one tick and the filter then pairs frames out of step. `shortest` ends
# the scoring with the shorter input instead of repeating its last frame, so the count below sees it.
if [[ $MODE == truth ]]; then
  BENCH=$(absolute "$2") EXPORT=$(absolute "$3")
  check "$EXPORT"
  FMT=$(stream "$EXPORT" pix_fmt)
  MATRIX=${SCORE_MATRIX:-$(recorded_matrix "$BENCH")}
  RANGE=$([[ $(stream "$EXPORT" color_range) == pc || $FMT == yuvj420p ]] && echo pc || echo tv)
  while read -r k scene n kind; do
    png=$BENCH/${SCENES[scene]}/$(printf 'f%03d.png' "$n")
    [[ -f $png ]] || die "$png: no such file"
    printf "file '%s'\n" "$png"
  done <"$TMP/frames.txt" >"$TMP/truth.txt"
  (cd "$TMP" && ffmpeg -hide_banner -nostats -loglevel error -i "$EXPORT" -f concat -safe 0 -i truth.txt -lavfi \
    "[0:v]settb=1/30,setpts=N[m];[1:v]settb=1/30,setpts=N,scale=out_color_matrix=$MATRIX:out_range=$RANGE:flags=accurate_rnd+full_chroma_int,format=$FMT[t];[m][t]psnr=shortest=1:stats_file=stats.log" \
    -f null -) || die "ffmpeg failed"
  TITLE="$(basename "$EXPORT") against the truth, ${SPEED}x, luma (truth made with $MATRIX, $RANGE range)"
else
  A=$(absolute "$2") B=$(absolute "$3")
  check "$A"
  check "$B"
  FMT=$(stream "$A" pix_fmt)
  [[ $(stream "$A" color_space) == "$(stream "$B" color_space)" ]] ||
    echo "score-export.sh: the exports are tagged with different matrices; their luma differs for that alone" >&2
  (cd "$TMP" && ffmpeg -hide_banner -nostats -loglevel error -i "$A" -i "$B" -lavfi \
    "[0:v]settb=1/30,setpts=N[a];[1:v]settb=1/30,setpts=N,scale=out_range=$([[ $FMT == yuvj420p ]] && echo pc || echo tv),format=$FMT[b];[a][b]psnr=shortest=1:stats_file=stats.log" \
    -f null -) || die "ffmpeg failed"
  TITLE="$(basename "$A") against $(basename "$B"), ${SPEED}x, luma"
fi

# Joins the psnr filter's per-frame mse_y (line k+1 of its stats file is output frame k) to the
# kinds, and adds up per scene: PSNR = 10 log10(255^2 / mean mse), inf where the frames are identical.
awk -v title="$TITLE" -v frames="$FRAMES" -v csv="${FRAMES_CSV:-}" -v names="${SCENES[*]}" '
  function db(mse) { return mse == 0 ? "inf" : sprintf("%.2f", 10 * log(65025 / mse) / log(10)) }
  BEGIN { split(names, sc, " "); for (i = 1; i <= 6; i++) sc[i - 1] = sc[i] }
  NR == FNR { scene[$1] = $2; n[$1] = $3; kind[$1] = $4; next }
  {
    k = FNR - 1
    if (!match($0, /mse_y:[0-9.]+/)) { print "score-export.sh: unreadable stats line " FNR > "/dev/stderr"; exit 1 }
    mse = substr($0, RSTART + 6, RLENGTH - 6) + 0
    lines++
    if (csv != "") printf "%d,%s,%d,%s,%.2f,%s\n", k, sc[scene[k]], n[k], kind[k], mse, db(mse) > csv
    if (kind[k] == "-") next
    key = scene[k] SUBSEP kind[k]
    sum[key] += mse
    count[key]++
    if (mse > worst[key]) worst[key] = mse
  }
  END {
    if (lines != frames) {
      printf "score-export.sh: psnr scored %d frames, expected %d\n", lines, frames > "/dev/stderr"
      exit 1
    }
    printf "%s\n\n", title
    print "| scene | invented PSNR | invented worst | recorded PSNR | recorded worst | frames (inv/rec) |"
    print "|---|---:|---:|---:|---:|---:|"
    for (s = 0; s < 6; s++) {
      i = s SUBSEP "I"
      r = s SUBSEP "R"
      printf "| %s | %s | %s | %s | %s | %d/%d |\n", sc[s], \
        db(sum[i] / count[i]), db(worst[i]), db(sum[r] / count[r]), db(worst[r]), count[i], count[r]
    }
  }' "$TMP/frames.txt" "$TMP/stats.log"
