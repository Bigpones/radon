#!/usr/bin/env python3
"""
IB Order Placement — JSON-in / JSON-out for web API.

Places a limit order via IB, waits briefly for acknowledgement, returns JSON.
Does NOT monitor fills or log trades (web layer handles that).

Usage:
  python3 scripts/ib_place_order.py --json '{"type":"stock","symbol":"AAPL","action":"BUY","quantity":100,"limitPrice":214.50,"tif":"DAY"}'
  python3 scripts/ib_place_order.py --json '{"type":"option","symbol":"GOOG","action":"BUY","quantity":10,"limitPrice":9.00,"tif":"GTC","expiry":"20260417","strike":315,"right":"C"}'
"""

import json
import sys
import time
from pathlib import Path

try:
    from ib_insync import Stock, Option, Future, Contract, ComboLeg, LimitOrder, MarketOrder, TagValue, util
except ImportError:
    print(json.dumps({"status": "error", "message": "ib_insync not installed"}))
    sys.exit(1)

# Add project root + scripts dir to path
PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(Path(__file__).parent))

from clients.ib_client import IBClient, CLIENT_IDS, DEFAULT_HOST, DEFAULT_GATEWAY_PORT

CLIENT_ID = CLIENT_IDS.get("ib_place_order", 26)
PORT = DEFAULT_GATEWAY_PORT


def place_order(params: dict) -> dict:
    """Place a limit order and return result as dict."""
    order_type = params.get("type", "stock")
    symbol = params["symbol"].upper()
    action = params["action"].upper()
    quantity = int(params["quantity"])
    limit_price = float(params["limitPrice"])
    tif = params.get("tif", "DAY").upper()

    client = IBClient()

    try:
        client.connect(host=DEFAULT_HOST, port=PORT, client_id="auto", timeout=10)
    except Exception as e:
        return {"status": "error", "message": f"Connection failed: {e}"}

    try:
        # Build contract
        if order_type == "combo":
            legs_data = params["legs"]
            options = []
            for leg in legs_data:
                opt = Option(
                    symbol=symbol,
                    lastTradeDateOrContractMonth=leg["expiry"],
                    strike=float(leg["strike"]),
                    right=leg["right"],
                    exchange="SMART",
                    currency="USD",
                )
                options.append(opt)

            qualified = client.qualify_contracts(*options)
            if len(qualified) != len(options):
                return {"status": "error", "message": f"Could not qualify all combo legs for {symbol}"}

            combo = Contract()
            combo.symbol = symbol
            combo.secType = "BAG"
            combo.currency = "USD"
            combo.exchange = "SMART"

            combo_legs = []
            for i, leg in enumerate(legs_data):
                cl = ComboLeg()
                cl.conId = qualified[i].conId
                cl.ratio = int(leg.get("ratio", 1))
                cl.action = leg["action"].upper()
                cl.exchange = "SMART"
                combo_legs.append(cl)

            combo.comboLegs = combo_legs
            contract = combo

        elif order_type == "option":
            # Equity options route to SMART; index options (VIX/SPX/...)
            # need explicit CBOE + tradingClass via the resolver so IB
            # doesn't pick up VIXW weeklies or other related roots.
            from clients.contract_resolver import resolve_option_contract
            expiry = params["expiry"]
            strike = float(params["strike"])
            right = params["right"]
            con_id = params.get("conId")
            if con_id:
                # Caller passed the chain-resolved conId — use it directly
                # to skip qualification ambiguity.
                contract = Contract()
                contract.conId = int(con_id)
                contract.exchange = params.get("exchange", "SMART")
                contract.currency = "USD"
            else:
                contract = resolve_option_contract(symbol, expiry, strike, right)
            qualified = client.qualify_contracts(contract)
            if not qualified:
                return {"status": "error", "message": f"Could not qualify contract: {symbol}"}
            contract = qualified[0]

        elif order_type == "future":
            # VIX futures + other CFE-listed contracts. Caller can pass
            # `conId` directly (preferred — disambiguates among multiple
            # listings) OR `expiry` (YYYYMM or YYYYMMDD). The chain
            # endpoint at /futures/chain hands the conId back.
            from clients.contract_resolver import resolve_future_contract
            con_id = params.get("conId")
            expiry = params.get("expiry") or ""
            if con_id:
                contract = Contract()
                contract.conId = int(con_id)
                contract.exchange = params.get("exchange", "CFE")
                contract.currency = "USD"
            else:
                if not expiry:
                    return {"status": "error", "message": "future order requires conId or expiry"}
                contract = resolve_future_contract(symbol, expiry)
            qualified = client.qualify_contracts(contract)
            if not qualified:
                return {"status": "error", "message": f"Could not qualify future: {symbol} {expiry or con_id}"}
            contract = qualified[0]

        else:
            contract = Stock(symbol, "SMART", "USD")
            qualified = client.qualify_contracts(contract)
            if not qualified:
                return {"status": "error", "message": f"Could not qualify contract: {symbol}"}
            contract = qualified[0]

        # Capture IB error events so we can detect silent rejections
        ib_errors: list = []

        def _on_error(reqId, errorCode, errorString, contract=None):
            # Ignore informational codes
            if errorCode not in (2104, 2106, 2108, 2158, 10358):
                ib_errors.append((errorCode, errorString))

        client._ib.errorEvent += _on_error

        # Build order
        order = LimitOrder(
            action=action,
            totalQuantity=quantity,
            lmtPrice=limit_price,
            tif=tif,
            outsideRth=False,
        )

        if order_type == "combo":
            order.smartComboRoutingParams = [TagValue("NonGuaranteed", "1")]
            # Progress to stderr — stdout is reserved for the final JSON
            # result. The list-literal in the format string used to land on
            # stdout, where the subprocess wrapper's `_find_json_start` saw
            # the `[1, 1]` ratios as the JSON document and tripped on the
            # real result as "Extra data: line 2 column 1 (char 7)" (the
            # EWY bearish risk reversal bug, 2026-05-27).
            print(
                f"  Combo order: {len(legs_data)} legs, NonGuaranteed=1, "
                f"ratios={[int(l.get('ratio', 1)) for l in legs_data]}",
                file=sys.stderr,
            )

        # Place
        trade = client.place_order(contract, order)

        # Poll trade.orderStatus until IB issues a permId OR the status moves
        # past PendingSubmit/ApiPending. Without this wait, `finally:
        # client.disconnect()` runs while the order is still in PendingSubmit;
        # IB then drops the order because the placing client went away before
        # acknowledging.  The 2026-05-27 MU risk-reversal repro returned
        # `{status:"ok", permId:0, initialStatus:"PendingSubmit"}` and the
        # subsequent /orders sync found nothing — because IB had silently
        # discarded the unconfirmed order on disconnect.
        #
        # Terminal-or-confirmed predicate:
        #   perm_id != 0                      → IB assigned the permanent id
        #   status in {Submitted, PreSubmitted, Filled, Cancelled,
        #              Inactive, ApiCancelled, Rejected}
        #       → IB has fully processed; whatever the verdict, it's not in
        #         limbo.  PendingSubmit / ApiPending / Unknown are the
        #         "still in limbo" cases and we keep waiting on those.
        #
        # Combos get the longer deadline because IB risk-checks each leg
        # independently AND the SmartRouting + NonGuaranteed handshake adds
        # ~3-5s on top of single-leg latency.
        deadline = time.time() + (12.0 if order_type == "combo" else 6.0)
        terminal_states = {
            "Submitted",
            "PreSubmitted",
            "Filled",
            "Cancelled",
            "ApiCancelled",
            "Inactive",
            "Rejected",
        }
        while time.time() < deadline:
            client.sleep(0.5)
            if trade.order.permId != 0:
                break
            s = trade.orderStatus.status if trade.orderStatus else ""
            if s in terminal_states:
                break
            if ib_errors:
                break

        order_id = trade.order.orderId
        perm_id = trade.order.permId
        status = trade.orderStatus.status if trade.orderStatus else "Unknown"

        # Surface any IB error events caught during the wait
        if ib_errors:
            code, msg = ib_errors[0]
            return {
                "status": "error",
                "message": f"IB error {code}: {msg}",
                "orderId": order_id,
                "permId": perm_id,
                "initialStatus": status,
            }

        # Refuse to claim success if IB hasn't actually accepted the order.
        # PendingSubmit + permId=0 after the polling deadline means IB
        # never confirmed; disconnecting now would drop the order. Surface
        # a clear error so the UI doesn't show a misleading green toast.
        if perm_id == 0 and status in ("PendingSubmit", "ApiPending", "Unknown", ""):
            hint = (
                "IB never confirmed the order. Common causes: market is "
                "closed and TIF=DAY (use GTC for after-hours), insufficient "
                "trading permissions for this structure (Tier 4 for naked "
                "shorts), or pre-trade risk rejection. Check IB Gateway logs."
            )
            return {
                "status": "error",
                "message": f"Order stuck in {status or 'Unknown'} (no permId). {hint}",
                "orderId": order_id,
                "permId": perm_id,
                "initialStatus": status,
            }

        # Terminal-but-failed states. If IB rejected or cancelled the order
        # in the wait window, surface that as an error — the UI shouldn't
        # show "Order placed" for a rejected order even when status comes
        # without an explicit errorEvent.
        if status in ("Rejected", "Cancelled", "ApiCancelled", "Inactive"):
            why = ""
            if trade.orderStatus is not None:
                # `whyHeld` / `lastFillPrice` may carry IB's reason text on
                # some rejections; surface whatever's there.
                wh = getattr(trade.orderStatus, "whyHeld", None)
                if wh:
                    why = f" ({wh})"
            return {
                "status": "error",
                "message": f"Order {status}{why}",
                "orderId": order_id,
                "permId": perm_id,
                "initialStatus": status,
            }

        return {
            "status": "ok",
            "orderId": order_id,
            "permId": perm_id,
            "initialStatus": status,
            "message": f"{action} {quantity} {symbol} @ ${limit_price:.2f} — {status}",
        }

    except Exception as e:
        return {"status": "error", "message": str(e)}

    finally:
        client.disconnect()


def main():
    if "--json" not in sys.argv:
        print(json.dumps({"status": "error", "message": "Usage: --json '{...}'"}))
        sys.exit(1)

    json_idx = sys.argv.index("--json")
    if json_idx + 1 >= len(sys.argv):
        print(json.dumps({"status": "error", "message": "Missing JSON argument after --json"}))
        sys.exit(1)

    try:
        params = json.loads(sys.argv[json_idx + 1])
    except json.JSONDecodeError as e:
        print(json.dumps({"status": "error", "message": f"Invalid JSON: {e}"}))
        sys.exit(1)

    # Validate required fields
    required = ["symbol", "action", "quantity", "limitPrice"]
    missing = [f for f in required if f not in params]
    if missing:
        print(json.dumps({"status": "error", "message": f"Missing fields: {', '.join(missing)}"}))
        sys.exit(1)

    if params.get("type") == "option":
        opt_required = ["expiry", "strike", "right"]
        opt_missing = [f for f in opt_required if f not in params]
        if opt_missing:
            print(json.dumps({"status": "error", "message": f"Option missing: {', '.join(opt_missing)}"}))
            sys.exit(1)

    if params.get("type") == "combo":
        legs = params.get("legs")
        if not legs or not isinstance(legs, list) or len(legs) < 2:
            print(json.dumps({"status": "error", "message": "Combo requires 'legs' array with 2+ entries"}))
            sys.exit(1)
        leg_required = ["expiry", "strike", "right", "action"]
        for i, leg in enumerate(legs):
            leg_missing = [f for f in leg_required if f not in leg]
            if leg_missing:
                print(json.dumps({"status": "error", "message": f"Leg {i} missing: {', '.join(leg_missing)}"}))
                sys.exit(1)

    result = place_order(params)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
