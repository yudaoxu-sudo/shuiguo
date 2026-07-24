#!/usr/bin/env python3
"""Douyin Local Life API client for the fruit-store daily report."""

from __future__ import annotations

import argparse
import json
import os
import random
import time
from collections import defaultdict
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


def load_env_file(file_path: str | Path = ".env") -> None:
    path = Path(file_path)
    if not path.exists():
        return

    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        os.environ[key] = value.strip().strip("\"'")


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


def summarize_ledger_day(
    target_date: date,
    ledger_records: list[dict[str, Any]],
) -> dict[str, Any]:
    stores: dict[str, dict[str, int]] = defaultdict(
        lambda: {
            "verified_count": 0,
            "verified_amount_cents": 0,
            "estimated_income_cents": 0,
        }
    )
    seen_certificates: set[str] = set()

    for record in ledger_records:
        certificate_id = str(
            (record.get("certificate") or {}).get("certificate_id") or ""
        )
        dedupe_key = certificate_id or str(record.get("ledger_id") or record.get("id") or "")
        if not dedupe_key or dedupe_key in seen_certificates:
            continue
        seen_certificates.add(dedupe_key)

        poi_id = str(record.get("poi_id") or "").strip()
        amount = record.get("amount") or {}
        store = stores[poi_id]
        store["verified_count"] += 1
        store["verified_amount_cents"] += as_int(amount.get("coupon_pay"))
        store["estimated_income_cents"] += as_int(amount.get("goods"))

    store_rows = [
        {"poi_id": poi_id, **values}
        for poi_id, values in stores.items()
    ]
    return {
        "report_date": target_date.isoformat(),
        "generated_at": datetime.now(SHANGHAI).isoformat(timespec="seconds"),
        "verification": {
            "verified_count": sum(row["verified_count"] for row in store_rows),
            "verified_amount_cents": sum(
                row["verified_amount_cents"] for row in store_rows
            ),
        },
        "settlement": {
            "estimated_income_cents": sum(
                row["estimated_income_cents"] for row in store_rows
            ),
        },
        "stores": store_rows,
    }


def merge_ledger_days(
    through_date: date,
    daily_summaries: list[dict[str, Any]],
    shop_names: dict[str, str],
) -> dict[str, Any]:
    stores: dict[str, dict[str, int]] = defaultdict(
        lambda: {
            "verified_count": 0,
            "verified_amount_cents": 0,
            "estimated_income_cents": 0,
        }
    )

    for summary in daily_summaries:
        for row in summary.get("stores") or []:
            poi_id = str(row.get("poi_id") or "")
            store = stores[poi_id]
            store["verified_count"] += as_int(row.get("verified_count"))
            store["verified_amount_cents"] += as_int(
                row.get("verified_amount_cents")
            )
            store["estimated_income_cents"] += as_int(
                row.get("estimated_income_cents")
            )

    store_rows = [
        {
            "poi_id": poi_id,
            "store": shop_names.get(poi_id) or f"未识别抖音门店({poi_id[-4:]})",
            **values,
        }
        for poi_id, values in stores.items()
    ]
    store_rows.sort(key=lambda row: row["verified_amount_cents"], reverse=True)

    return {
        "report_month": through_date.strftime("%Y-%m"),
        "through_date": through_date.isoformat(),
        "generated_at": datetime.now(SHANGHAI).isoformat(timespec="seconds"),
        "verification": {
            "verified_count": sum(row["verified_count"] for row in store_rows),
            "verified_amount_cents": sum(
                row["verified_amount_cents"] for row in store_rows
            ),
        },
        "settlement": {
            "estimated_income_cents": sum(
                row["estimated_income_cents"] for row in store_rows
            ),
        },
        "stores": store_rows,
        "cached_day_count": len(daily_summaries),
    }


class DouyinClient:
    def __init__(
        self,
        client_key: str | None = None,
        client_secret: str | None = None,
        account_id: str | None = None,
    ):
        load_env_file()
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
        self.ledger_cache_dir = Path(
            os.environ.get(
                "DOUYIN_LEDGER_CACHE_DIR",
                "output/douyin-ledger-daily",
            )
        )
        self.current_day_cache_seconds = max(
            0,
            int(os.environ.get("DOUYIN_CURRENT_DAY_CACHE_SECONDS", "600")),
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

    def query_shops(self) -> list[dict[str, str]]:
        shops: dict[str, str] = {}
        page = 1
        while page <= self.max_pages:
            data = self._get(
                "/goodlife/v1/shop/poi/query/",
                {
                    "account_id": self.account_id,
                    "page": page,
                    "size": 50,
                    "relation_type": 0,
                },
            )
            batch = data.get("pois") or []
            for item in batch:
                poi = item.get("poi") or {}
                poi_id = str(poi.get("poi_id") or "").strip()
                poi_name = str(poi.get("poi_name") or "").strip()
                if poi_id:
                    shops[poi_id] = poi_name or poi_id

            if len(batch) < 50 or page * 50 >= as_int(data.get("total")):
                break
            page += 1

        return [
            {"poi_id": poi_id, "store": store}
            for poi_id, store in shops.items()
        ]

    def _ledger_cache_path(self, target_date: date) -> Path:
        return self.ledger_cache_dir / f"{target_date.isoformat()}.json"

    def _load_ledger_day_cache(self, target_date: date) -> dict[str, Any] | None:
        cache_path = self._ledger_cache_path(target_date)
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return None

        today = datetime.now(SHANGHAI).date()
        try:
            generated_at = datetime.fromisoformat(str(cached["generated_at"]))
            if generated_at.tzinfo is None:
                generated_at = generated_at.replace(tzinfo=SHANGHAI)
        except (KeyError, TypeError, ValueError):
            return None

        if target_date == today:
            age_seconds = (datetime.now(SHANGHAI) - generated_at).total_seconds()
            return cached if age_seconds <= self.current_day_cache_seconds else None
        if target_date > today:
            return None
        if target_date == today - timedelta(days=1):
            if generated_at.date() < today:
                return None
        return cached

    def _save_ledger_day_cache(
        self,
        target_date: date,
        summary: dict[str, Any],
    ) -> None:
        cache_path = self._ledger_cache_path(target_date)
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = cache_path.with_suffix(".tmp")
        temp_path.write_text(
            json.dumps(summary, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temp_path.replace(cache_path)

    def ledger_day_summary(
        self,
        target_date: date,
        ledger_records: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        if ledger_records is None:
            cached = self._load_ledger_day_cache(target_date)
            if cached:
                return cached
            ledger_records = self.query_ledger(target_date)

        summary = summarize_ledger_day(target_date, ledger_records)
        self._save_ledger_day_cache(target_date, summary)
        return summary

    def monthly_ledger_summary(self, through_date: date) -> dict[str, Any]:
        month_start = through_date.replace(day=1)
        daily_summaries: list[dict[str, Any]] = []
        current = month_start
        while current <= through_date:
            daily_summaries.append(self.ledger_day_summary(current))
            current += timedelta(days=1)

        shop_names = {
            row["poi_id"]: row["store"]
            for row in self.query_shops()
        }
        return merge_ledger_days(through_date, daily_summaries, shop_names)

    def daily_summary(self, target_date: date) -> dict[str, Any]:
        period = date_range(target_date)
        orders = self.query_orders(period)
        verifications = self.query_verifications(period)
        ledger_records = self.query_ledger(target_date)
        self.ledger_day_summary(target_date, ledger_records)
        return summarize_daily_data(target_date, orders, verifications, ledger_records)

    def report_summary(
        self,
        target_date: date,
        month_through: date,
    ) -> dict[str, Any]:
        result = self.daily_summary(target_date)
        result["monthly"] = self.monthly_ledger_summary(month_through)
        return result


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
    parser.add_argument(
        "--month-through",
        help="月度核销账单统计到哪一天，格式 YYYY-MM-DD；默认今天",
    )
    parser.add_argument("--pretty", action="store_true", help="格式化 JSON 输出")
    args = parser.parse_args()

    target_date = date.fromisoformat(args.date) if args.date else yesterday()
    month_through = (
        date.fromisoformat(args.month_through)
        if args.month_through
        else datetime.now(SHANGHAI).date()
    )
    result = DouyinClient().report_summary(target_date, month_through)
    print(json.dumps(result, ensure_ascii=False, indent=2 if args.pretty else None))


if __name__ == "__main__":
    main()
