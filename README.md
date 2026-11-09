# Shop inventory: Postgres + NocoDB

Postgres holds the stock data. NocoDB is the spreadsheet-style admin screen on top of it, and it also gives you a REST API later. Nothing here needs coding.

## 1. Install Docker (once)
- Windows / Mac: install **Docker Desktop**, start it, wait until it says "running".
- Linux: install Docker Engine + the compose plugin.

## 2. Start it
Open a terminal **inside this folder** and run:

    docker compose up -d

First start takes a few minutes (downloads images). Check with `docker compose ps`: both `db` and `nocodb` should be "running".

The database password is in the `.env` file (already generated). To choose your own, edit `DB_PASS` in `.env` **before the first start**. Changing it afterwards does not change the existing database.

## 3. Open the admin UI
Go to http://localhost:8080 and create your admin account (email + password; it stays on your machine).

## 4. Connect NocoDB to the shop database
In NocoDB: create a new base, choose **connect to an external database** (wording varies slightly by version), pick **PostgreSQL** and enter:

| Field | Value |
| --- | --- |
| Host | `db` |
| Port | `5432` |
| Username | `shop` |
| Password | the `DB_PASS` value from `.env` |
| Database | `shop` |
| SSL | off |

Save. You will see these tables: `products`, `variants`, `stock_movements`, and the view `v_stock`.

## 5. Daily use
- **Overview of everything**: open `v_stock`. It shows available = on hand - reserved, and `low_stock` is true when available is at or below the reorder level. Add a filter `low_stock = true` and save it as a view called "Reorder".
- **Add a product**: `products` table, add a row. Then add its sizes/colours in `variants` (one row per size and colour, with a unique `sku` such as `KUR-RED-M`).
- **Restock or correct stock**: edit `on_hand` on the variant row. Every change is logged automatically in `stock_movements` (change amount, new quantity, time).
- **Sold in the shop**: lower `on_hand` by the quantity sold.
- **Hide a product**: untick `active` instead of deleting it.
- Leave `reserved` alone for now; the website and order automation will use it later so two orders cannot take the last piece.
- Delete the 3 sample products once you have added your own (delete the product and its variants go with it).

## 6. Backup (do this weekly, and before any change)
    sh backup.sh
Files land in `./backups`. Copy that folder to Google Drive or a pen drive. To restore into an empty database:

    gunzip -c backups/<file>.sql.gz | docker compose exec -T db psql -U shop shop

## 7. Stop, start, update
- Stop: `docker compose stop`   Start: `docker compose start`
- Update NocoDB: `docker compose pull && docker compose up -d`
- **Wipe everything and start over** (destroys all data): `docker compose down -v`

## Notes
- The admin screen is only reachable from this computer (`127.0.0.1`). Remote access comes later through Cloudflare Tunnel with a login in front. Do not open port 8080 on your router.
- The computer running this must stay on for the system to work.
- Never commit or share `.env`.
