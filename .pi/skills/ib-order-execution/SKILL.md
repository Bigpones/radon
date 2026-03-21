---
name: ib-order-execution
description: Execute and monitor options orders via Interactive Brokers. Use when placing trades, monitoring fills, or managing orders. Triggers on "execute order", "place trade", "buy calls", "sell puts", "bull call spread", "bear put spread", "monitor fills", "check order status", or any IB order-related task.
---

# IB Order Execution Skill

Execute and monitor orders via Interactive Brokers TWS/Gateway.

## ⚠️ CRITICAL: Always Use Unified Workflow

**When placing ANY order, ALWAYS use the unified `ib_execute.py` script.**

This script automatically:
1. Places the order
2. Monitors for fills (with live updates)
3. Logs filled trades to `trade_log.json`

**NEVER place orders without monitoring and logging.**

---

## Quick Reference

### Sell Stock
```bash
python3.13 scripts/ib_execute.py \
  --type stock \
  --symbol NFLX \
  --qty 4500 \
  --side SELL \
  --limit 98.70 \
  --yes
```

### Buy Stock
```bash
python3.13 scripts/ib_execute.py \
  --type stock \
  --symbol AAPL \
  --qty 100 \
  --side BUY \
  --limit 175.50 \
  --yes
```

### Buy Option (at bid/mid/ask)
```bash
python3.13 scripts/ib_execute.py \
  --type option \
  --symbol GOOG \
  --expiry 20260417 \
  --strike 315 \
  --right C \
  --qty 10 \
  --side BUY \
  --limit MID \
  --yes
```

### Sell Option
```bash
python3.13 scripts/ib_execute.py \
  --type option \
  --symbol GOOG \
  --expiry 20260417 \
  --strike 340 \
  --right C \
  --qty 10 \
  --side SELL \
  --limit 2.50 \
  --yes
```

---

## Full Usage

```bash
python3.13 scripts/ib_execute.py \
  --type stock|option \
  --symbol SYMBOL \
  --qty QUANTITY \
  --side BUY|SELL \
  --limit PRICE|MID|BID|ASK \
  [--expiry YYYYMMDD] \      # Required for options
  [--strike PRICE] \          # Required for options
  [--right C|P] \             # Required for options
  [--timeout SECONDS] \       # Monitor timeout (default: 60)
  [--thesis "..."] \          # Trade thesis for logging
  [--notes "..."] \           # Additional notes
  [--yes] \                   # Skip confirmation
  [--dry-run] \               # Preview without placing
  [--no-log]                  # Don't log to trade_log.json
```

---

## Agent Workflow

When the user asks to place an order:

1. **Parse the request** — Extract symbol, quantity, side, price
2. **Build the command** — Use `ib_execute.py` with appropriate flags
3. **Execute** — Run the script (it handles monitoring + logging automatically)
4. **Report** — Show the fill confirmation to user

**Example agent response pattern:**

```
Placing order: SELL 4500 NFLX @ $98.70...

[runs ib_execute.py]

✅ FILLED
   Symbol: NFLX
   Quantity: 4,500 shares
   Avg Price: $98.70
   Total Value: $444,150.00
   Logged to trade_log.json (ID: 15)
```

---

## Multi-Leg Spreads

For spreads (verticals, iron condors, etc.), use inline Python with combo orders:

```python
from ib_insync import IB, Option, ComboLeg, Contract, LimitOrder
import json
from datetime import datetime
from pathlib import Path

# Connect
ib = IB()
ib.connect('127.0.0.1', 4001, clientId=50)

# Qualify legs
long_call = Option('GOOG', '20260417', 315, 'C', 'SMART', currency='USD')
short_call = Option('GOOG', '20260417', 340, 'C', 'SMART', currency='USD')
ib.qualifyContracts(long_call, short_call)

# Create combo contract
combo = Contract()
combo.symbol = 'GOOG'
combo.secType = 'BAG'
combo.currency = 'USD'
combo.exchange = 'SMART'

leg1 = ComboLeg()
leg1.conId = long_call.conId
leg1.ratio = 1
leg1.action = 'BUY'
leg1.exchange = 'SMART'

leg2 = ComboLeg()
leg2.conId = short_call.conId
leg2.ratio = 1
leg2.action = 'SELL'
leg2.exchange = 'SMART'

combo.comboLegs = [leg1, leg2]

# Place order (positive limit = debit)
order = LimitOrder(action='BUY', totalQuantity=10, lmtPrice=6.50, tif='GTC')
trade = ib.placeOrder(combo, order)
print(f"Order ID: {trade.order.orderId}")

# Monitor for fill
timeout = 60
for i in range(timeout):
    ib.sleep(1)
    if trade.orderStatus.status == 'Filled':
        print(f"FILLED @ ${trade.orderStatus.avgFillPrice}")
        break
    if i % 10 == 0:
        print(f"Working... {trade.orderStatus.status}")

# Log to trade_log.json
if trade.orderStatus.status == 'Filled':
    log_path = Path('data/trade_log.json')
    trade_log = json.loads(log_path.read_text()) if log_path.exists() else {"trades": []}
    next_id = max([t.get('id', 0) for t in trade_log['trades']], default=0) + 1
    
    trade_log['trades'].append({
        "id": next_id,
        "date": datetime.now().strftime("%Y-%m-%d"),
        "time": datetime.now().strftime("%H:%M:%S"),
        "ticker": "GOOG",
        "contract": "GOOG Bull Call Spread $315/$340",
        "structure": "Bull Call Spread",
        "action": "BUY",
        "decision": "EXECUTED",
        "order_id": trade.order.orderId,
        "quantity": int(trade.order.totalQuantity),
        "fill_price": trade.orderStatus.avgFillPrice,
        "total_value": trade.orderStatus.avgFillPrice * trade.order.totalQuantity * 100,
    })
    
    log_path.write_text(json.dumps(trade_log, indent=2))
    print(f"Logged to trade_log.json (ID: {next_id})")

ib.disconnect()
```

---

## Scripts Reference

| Script | Purpose |
|--------|---------|
| `scripts/ib_execute.py` | **PRIMARY** — Place + monitor + log (unified workflow) |
| `scripts/ib_order.py` | Place single-leg options (legacy, requires manual monitoring) |
| `scripts/ib_fill_monitor.py` | Monitor orders for fills (standalone) |
| `scripts/ib_orders.py` | View/sync all open orders |
| `scripts/ib_order_manage.py` | Cancel/modify orders |

---

## Connection Reference

| Port | Environment |
|------|-------------|
| 4001 | IB Gateway Live |
| 4002 | IB Gateway Paper |
| 7496 | TWS Live |
| 7497 | TWS Paper |

| Client ID | Script |
|-----------|--------|
| 0 | ib_order_manage, ib_sync, ib_reconcile (master) |
| 2 | ib_order |
| 11 | ib_orders |
| 25 | ib_execute |
| 52 | ib_fill_monitor |
| 60 | exit_order_service |

---

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Order filled successfully |
| 1 | Error (connection, invalid params, etc.) |
| 2 | Timeout (order still working) |

---

## Troubleshooting

### Connection Failed
- Ensure TWS/Gateway is running
- Check API is enabled: Configure → API → Settings → Enable ActiveX and Socket Clients
- Verify correct port (4001 for Gateway, 7497 for TWS paper)

### Order Rejected
- Check buying power in TWS
- Verify contract is tradeable
- Ensure limit price is reasonable

### Order Not Filling
- Check current bid/ask vs limit price
- Consider adjusting limit closer to market
- Use `--limit MID` for aggressive fills

### Client ID Conflict
- Each script uses different client ID
- If conflict, specify `--client-id N` with unused ID
