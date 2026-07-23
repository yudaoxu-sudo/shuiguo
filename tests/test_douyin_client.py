import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from douyin_client import summarize_daily_data


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


if __name__ == "__main__":
    unittest.main()
