#!/bin/bash
  if [ ! -f /home/container/dist/index.js ]; then
    git clone https://github.com/yh4544537-creator/discord-bot.git /home/container/tmp_clone
    cp -r /home/container/tmp_clone/dist /home/container/
    cp /home/container/tmp_clone/package.json /home/container/
    rm -rf /home/container/tmp_clone
    cd /home/container && /usr/local/bin/npm install
  fi
  /usr/local/bin/node /home/container/dist/index.js
  