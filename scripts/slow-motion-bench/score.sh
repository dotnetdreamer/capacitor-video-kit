#!/usr/bin/env bash
#
# Scores the missing frames an engine drew against the frames that really were there: ffmpeg's psnr
# and ssim filters over the IN-BETWEEN frames only, per scene, per method, per speed.
#
#   0.5x   the frame halfway between each recorded pair: 120 fps frames 2, 6, 10, ...
#   0.25x  the three between each pair: every frame that is not a recorded one.
#
# Usage: score.sh BENCH_DIR OUT_DIR [METHODS...]       (default methods: blend flow)
#
# BENCH_DIR is what generate.sh wrote (the truth, BENCH_DIR/<scene>/fNNN.png); OUT_DIR is what the
# harness wrote (OUT_DIR/<method>/<scene>/fNNN.png). Prints a Markdown table: PSNR is ffmpeg's
# "average" (from the mean squared error over the frames) and its worst frame, SSIM is "All".

set -euo pipefail

BENCH=${1:?usage: score.sh BENCH_DIR OUT_DIR [METHODS...]}
OUT=${2:?usage: score.sh BENCH_DIR OUT_DIR [METHODS...]}
shift 2
METHODS=("$@")
[[ ${#METHODS[@]} -eq 0 ]] && METHODS=(blend flow)
SCENES=(${SCENES:-panzoom objects whip static cut flash})
LAST=115
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# list FILE DIR SPEED: the concat list of the in-between frames a speed makes.
list() {
  local file=$1 dir=$2 speed=$3
  : >"$file"
  for ((n = 1; n <= LAST; n++)); do
    ((n % 4 == 0)) && continue
    [[ $speed == 0.5 ]] && ((n % 4 != 2)) && continue
    printf "file '%s/f%03d.png'\n" "$dir" "$n" >>"$file"
  done
}

metric() { # metric FILTER TRUTH_LIST MADE_LIST -> the summary line
  ffmpeg -hide_banner -nostats -f concat -safe 0 -i "$2" -f concat -safe 0 -i "$3" \
    -lavfi "[0:v]format=yuv444p[t];[1:v]format=yuv444p[m];[t][m]$1" -f null - 2>&1 | grep -E "Parsed_$1" | tail -1
}

printf '| scene | speed | method | PSNR avg (dB) | PSNR worst | SSIM |\n|---|---|---|---|---|---|\n'
for scene in "${SCENES[@]}"; do
  for speed in 0.5 0.25; do
    list "$TMP/truth.txt" "$BENCH/$scene" $speed
    for method in "${METHODS[@]}"; do
      [[ -d $OUT/$method/$scene ]] || continue
      list "$TMP/made.txt" "$OUT/$method/$scene" $speed
      psnr=$(metric psnr "$TMP/truth.txt" "$TMP/made.txt")
      ssim=$(metric ssim "$TMP/truth.txt" "$TMP/made.txt")
      avg=$(sed -E 's/.*average:([0-9.inf]+).*/\1/' <<<"$psnr")
      worst=$(sed -E 's/.*min:([0-9.inf]+).*/\1/' <<<"$psnr")
      all=$(sed -E 's/.*All:([0-9.]+).*/\1/' <<<"$ssim")
      printf '| %s | %sx | %s | %s | %s | %s |\n' "$scene" "$speed" "$method" "$avg" "$worst" "$all"
    done
  done
done
