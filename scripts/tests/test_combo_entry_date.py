import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent.parent))

import ib_sync


class TestComboEntryDateResolution(unittest.TestCase):
    def test_multi_leg_option_position_uses_contract_specific_blotter_dates(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            data_dir = Path(tmpdir)
            portfolio_path = data_dir / "portfolio.json"
            portfolio_path.write_text(json.dumps({"positions": []}))
            (data_dir / "trade_log.json").write_text(json.dumps({"trades": []}))
            (data_dir / "blotter.json").write_text(
                json.dumps(
                    {
                        "open_trades": [
                            {
                                "symbol": "PLTR  260327C00155000",
                                "sec_type": "OPT",
                                "executions": [{"time": "2026-03-24T10:05:00"}],
                            },
                            {
                                "symbol": "PLTR  260327P00152500",
                                "sec_type": "OPT",
                                "executions": [{"time": "2026-03-24T10:05:01"}],
                            },
                            {
                                "symbol": "PLTR  260327C00145000",
                                "sec_type": "OPT",
                                "executions": [{"time": "2026-03-19T15:52:25"}],
                            },
                        ]
                    }
                )
            )

            collapsed_positions = [
                {
                    "id": 16,
                    "ticker": "PLTR",
                    "structure": "Risk Reversal (P$152.5/C$155.0)",
                    "structure_type": "Risk Reversal",
                    "risk_profile": "undefined",
                    "expiry": "2026-03-27",
                    "contracts": 20,
                    "direction": "COMBO",
                    "entry_cost": -1571.92,
                    "max_risk": None,
                    "market_value": -1760.0,
                    "market_price_is_calculated": False,
                    "ib_daily_pnl": None,
                    "legs": [
                        {
                            "direction": "LONG",
                            "contracts": 20,
                            "type": "Call",
                            "strike": 155.0,
                            "entry_cost": 5034.01,
                            "avg_cost": 251.70045,
                            "market_price": 2.48,
                            "market_value": 4960.0,
                            "market_price_is_calculated": False,
                        },
                        {
                            "direction": "SHORT",
                            "contracts": 20,
                            "type": "Put",
                            "strike": 152.5,
                            "entry_cost": 6605.93,
                            "avg_cost": 330.29626,
                            "market_price": 3.36,
                            "market_value": 6720.0,
                            "market_price_is_calculated": False,
                        },
                    ],
                    "kelly_optimal": None,
                    "target": None,
                    "stop": None,
                }
            ]

            with patch.object(ib_sync, "PORTFOLIO_PATH", portfolio_path):
                result = ib_sync.convert_to_portfolio_format(
                    {"NetLiquidation": 1_000_000},
                    collapsed_positions,
                    {},
                )

            self.assertEqual(result["positions"][0]["entry_date"], "2026-03-24")


if __name__ == "__main__":
    unittest.main()
