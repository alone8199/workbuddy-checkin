#!/bin/bash
DELAY=$((RANDOM % 3600))
sleep $DELAY
cd /opt/wb-checkin && node wb-checkin-server.cjs >> /opt/wb-checkin/cron.log 2>&1
