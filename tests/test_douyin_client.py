import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from douyin_client import (
    merge_composite_bill_days,
    summarize_composite_bill_day,
)


class DouyinCompositeBillTest(unittest.TestCase):
    def test_applies_refunds_as_negative_and_deduplicates_ledgers(self):
        result = summarize_composite_bill_day(
            date(2026, 7, 24),
            [
                {
                    "ledger_id": "income-a",
                    "poi_id": "poi-a",
                    "fund_amount": 1000,
                    "fund_amount_type": 0,
                },
                {
                    "ledger_id": "refund-a",
                    "poi_id": "poi-a",
                    "fund_amount": 200,
                    "fund_amount_type": 1,
                },
                {
                    "ledger_id": "refund-a",
                    "poi_id": "poi-a",
                    "fund_amount": 200,
                    "fund_amount_type": 1,
                },
                {
                    "ledger_id": "income-b",
                    "poi_id": "poi-b",
                    "fund_amount": 500,
                    "fund_amount_type": 0,
                },
            ],
        )

        self.assertEqual(result["settlement"]["record_count"], 3)
        self.assertEqual(result["settlement"]["merchant_due_cents"], 1300)
        self.assertEqual(result["stores"][0]["merchant_due_cents"], 800)
        self.assertEqual(result["stores"][1]["merchant_due_cents"], 500)

    def test_splits_month_into_actual_and_expected_without_extra_fee(self):
        result = merge_composite_bill_days(
            date(2026, 7, 24),
            [
                {
                    "report_date": "2026-07-19",
                    "stores": [
                        {"poi_id": "poi-a", "merchant_due_cents": 800},
                    ],
                },
                {
                    "report_date": "2026-07-20",
                    "stores": [
                        {"poi_id": "poi-a", "merchant_due_cents": 400},
                        {"poi_id": "poi-b", "merchant_due_cents": 500},
                    ],
                },
            ],
            {
                "poi-a": "有花头(古城街店)",
                "poi-b": "有花头(水木店)",
            },
            settlement_days=5,
        )

        settlement = result["settlement"]
        self.assertEqual(settlement["actual_received_cents"], 800)
        self.assertEqual(settlement["expected_received_cents"], 900)
        self.assertEqual(settlement["merchant_due_cents"], 1700)
        self.assertEqual(result["stores"][0]["store"], "有花头(古城街店)")
        self.assertEqual(result["stores"][0]["merchant_due_cents"], 1200)
        self.assertTrue(result["complete"])

    def test_marks_monthly_summary_incomplete_when_dates_are_missing(self):
        result = merge_composite_bill_days(
            date(2026, 7, 24),
            [],
            {},
            [date(2026, 7, 23), date(2026, 7, 24)],
            True,
        )

        self.assertFalse(result["complete"])
        self.assertTrue(result["rate_limited"])
        self.assertEqual(result["missing_dates"], ["2026-07-23", "2026-07-24"])


if __name__ == "__main__":
    unittest.main()
