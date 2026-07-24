import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from douyin_client import (
    merge_ledger_days,
    summarize_daily_data,
    summarize_ledger_day,
)


class SummarizeDailyDataTest(unittest.TestCase):
    def test_summarizes_paid_verified_settlement_and_live_data(self):
        result = summarize_daily_data(
            date(2026, 7, 23),
            [
                {
                    "order_status": 201,
                    "count": 2,
                    "pay_amount": 1200,
                    "order_sale_info": {"sale_channel": "直播"},
                },
                {
                    "order_status": 101,
                    "count": 1,
                    "pay_amount": 600,
                    "order_sale_info": {"sale_channel": "直播"},
                },
                {
                    "order_status": 1,
                    "count": 1,
                    "pay_amount": 500,
                    "order_sale_info": {"sale_channel": "搜索"},
                },
            ],
            [
                {"status": 1, "amount": {"coupon_pay_amount": 600}},
                {"status": 2, "amount": {"coupon_pay_amount": 700}},
            ],
            [
                {
                    "amount": {"coupon_pay": 600, "goods": 580},
                    "order_attrribute": {"source": "livebroadcasting"},
                },
                {
                    "amount": {"coupon_pay": 500, "goods": 470},
                    "order_attrribute": {"source": "search_result"},
                },
            ],
        )

        self.assertEqual(result["orders"]["submitted_order_count"], 3)
        self.assertEqual(result["orders"]["paid_order_count"], 2)
        self.assertEqual(result["orders"]["paid_coupon_count"], 3)
        self.assertEqual(result["orders"]["sales_amount_cents"], 1700)
        self.assertEqual(result["verification"]["verified_count"], 1)
        self.assertEqual(result["verification"]["verified_amount_cents"], 600)
        self.assertEqual(result["verification"]["verification_rate_percent"], 33.33)
        self.assertEqual(result["settlement"]["estimated_income_cents"], 1050)
        self.assertEqual(result["live"]["paid_order_count"], 1)
        self.assertEqual(result["live"]["paid_coupon_count"], 2)
        self.assertEqual(result["live"]["sales_amount_cents"], 1200)
        self.assertEqual(result["live"]["verified_count"], 1)
        self.assertEqual(result["live"]["estimated_income_cents"], 580)

    def test_zero_paid_coupons_has_no_rate(self):
        result = summarize_daily_data(date(2026, 7, 23), [], [], [])
        self.assertIsNone(result["verification"]["verification_rate_percent"])

    def test_summarizes_ledger_by_store_and_deduplicates_records(self):
        result = summarize_ledger_day(
            date(2026, 7, 23),
            [
                {
                    "ledger_id": "ledger-1",
                    "certificate": {"certificate_id": "coupon-1"},
                    "poi_id": "poi-a",
                    "amount": {"coupon_pay": 1000, "goods": 600},
                },
                {
                    "ledger_id": "ledger-2",
                    "certificate": {"certificate_id": "coupon-1"},
                    "poi_id": "poi-a",
                    "amount": {"coupon_pay": 1000, "goods": 375},
                },
                {
                    "ledger_id": "ledger-2",
                    "certificate": {"certificate_id": "coupon-1"},
                    "poi_id": "poi-a",
                    "amount": {"coupon_pay": 1000, "goods": 375},
                },
                {
                    "ledger_id": "ledger-3",
                    "certificate": {"certificate_id": "coupon-2"},
                    "poi_id": "poi-b",
                    "amount": {"coupon_pay": 500, "goods": 488},
                },
            ],
        )

        self.assertEqual(result["verification"]["verified_count"], 2)
        self.assertEqual(result["verification"]["verified_amount_cents"], 1500)
        self.assertEqual(result["settlement"]["estimated_income_cents"], 1463)
        self.assertEqual(len(result["stores"]), 2)

    def test_merges_daily_ledger_summaries_with_shop_names(self):
        result = merge_ledger_days(
            date(2026, 7, 24),
            [
                {
                    "stores": [
                        {
                            "poi_id": "poi-a",
                            "verified_count": 2,
                            "verified_amount_cents": 1500,
                            "estimated_income_cents": 1463,
                        }
                    ]
                },
                {
                    "stores": [
                        {
                            "poi_id": "poi-a",
                            "verified_count": 1,
                            "verified_amount_cents": 800,
                            "estimated_income_cents": 780,
                        }
                    ]
                },
            ],
            {"poi-a": "有花头(白溪店)"},
        )

        self.assertEqual(result["verification"]["verified_count"], 3)
        self.assertEqual(result["verification"]["verified_amount_cents"], 2300)
        self.assertEqual(result["stores"][0]["store"], "有花头(白溪店)")
        self.assertTrue(result["complete"])

    def test_marks_monthly_summary_incomplete_when_dates_are_missing(self):
        result = merge_ledger_days(
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
