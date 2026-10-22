FROM local/token-monitor-hub:0.69.0-nas-20261013-199be46
COPY --chown=node:node src/hub/server.js /app/src/hub/server.js
COPY --chown=node:node src/shared/hubBuildRegistry.json /app/src/shared/hubBuildRegistry.json
