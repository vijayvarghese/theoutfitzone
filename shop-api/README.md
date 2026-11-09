# shop-api

Small Node service in a container. It is the only thing that changes stock and orders; NocoDB, n8n and the website go through it (or read from it).

Runs its own database migrations on start (`migrations/`), so there is no manual SQL step.

## Settings (environment variables, set in docker-compose.yml / .env)
| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (set in compose) |
| `API_KEY` | Secret for all write/admin calls, min 16 chars. Sent as header `X-API-Key` |
| `ORDER_PREFIX` | Order number prefix, default `DS` (gives `DS-2611-00001`) |
| `RESERVATION_MINUTES` | How long an unpaid UPI/CARD order holds stock, default 30 |
| `CORS_ORIGINS` | Optional, comma-separated website origins allowed to call public GET endpoints from a browser |

## Endpoints
Public (no key): customers only ever see `available`, never raw stock.

| Call | Purpose |
| --- | --- |
| `GET /health` | Is it up |
| `GET /api/products?category=&q=` | Active products with variants and availability |
| `GET /api/stock/:sku` | One variant's availability |
| `GET /api/track/:orderNo?phone4=1234` | Order status for the customer; needs last 4 digits of their phone. Rate-limited |

With header `X-API-Key: <your key>` (the same GET calls above then also return `on_hand`, `reserved`, `reorder_level`):

| Call | Purpose |
| --- | --- |
| `POST /api/orders` | Create an order; reserves stock atomically |
| `GET /api/orders?status=&channel=&q=&limit=&offset=` | List orders; `q` matches order no, phone or name |
| `GET /api/orders/:orderNo` | Full order with customer, items, event trail |
| `POST /api/orders/:orderNo/status` | Move to the next status |
| `POST /api/orders/:orderNo/paid` | Mark paid (payment webhook); confirms the order |
| `POST /api/stock/adjust` | Restock or correct: `{"sku":"KUR-RED-M","delta":10,"reason":"new delivery"}` |
| `GET /api/low-stock` | Variants at or below their reorder level |
| `POST /api/admin/expire-reservations` | Cancel overdue unpaid orders (also runs by itself every minute) |

### Create an order
```
curl -X POST http://localhost:3000/api/orders \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "channel": "telegram",
    "customer": {"name":"Asha","phone":"9876543210","tg_chat_id":"123456"},
    "ship_address": "12 Main Road, Town",
    "ship_pincode": "682001",
    "items": [{"sku":"KUR-RED-M","qty":2}],
    "payment_mode": "COD",
    "shipping": 50,
    "reply_to": "123456",
    "idempotency_key": "tg-msg-98765"
  }'
```
Success (`201`): `{"duplicate": false, "order": {"order_no": "DS-2611-00001", "status": "NEW", ...}}`.
Same `idempotency_key` again: `200` with `"duplicate": true` and the original order.
Not enough stock (`409`): `{"error":{"code":"OUT_OF_STOCK","message":"Only 1 left of Cotton Kurti (KUR-RED-M), you asked for 2","details":{...}}}`; nothing is reserved and no order is created.

- `COD` orders start as `NEW` and hold stock until you confirm or cancel.
- `UPI`/`CARD` orders start as `PENDING_PAYMENT` and are cancelled automatically after `RESERVATION_MINUTES` if not paid.
- `channel: "walkin"` records an in-store sale: it is `DELIVERED` and paid at once and takes stock straight off the shelf; customer details are optional.

### Change status
```
curl -X POST http://localhost:3000/api/orders/DS-2611-00001/status \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"status":"SHIPPED","courier":"India Post","awb":"EE123456789IN","note":"handed over"}'
```

```
NEW ─► CONFIRMED ─► PACKED ─► SHIPPED ─► DELIVERED ─► RETURN_REQUESTED ─► RETURNED ─► REFUNDED
 │         │           │         └────────────────────────────────────────────▲
 └─────────┴───────────┴─► CANCELLED                       (SHIPPED ─► RETURNED = undelivered, came back)
PENDING_PAYMENT ─► CONFIRMED | CANCELLED
```

| Move | Stock effect |
| --- | --- |
| order created | `reserved` + qty |
| ► PACKED | `on_hand` - qty and `reserved` - qty |
| ► CANCELLED before packing | `reserved` - qty |
| ► CANCELLED after packing | `on_hand` + qty |
| ► RETURNED | `on_hand` + qty (send `"restock": false` for damaged goods) |
| ► DELIVERED (COD) | payment marked PAID |

Illegal moves return `409 INVALID_TRANSITION` with the list of allowed next statuses. Every change is recorded in `order_events` and every `on_hand` change in `stock_movements` (with the reason and order number).

### Errors
Always JSON: `{"error":{"code":"...","message":"...","details":{...}}}`. Codes you will meet: `UNAUTHORIZED` 401, `BAD_REQUEST` 400, `NOT_FOUND` 404, `UNKNOWN_SKU` / `PRODUCT_INACTIVE` 422, `OUT_OF_STOCK` / `INVALID_TRANSITION` / `BELOW_RESERVED` / `ORDER_CLOSED` 409, `TOO_MANY_REQUESTS` 429.

## Rules to keep stock correct
- Do not edit `reserved` by hand in NocoDB; the API manages it. Changing `on_hand` by hand (restock, correction) is fine, but it cannot go below `reserved`.
- New tables (`orders`, `customers`, `order_items`, `order_events`) appear in NocoDB after you run **Sync metadata** on the data source.
- Orders are inside the same database, so `backup.sh` already covers them.
