#!/bin/bash
# Double-click to launch the TFX MT-32 player.
# Starts a tiny local web server in this folder and opens it in your browser.
cd "$(dirname "$0")"
PORT=8777
echo "Serving TFX MT-32 player at http://localhost:$PORT/"
echo "Leave this window open while using the player. Close it to stop."
( sleep 1; open "http://localhost:$PORT/" ) &
python3 -m http.server $PORT
                                        