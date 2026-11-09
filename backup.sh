#!/bin/sh
# Saves a compressed copy of the whole shop database into ./backups
# Run from this folder:  sh backup.sh
mkdir -p backups
docker compose exec -T db pg_dump -U shop shop | gzip > "backups/shop-$(date +%F-%H%M).sql.gz"
echo "Backup saved in ./backups"
