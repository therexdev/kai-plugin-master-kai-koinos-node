#!/bin/sh
set -eu
# Copy into the container so Windows bind-mount execute bits are irrelevant.
# The database mount, command arguments and upstream container stay unchanged.
cp /kai-block-store/koinos_block_store /tmp/kai_koinos_block_store
chmod 755 /tmp/kai_koinos_block_store
exec /tmp/kai_koinos_block_store "$@"
