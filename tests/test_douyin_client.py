import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import douyin_client
from douyin_client import (
    DouyinAPIError,
    DouyinClient,
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

    def test_rate_limit_error_is_not_retried(self):
        class FakeResponse:
            status_code = 200

            @staticmethod
            def raise_for_status():
                return None

            @staticmethod
            def json():
                return {
                    "extra": {
                        "error_code": 2119003,
                        "description": "请求太过频繁，请稍后再试",
                    }
                }

        class FakeSession:
            def __init__(self):
                self.calls = 0

            def get(self, *args, **kwargs):
                self.calls += 1
                return FakeResponse()

        class FakeRequests:
            class RequestException(Exception):
                pass

            class HTTPError(RequestException):
                pass

        client = object.__new__(DouyinClient)
        client.session = FakeSession()
        client.access_token = lambda force_refresh=False: "token"
        client.retry_attempts = 4
        client.api_base = "https://example.invalid"
        client.account_id = "account"
        client.timeout = 1
        client._wait_for_request_slot = lambda: None

        original_requests = douyin_client.requests
        douyin_client.requests = FakeRequests
        try:
            with self.assertRaises(DouyinAPIError):
                client._get("/test", {})
        finally:
            douyin_client.requests = original_requests

        self.assertEqual(client.session.calls, 1)

    def test_active_rate_limit_cooldown_skips_bill_requests(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "rate-limit.json"
            client = object.__new__(DouyinClient)
            client.rate_limit_state_path = state_path
            client.rate_limit_cooldown_seconds = 3600
            client.settlement_cache_dir = Path(directory) / "daily"
            client.settlement_days = 5
            client._mark_rate_limited()
            client.query_shops = lambda: []
            client.settlement_day_summary = lambda target_date: self.fail(
                f"cooldown should skip {target_date}"
            )

            result = client.monthly_settlement_summary(date(2026, 7, 2))

        self.assertTrue(result["rate_limited"])
        self.assertFalse(result["complete"])
        self.assertEqual(
            result["missing_dates"],
            ["2026-07-01", "2026-07-02"],
        )
        self.assertIn("rate_limit_retry_at", result)


if __name__ == "__main__":
    unittest.main()
