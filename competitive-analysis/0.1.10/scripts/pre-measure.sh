#!/usr/bin/env bash
# pre-measure.sh
#
# Read a manifest JSON, measure every image's native dimensions via `identify`,
# and emit a new manifest JSON with display width/height filled in.
#
# Rules:
#   - Display width = min(COL_WIDTH, native_width) — NEVER upscale. A ~390px-wide
#     mobile capture stays ~390px (crisp), a 1440px desktop page downscales to 720.
#   - A screen that is too heavy (> SIZE_LIMIT) OR too tall (> MAX_PIECE_PX native)
#     for a single Figma image fill is SLICED into vertical pieces. The pieces are
#     emitted under an image's `pieces` array (each {path,width,height}); the renderer
#     stitches them back into ONE seamless frame. The image keeps ONE clean label —
#     it is still one screen, just delivered in slices.
#   - Byte-identical images (same MD5) are de-duplicated: the first wins, later copies
#     are dropped with a warning. Each frame must be a distinct screen.
#
# Usage:
#   pre-measure.sh < raw-manifest.json > measured-manifest.json
#
# Requires: jq, ImageMagick (identify, magick)

set -euo pipefail

# display column width — must match competitor-block-renderer SCHEMA.COL_WIDTH
COL_WIDTH=720
SIZE_LIMIT_BYTES=$((1500 * 1024))   # 1.5 MB — Figma image-fill heft ceiling
MAX_PIECE_PX=4000                    # native px height ceiling for a single fill (avoids blank tall fills)
MAX_SLICES=12

MANIFEST=$(cat)

md5_of() { md5 -q "$1" 2>/dev/null || md5sum "$1" 2>/dev/null | awk '{print $1}'; }

# Slice an image into N vertical pieces at native resolution.
# Echoes one "path<TAB>native_height" line per piece. Caller computes display dims.
slice_image() {
  local path="$1" W="$2" H="$3"
  local dir base
  dir=$(dirname "$path")
  base=$(basename "$path")
  base="${base%.*}"

  local bytes n_by_h n_by_size n
  bytes=$(stat -f%z "$path")
  n_by_h=$(awk -v h="$H" -v m="$MAX_PIECE_PX" 'BEGIN{n=int((h+m-1)/m); print (n<2?2:n)}')
  n_by_size=$(awk -v b="$bytes" -v m="$SIZE_LIMIT_BYTES" 'BEGIN{n=int((b+m-1)/m); print (n<2?2:n)}')
  n=$(( n_by_h > n_by_size ? n_by_h : n_by_size ))

  while true; do
    local pieces=() maxBytes=0 maxH=0
    local sliceH=$((H / n))
    local i off thisH out b
    for ((i=0; i<n; i++)); do
      off=$((i * sliceH))
      thisH=$sliceH
      if [ "$i" -eq $((n-1)) ]; then thisH=$((H - off)); fi
      out="$dir/${base}_p$((i+1)).png"
      magick "$path[0]" -crop "${W}x${thisH}+0+$off" +repage "$out" 2>/dev/null
      pieces+=("$out"$'\t'"$thisH")
      b=$(stat -f%z "$out")
      [ "$b" -gt "$maxBytes" ] && maxBytes=$b
      [ "$thisH" -gt "$maxH" ] && maxH=$thisH
    done
    if [ "$maxBytes" -le "$SIZE_LIMIT_BYTES" ] && [ "$maxH" -le "$MAX_PIECE_PX" ]; then
      printf '%s\n' "${pieces[@]}"
      return 0
    fi
    for p in "${pieces[@]}"; do rm -f "${p%%$'\t'*}"; done
    n=$((n+1))
    if [ "$n" -gt "$MAX_SLICES" ]; then
      echo "ERR: cannot slice $path under limits even at n=$MAX_SLICES" >&2
      return 1
    fi
  done
}

new_manifest=$(echo "$MANIFEST" | jq '.')

# track seen MD5s for dedupe (newline-delimited)
SEEN_MD5=""

col_count=$(echo "$new_manifest" | jq '.columns | length')
for ((c=0; c<col_count; c++)); do
  img_count=$(echo "$new_manifest" | jq ".columns[$c].images | length")
  new_images='[]'
  for ((i=0; i<img_count; i++)); do
    img=$(echo "$new_manifest" | jq ".columns[$c].images[$i]")
    path=$(echo "$img" | jq -r '.path')
    label=$(echo "$img" | jq -r '.label')
    source_url=$(echo "$img" | jq -r '.source_url')

    if [ ! -f "$path" ]; then
      echo "ERR: image not found: $path" >&2
      exit 1
    fi

    # dedupe by content hash — each frame must be a distinct screen
    hash=$(md5_of "$path")
    if printf '%s\n' "$SEEN_MD5" | grep -qx "$hash"; then
      echo "WARN: dropping duplicate (byte-identical) image: $path — '$label'" >&2
      continue
    fi
    SEEN_MD5="${SEEN_MD5}"$'\n'"${hash}"

    W=$(identify -format "%w" "$path[0]")
    H=$(identify -format "%h" "$path[0]")
    bytes=$(stat -f%z "$path")

    # never upscale: display width is the smaller of the column width and the native width
    display_w=$(( COL_WIDTH < W ? COL_WIDTH : W ))

    if [ "$bytes" -le "$SIZE_LIMIT_BYTES" ] && [ "$H" -le "$MAX_PIECE_PX" ]; then
      display_h=$(awk -v w="$display_w" -v iw="$W" -v ih="$H" 'BEGIN{printf("%d", w*ih/iw)}')
      new_img=$(jq -n \
        --arg path "$path" --arg label "$label" --arg source_url "$source_url" \
        --argjson width "$display_w" --argjson height "$display_h" \
        '{path:$path, label:$label, source_url:$source_url, width:$width, height:$height}')
    else
      # slice + emit pieces (renderer stitches them into one frame)
      pieces='[]'
      total_h=0
      while IFS=$'\t' read -r piece_path piece_native_h; do
        [ -z "$piece_path" ] && continue
        ph=$(awk -v w="$display_w" -v iw="$W" -v ih="$piece_native_h" 'BEGIN{printf("%d", w*ih/iw)}')
        total_h=$((total_h + ph))
        pieces=$(echo "$pieces" | jq \
          --arg path "$piece_path" --argjson width "$display_w" --argjson height "$ph" \
          '. + [{path:$path, width:$width, height:$height}]')
      done < <(slice_image "$path" "$W" "$H")
      new_img=$(jq -n \
        --arg label "$label" --arg source_url "$source_url" \
        --argjson width "$display_w" --argjson height "$total_h" --argjson pieces "$pieces" \
        '{label:$label, source_url:$source_url, width:$width, height:$height, pieces:$pieces}')
    fi

    new_images=$(echo "$new_images" | jq --argjson item "$new_img" '. + [$item]')
  done
  new_manifest=$(echo "$new_manifest" | jq --argjson imgs "$new_images" ".columns[$c].images = \$imgs")
done

echo "$new_manifest"
