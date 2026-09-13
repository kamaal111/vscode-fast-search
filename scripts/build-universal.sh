#!/bin/sh
set -eu
cargo build --manifest-path native/Cargo.toml --release -p fast-search-engine --target aarch64-apple-darwin
cargo build --manifest-path native/Cargo.toml --release -p fast-search-engine --target x86_64-apple-darwin
mkdir -p bin
lipo -create native/target/aarch64-apple-darwin/release/fast-search-engine native/target/x86_64-apple-darwin/release/fast-search-engine -output bin/fast-search-engine
node scripts/build-extension.mjs
