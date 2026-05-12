#!/bin/sh
NODE_BIN="/Users/yusufmarwat/.vscode/extensions/vscjava.migrate-java-to-azure-1.7.6-darwin-arm64/out/nodejs/bin"
export PATH="$NODE_BIN:$PATH"
cd /Users/yusufmarwat/venuerise
exec "$NODE_BIN/node" node_modules/.bin/next dev -p 3100
