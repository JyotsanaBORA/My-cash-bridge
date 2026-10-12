"use strict";

module.exports = {
  apps: [
    {
      name: "mycashbridge",
      script: "server.js",
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "400M",
      restart_delay: 4000,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
