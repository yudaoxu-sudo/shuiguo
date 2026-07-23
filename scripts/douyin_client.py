#!/usr/bin/env python3
"""Douyin Local Life API client for the fruit-store daily report."""

from __future__ import annotations

import argparse
import json
import os
import random
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

try:
    import requests
except ModuleNotFoundError:
    requests = None


SHANGHAI = ZoneInfo("Asia/Shanghai")
PAID_ORDER_STATUSES = {1, 150, 200, 201}
TOKEN_ERROR_CODES = {2190002, 2190008, 28001003, 28001008}
RETRYABLE_ERROR_CODES = {
    2100001,
    2100004,
    2119002,
    2119003,
    28001005,
    28001006,
    5000001,
}


class DouyinAPIError(RuntimeError):
    def __init__(self, message: str, code: int | None = None):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class DateRange:
    target_date: date
    start_timestamp: int
    end_timestamp: int


def date_range(target_date: date) -> DateRange:
    start = datetime.combine(target_date, datetime.min.time(), tzinfo=SHANGHAI)
    return DateRange(
        target_date=target_date,
        start_timestamp=int(start.timestamp()),
        end_timestamp=int((start + timedelta(days=1)).timestamp()) - 1,
    )


def yesterday() -> date:
    return datetime.now(SHANGHAI).date() - timedelta(days=1)


def as_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def percent(numerator: int, denominator: int) -> float | None:
    if denominator <= 0:
        return None
    return round(numerator / denominator * 100, 2)


def summarize_daily_data(
    target_date: date,
    orders: list[dict[str, Any]],
    verifications: list[dict[str, Any]],
    ledger_records: list[dict[str, Any]],
) -> dict[str, Any]:
    paid_orders = [
        order for order in orders
        if as_int(order.get("order_status")) in PAID_ORDER_STATUSES
    ]
    active_verifications = [
        record for record in verifications
        if record.get("status") is None or as_int(record.get("status")) == 1
    ]
    live_orders = [
        order for order in paid_orders
        if str((order.get("order_sale_info") or {}).get("sale_channel") or "").strip() == "直播"
    ]
    live_ledgers = [
        record for record in ledger_records
        if str((record.get("order_attrribute") or {}).get("source") or "").strip().lower()
        == "livebroadcasting"
    ]

    paid_coupon_count = sum(as_int(order.get("count")) for order in paid_orders)
    verified_count = len(active_verifications)

    return {
        "report_date": target_date.isoformat(),
        "generated_at": datetime.now(SHANGHAI).isoformat(timespec="seconds"),
        "orders": {
            "submitted_order_count": len(orders),
            "paid_order_count": len(paid_orders),
            "paid_coupon_count": paid_coupon_count,
            "sales_amount_cents": sum(as_int(order.get("pay_amount")) for order in paid_orders),
        },
        "verification": {
            "verified_count": verified_count,
            "verified_amount_cents": sum(
                as_int((record.get("amount") or {}).get("coupon_pay_amount"))
                for record in active_verifications
            ),
            "verification_rate_percent": percent(verified_count, paid_coupon_count),
        },
        "settlement": {
            "record_count": len(ledger_records),
            "estimated_income_cents": sum(
                as_int((record.get("amount") or {}).get("goods"))
                for record in ledger_records
            ),
        },
        "live": {
            "paid_order_count": len(live_orders),
            "paid_coupon_count": sum(as_int(order.get("count")) for order in live_orders),
            "sales_amount_cents": sum(as_int(order.get("pay_amount")) for order in live_orders),
            "verified_count": len(live_ledgers),
            "verified_amount_cents": sum(
                as_int((record.get("amount") or {}).get("coupon_pay"))
                for record in live_ledgers
            ),
            "estimated_income_cents": sum(
                as_int((record.get("amount") or {}).get("goods"))
                for record in live_ledgers
            ),
        },
    }


class DouyinClient:
    def __init__(
        self,
        client_key: str | None = None,
        client_secret: str | None = None,
        account_id: str | None = None,
    ):
        if requests is None:
            raise RuntimeError("缺少 Python 依赖 requests，请先安装 requirements.txt")

        self.client_key = client_key or os.environ.get("DOUYIN_CLIENT_KEY", "")
        self.client_secret = client_secret or os.environ.get("DOUYIN_CLIENT_SECRET", "")
        self.account_id = account_id or os.environ.get("DOUYIN_ACCOUNT_ID", "")
        self.api_base = os.environ.get("DOUYIN_API_BASE", "https://open.douyin.com").rstrip("/")
        self.timeout = float(os.environ.get("DOUYIN_TIMEOUT_SECONDS", "30"))
        self.retry_attempts = max(1, int(os.environ.get("DOUYIN_RETRY_ATTEMPTS", "4")))
        self.max_pages = max(1, int(os.environ.get("DOUYIN_MAX_PAGES", "500")))
        self.token_cache_path = Path(
            os.environ.get("DOUYIN_TOKEN_CACHE", "output/douyin-token.json")
        )
        self.session = requests.Session()
        self.session.headers.update({"content-type": "application/json"})

        missing = [
            name for name, value in (
                ("DOUYIN_CLIENT_KEY", self.client_key),
                ("DOUYIN_CLIENT_SECRET", self.client_secret),
                ("DOUYIN_ACCOUNT_ID", self.account_id),
            )
            if not value
        ]
        if missing:
            raise ValueError(f"缺少抖音配置：{', '.join(missing)}")

    @staticmethod
    def _response_error(payload: dict[str, Any]) -> tuple[int | None, str]:
        for section_name in ("extra", "data"):
            section = payload.get(section_name)
            if not isinstance(section, dict):
                continue
            code = as_int(section.get("error_code"))
            if code:
                description = (
                    section.get("sub_description")
                    or section.get("description")
                    or "未知错误"
                )
                return code, str(description)
        return None, ""

    def _load_cached_token(self) -> str | None:
        try:
            cached = json.loads(self.token_cache_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return None

        if (
            cached.get("client_key") == self.client_key
            and float(cached.get("expires_at", 0)) > time.time() + 300
        ):
            return str(cached.get("access_token") or "") or None
        return None

    def _save_token(self, token: str, expires_in: int) -> None:
        self.token_cache_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = self.token_cache_path.with_suffix(".tmp")
        temp_path.write_text(
            json.dumps(
                {
                    "client_key": self.client_key,
                    "access_token": token,
                    "expires_at": time.time() + expires_in,
                }
            ),
            encoding="utf-8",
        )
        os.chmod(temp_path, 0o600)
        temp_path.replace(self.token_cache_path)

    def access_token(self, force_refresh: bool = False) -> str:
        if not force_refresh:
            cached = self._load_cached_token()
            if cached:
                return cached

        last_error: Exception | None = None
        for attempt in range(self.retry_attempts):
            try:
                response = self.session.post(
                    f"{self.api_base}/oauth/client_token/",
                    json={
                        "client_key": self.client_key,
                        "client_secret": self.client_secret,
                        "grant_type": "client_credential",
                    },
                    timeout=self.timeout,
                )
                if response.status_code == 429 or response.status_code >= 500:
                    raise requests.HTTPError(
                        f"HTTP {response.status_code}", response=response
                    )
                response.raise_for_status()
                payload = response.json()
                code, description = self._response_error(payload)
                if code:
                    raise DouyinAPIError(
                        f"抖音获取 access_token 失败：{description}", code
                    )

                data = payload.get("data") or {}
                token = str(data.get("access_token") or "")
                if not token:
                    raise DouyinAPIError(
                        "抖音获取 access_token 失败：响应中没有 access_token"
                    )
                self._save_token(token, as_int(data.get("expires_in")) or 7200)
                return token
            except (requests.RequestException, ValueError, DouyinAPIError) as error:
                last_error = error
                retryable = (
                    isinstance(error, requests.RequestException)
                    or (
                        isinstance(error, DouyinAPIError)
                        and error.code in RETRYABLE_ERROR_CODES
                    )
                )
                if not retryable or attempt == self.retry_attempts - 1:
                    raise
                time.sleep(min(8.0, 1.0 * (2**attempt)) + random.uniform(0, 0.5))

        raise DouyinAPIError(f"抖音获取 access_token 失败：{last_error}")

    def _get(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        token_refreshed = False
        last_error: Exception | None = None
        token = self.access_token()

        for attempt in range(self.retry_attempts):
            try:
                response = self.session.get(
                    f"{self.api_base}{path}",
                    params=params,
                    headers={
                        "access-token": token,
                        "Rpc-Transit-Life-Account": self.account_id,
                    },
                    timeout=self.timeout,
                )
                if response.status_code == 429 or response.status_code >= 500:
                    raise requests.HTTPError(
                        f"HTTP {response.status_code}", response=response
                    )
                response.raise_for_status()
                payload = response.json()
                code, description = self._response_error(payload)
                if code in TOKEN_ERROR_CODES and not token_refreshed:
                    token = self.access_token(force_refresh=True)
                    token_refreshed = True
                    continue
                if code:
                    raise DouyinAPIError(f"抖音接口错误 {code}：{description}", code)
                return payload.get("data") or {}
            except (requests.RequestException, ValueError, DouyinAPIError) as error:
                last_error = error
                retryable = (
                    isinstance(error, requests.RequestException)
                    or (
                        isinstance(error, DouyinAPIError)
                        and error.code in RETRYABLE_ERROR_CODES
                    )
                )
                if not retryable or attempt == self.retry_attempts - 1:
                    raise
                time.sleep(min(8.0, 1.0 * (2**attempt)) + random.uniform(0, 0.5))

        raise DouyinAPIError(f"抖音接口请求失败：{last_error}")

    def query_orders(self, period: DateRange) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        cursor = "0"
        seen_cursors: set[str] = set()

        for _ in range(self.max_pages):
            data = self._get(
                "/goodlife/v1/trade/order/query/",
                {
                    "account_id": self.account_id,
                    "page_num": 1,
                    "page_size": 100,
                    "cursor": cursor,
                    "create_order_start_time": period.start_timestamp,
                    "create_order_end_time": period.end_timestamp,
                },
            )
            batch = data.get("orders") or []
            records.extend(batch)
            cursor_values = (data.get("search_after") or {}).get("CursorValue") or []
            next_cursor = ",".join(str(value) for value in cursor_values)
            if len(batch) < 100 or not next_cursor:
                return records
            if next_cursor in seen_cursors:
                raise DouyinAPIError("抖音订单分页游标重复，已停止读取")
            seen_cursors.add(next_cursor)
            cursor = next_cursor

        raise DouyinAPIError(f"抖音订单超过分页上限 {self.max_pages}")

    def query_verifications(self, period: DateRange) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        cursor = "0"
        seen_cursors: set[str] = set()

        for _ in range(self.max_pages):
            data = self._get(
                "/goodlife/v1/fulfilment/certificate/verify_record/query/",
                {
                    "account_id": self.account_id,
                    "cursor": cursor,
                    "size": 20,
                    "start_time": period.start_timestamp,
                    "end_time": period.end_timestamp,
                },
            )
            batch = data.get("records_v2") or data.get("records") or []
            records.extend(batch)
            next_cursor = str(batch[-1].get("cursor") or "") if batch else ""
            if len(batch) < 20 or not next_cursor:
                return records
            if next_cursor in seen_cursors:
                raise DouyinAPIError("抖音核销分页游标重复，已停止读取")
            seen_cursors.add(next_cursor)
            cursor = next_cursor

        raise DouyinAPIError(f"抖音核销记录超过分页上限 {self.max_pages}")

    def query_ledger(self, target_date: date) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        cursor = "0"
        seen_cursors: set[str] = set()

        for _ in range(self.max_pages):
            data = self._get(
                "/goodlife/v1/settle/ledger/query/",
                {
                    "account_id": self.account_id,
                    "bill_date": target_date.isoformat(),
                    "cursor": cursor,
                    "size": 50,
                },
            )
            batch = data.get("ledger_records") or []
            records.extend(batch)
            next_cursor = str(data.get("cursor") or "")
            if not data.get("has_more") or not next_cursor:
                return records
            if next_cursor in seen_cursors:
                raise DouyinAPIError("抖音账单分页游标重复，已停止读取")
            seen_cursors.add(next_cursor)
            cursor = next_cursor

        raise DouyinAPIError(f"抖音账单超过分页上限 {self.max_pages}")

    def daily_summary(self, target_date: date) -> dict[str, Any]:
        period = date_range(target_date)
        orders = self.query_orders(period)
        verifications = self.query_verifications(period)
        ledger_records = self.query_ledger(target_date)
        return summarize_daily_data(target_date, orders, verifications, ledger_records)


def pull_yesterday_orders(client: DouyinClient | None = None) -> list[dict[str, Any]]:
    target_date = yesterday()
    return (client or DouyinClient()).query_orders(date_range(target_date))


def pull_yesterday_verifications(
    client: DouyinClient | None = None,
) -> list[dict[str, Any]]:
    target_date = yesterday()
    return (client or DouyinClient()).query_verifications(date_range(target_date))


def pull_yesterday_ledger(client: DouyinClient | None = None) -> list[dict[str, Any]]:
    target_date = yesterday()
    return (client or DouyinClient()).query_ledger(target_date)


def pull_yesterday_live_data(client: DouyinClient | None = None) -> dict[str, Any]:
    api = client or DouyinClient()
    target_date = yesterday()
    period = date_range(target_date)
    summary = summarize_daily_data(
        target_date,
        api.query_orders(period),
        [],
        api.query_ledger(target_date),
    )
    return summary["live"]


def main() -> None:
    parser = argparse.ArgumentParser(description="读取抖音来客昨日经营数据")
    parser.add_argument("--date", help="读取日期，格式 YYYY-MM-DD；默认昨天")
    parser.add_argument("--pretty", action="store_true", help="格式化 JSON 输出")
    args = parser.parse_args()

    target_date = date.fromisoformat(args.date) if args.date else yesterday()
    result = DouyinClient().daily_summary(target_date)
    print(json.dumps(result, ensure_ascii=False, indent=2 if args.pretty else None))


if __name__ == "__main__":
    main()
