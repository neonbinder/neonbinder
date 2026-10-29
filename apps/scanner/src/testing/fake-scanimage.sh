#!/bin/bash
# A stand-in for SANE's scanimage, for feedCards tests. $FAKE_DIR/paper is the
# hopper sensor; $FAKE_SCENARIO picks what a scan does.
for arg in "$@"; do
  case "$arg" in
    -A) [ -e "$FAKE_DIR/paper" ] && s=yes || s=no; echo "    --page-loaded[=(yes|no)] [$s] [hardware]"; exit 0 ;;
    -f) echo "fujitsu:fake"; exit 0 ;;
    --batch=*) pattern="${arg#--batch=}" ;;
  esac
done
echo "$*" >> "$FAKE_DIR/calls"
page() { printf "side-%s" "$1" > "$(printf "$pattern" "$1")"; }
case "$FAKE_SCENARIO" in
  pairs:*)
    n="${FAKE_SCENARIO#pairs:}"
    for ((i = 1; i <= n; i++)); do page "$i"; sleep 0.05; done
    rm -f "$FAKE_DIR/paper"
    echo "scanimage: sane_start: Document feeder out of documents" >&2
    ;;
  stall)
    # Like scanimage: a cancel deletes the page it was writing.
    trap 'rm -f "$(printf "$pattern" 2).part"; exit 0' INT
    page 1
    head -c 5000 /dev/zero > "$(printf "$pattern" 2).part"
    rm -f "$FAKE_DIR/paper"
    while true; do sleep 0.05; done
    ;;
  jam)
    echo "scanimage: sane_start: Document feeder jammed" >&2
    exit 1
    ;;
esac
