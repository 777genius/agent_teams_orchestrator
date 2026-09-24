#!/bin/sh
set -eu

if [ "$(uname -s)" != Linux ] || [ "$#" -ne 1 ]; then
  echo 'usage: build.sh /absolute/output/path (Linux only)' >&2
  exit 2
fi
case "$1" in /*) ;; *) echo 'absolute output path required' >&2; exit 2 ;; esac

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cc -std=c11 -O2 -Wall -Wextra -Werror -fstack-protector-strong -D_FORTIFY_SOURCE=2 \
  -static -o "$1" "$script_dir/bootstrap.c"
