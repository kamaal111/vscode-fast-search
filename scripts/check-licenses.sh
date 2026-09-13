#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
generated=$(mktemp "${TMPDIR:-/tmp}/fast-search-notices.XXXXXX")
trap 'rm -f "$generated"' EXIT HUP INT TERM

cd "$project_dir"
cargo deny --manifest-path native/Cargo.toml check licenses
cargo about generate \
  --manifest-path native/Cargo.toml \
  --workspace \
  --locked \
  --fail \
  --output-file "$generated" \
  about.hbs
diff -u THIRD_PARTY_NOTICES.md "$generated"
