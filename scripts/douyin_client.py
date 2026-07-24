#!/usr/bin/env python3
"""Douyin Local Life monthly settlement client for the fruit-store report."""

from __future__ import annotations

import argparse
import json
import os
import random
import time
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

try:
    import requests
except ModuleNotFoundError:
    requests = None


SHANGHAI = ZoneInfo("Asia/Shanghai")
TOKEN_ERROR_CODES = {2190002, 2190008, 28001003, 28001008}
RETRYABLE_ERROR_CODES = {
    2100001,
    2100004,
    2119002,
    28001005,
    28001006,
    5000001,
}


class DouyinAPIError(RuntimeError):
    def __init__(self, message: str, code: int | None = None):
        super().__init__(message)
        self.code = code


def as_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


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
        if key and key not in os.environ:
            os.environ[key] = value.strip().strip("\"'")


def summarize_composite_bill_day(
    target_date: date,
    ledger_records: list[dict[str, Any]],
) -> dict[str, Any]:
    stores: dict[str, dict[str, int]] = defaultdict(
        lambda: {
            "record_count": 0,
            "merchant_due_cents": 0,
        }
    )
    seen_ledgers: set[str] = set()

    for record in ledger_records:
        ledger_key = str(
            record.get("ledger_id")
            or record.get("bill_fund_id")
            or ""
        )
        if not ledger_key:
            ledger_key = json.dumps(record, ensure_ascii=False, sort_keys=True)
        if ledger_key in seen_ledgers:
            continue
        seen_ledgers.add(ledger_key)

        raw_amount_type = record.get("fund_amount_type")
        if str(raw_amount_type) not in {"0", "1"}:
            raise DouyinAPIError(
                f"抖音综合账单出现未知金额方向：{raw_amount_type}"
            )
        signed_amount = as_int(record.get("fund_amount"))
        if str(raw_amount_type) == "1":
            signed_amount *= -1

        poi_id = str(record.get("poi_id") or "").strip()
        store = stores[poi_id]
        store["record_count"] += 1
        store["merchant_due_cents"] += signed_amount

    store_rows = [
        {"poi_id": poi_id, **values}
        for poi_id, values in stores.items()
    ]
    return {
        "report_date": target_date.isoformat(),
        "generated_at": datetime.now(SHANGHAI).isoformat(timespec="seconds"),
        "settlement": {
            "record_count": len(seen_ledgers),
            "merchant_due_cents": sum(
                row["merchant_due_cents"] for row in store_rows
            ),
        },
        "stores": store_rows,
    }


def merge_composite_bill_days(
    through_date: date,
    daily_summaries: list[dict[str, Any]],
    shop_names: dict[str, str],
    missing_dates: list[date] | None = None,
    rate_limited: bool = False,
    settlement_days: int = 5,
) -> dict[str, Any]:
    stores: dict[str, dict[str, int]] = defaultdict(
        lambda: {
            "actual_received_cents": 0,
            "expected_received_cents": 0,
            "merchant_due_cents": 0,
        }
    )

    for summary in daily_summaries:
        business_date = date.fromisoformat(str(summary["report_date"]))
        is_settled = business_date + timedelta(days=settlement_days) <= through_date
        for row in summary.get("stores") or []:
            poi_id = str(row.get("poi_id") or "")
            amount = as_int(row.get("merchant_due_cents"))
            store = stores[poi_id]
            if is_settled:
                store["actual_received_cents"] += amount
            else:
                store["expected_received_cents"] += amount
            store["merchant_due_cents"] += amount

    store_rows = [
        {
            "poi_id": poi_id,
            "store": (
                shop_names.get(poi_id)
                or (
                    f"未识别抖音门店({poi_id[-4:]})"
                    if poi_id
                    else "未识别抖音门店(账户级)"
                )
            ),
            **values,
        }
        for poi_id, values in stores.items()
    ]
    store_rows.sort(key=lambda row: row["merchant_due_cents"], reverse=True)
    missing = missing_dates or []
    actual_received = sum(row["actual_received_cents"] for row in store_rows)
    expected_received = sum(row["expected_received_cents"] for row in store_rows)

    return {
        "report_month": through_date.strftime("%Y-%m"),
        "through_date": through_date.isoformat(),
        "generated_at": datetime.now(SHANGHAI).isoformat(timespec="seconds"),
        "complete": not missing,
        "rate_limited": rate_limited,
        "missing_dates": [value.isoformat() for value in missing],
        "cached_day_count": len(daily_summaries),
        "settlement": {
            "actual_received_cents": actual_received,
            "expected_received_cents": expected_received,
            "merchant_due_cents": actual_received + expected_received,
            "classification_basis": (
                f"business_date_plus_{settlement_days}_calendar_days"
            ),
        },
        "stores": store_rows,
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
        self.client_secret = client_secret or os.environ.get(
            "DOUYIN_CLIENT_SECRET",
            "",
        )
        self.account_id = account_id or os.environ.get("DOUYIN_ACCOUNT_ID", "")
        self.api_base = os.environ.get(
            "DOUYIN_API_BASE",
            "https://open.douyin.com",
        ).rstrip("/")
        self.timeout = float(os.environ.get("DOUYIN_TIMEOUT_SECONDS", "30"))
        self.retry_attempts = max(
            1,
            int(os.environ.get("DOUYIN_RETRY_ATTEMPTS", "4")),
        )
        self.max_pages = max(
            1,
            int(os.environ.get("DOUYIN_MAX_PAGES", "500")),
        )
        self.token_cache_path = Path(
            os.environ.get("DOUYIN_TOKEN_CACHE", "output/douyin-token.json")
        )
        self.settlement_cache_dir = Path(
            os.environ.get(
                "DOUYIN_SETTLEMENT_CACHE_DIR",
                "output/douyin-settlement-daily",
            )
        )
        self.current_day_cache_seconds = max(
            0,
            int(os.environ.get("DOUYIN_CURRENT_DAY_CACHE_SECONDS", "600")),
        )
        self.request_interval_seconds = max(
            0.0,
            float(os.environ.get("DOUYIN_REQUEST_INTERVAL_SECONDS", "0.1")),
        )
        self.rate_limit_cooldown_seconds = max(
            60,
            int(os.environ.get("DOUYIN_RATE_LIMIT_COOLDOWN_SECONDS", "3600")),
        )
        self.rate_limit_state_path = Path(
            os.environ.get(
                "DOUYIN_RATE_LIMIT_STATE",
                "output/douyin-rate-limit.json",
            )
        )
        self.settlement_days = max(
            0,
            int(os.environ.get("DOUYIN_SETTLEMENT_DAYS", "5")),
        )
        self.session = requests.Session()
        self.session.headers.update({"content-type": "application/json"})
        self._last_request_at = 0.0

        missing = [
            name
            for name, value in (
                ("DOUYIN_CLIENT_KEY", self.client_key),
                ("DOUYIN_CLIENT_SECRET", self.client_secret),
                ("DOUYIN_ACCOUNT_ID", self.account_id),
            )
            if not value
        ]
        if missing:
            raise ValueError(f"缺少抖音配置：{', '.join(missing)}")

    def _wait_for_request_slot(self) -> None:
        elapsed = time.monotonic() - self._last_request_at
        wait_seconds = self.request_interval_seconds - elapsed
        if wait_seconds > 0:
            time.sleep(wait_seconds)
        self._last_request_at = time.monotonic()

    def _active_rate_limit_retry_at(self) -> datetime | None:
        try:
            payload = json.loads(
                self.rate_limit_state_path.read_text(encoding="utf-8")
            )
            retry_at = datetime.fromisoformat(str(payload["retry_at"]))
            if retry_at.tzinfo is None:
                retry_at = retry_at.replace(tzinfo=SHANGHAI)
        except (FileNotFoundError, KeyError, TypeError, ValueError, OSError):
            return None

        if retry_at > datetime.now(SHANGHAI):
            return retry_at
        try:
            self.rate_limit_state_path.unlink()
        except OSError:
            pass
        return None

    def _mark_rate_limited(self) -> datetime:
        retry_at = datetime.now(SHANGHAI) + timedelta(
            seconds=self.rate_limit_cooldown_seconds
        )
        self.rate_limit_state_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = self.rate_limit_state_path.with_suffix(".tmp")
        temp_path.write_text(
            json.dumps(
                {
                    "error_code": 2119003,
                    "retry_at": retry_at.isoformat(timespec="seconds"),
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        temp_path.replace(self.rate_limit_state_path)
        return retry_at

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
            cached = json.loads(
                self.token_cache_path.read_text(encoding="utf-8")
            )
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
                self._wait_for_request_slot()
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
                        f"HTTP {response.status_code}",
                        response=response,
                    )
                response.raise_for_status()
                payload = response.json()
                code, description = self._response_error(payload)
                if code:
                    raise DouyinAPIError(
                        f"抖音获取 access_token 失败：{description}",
                        code,
                    )

                data = payload.get("data") or {}
                token = str(data.get("access_token") or "")
                if not token:
                    raise DouyinAPIError(
                        "抖音获取 access_token 失败：响应中没有 access_token"
                    )
                self._save_token(
                    token,
                    as_int(data.get("expires_in")) or 7200,
                )
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
                time.sleep(
                    min(8.0, 1.0 * (2**attempt))
                    + random.uniform(0, 0.5)
                )

        raise DouyinAPIError(f"抖音获取 access_token 失败：{last_error}")

    def _get(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        token_refreshed = False
        last_error: Exception | None = None
        token = self.access_token()

        for attempt in range(self.retry_attempts):
            try:
                self._wait_for_request_slot()
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
                        f"HTTP {response.status_code}",
                        response=response,
                    )
                response.raise_for_status()
                payload = response.json()
                code, description = self._response_error(payload)
                if code in TOKEN_ERROR_CODES and not token_refreshed:
                    token = self.access_token(force_refresh=True)
                    token_refreshed = True
                    continue
                if code:
                    raise DouyinAPIError(
                        f"抖音接口错误 {code}：{description}",
                        code,
                    )
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
                time.sleep(
                    min(8.0, 1.0 * (2**attempt))
                    + random.uniform(0, 0.5)
                )

        raise DouyinAPIError(f"抖音接口请求失败：{last_error}")

    def query_composite_bills(self, target_date: date) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        cursor = "0"
        seen_cursors: set[str] = set()

        for _ in range(self.max_pages):
            data = self._get(
                "/goodlife/v1/settle/bill/composite_query/",
                {
                    "account_id": self.account_id,
                    "root_account_id": self.account_id,
                    "bill_date": target_date.isoformat(),
                    "cursor": cursor,
                    "size": 50,
                    "biz_type": 1,
                },
            )
            batch = data.get("ledger_records") or []
            records.extend(batch)
            next_cursor = str(data.get("cursor") or "")
            if not data.get("has_more") or not next_cursor:
                return records
            if next_cursor in seen_cursors:
                raise DouyinAPIError("抖音综合账单分页游标重复，已停止读取")
            seen_cursors.add(next_cursor)
            cursor = next_cursor

        raise DouyinAPIError(f"抖音综合账单超过分页上限 {self.max_pages}")

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

    def _cache_path(self, target_date: date) -> Path:
        return self.settlement_cache_dir / f"{target_date.isoformat()}.json"

    def _read_day_cache(self, target_date: date) -> dict[str, Any] | None:
        try:
            return json.loads(
                self._cache_path(target_date).read_text(encoding="utf-8")
            )
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return None

    def _load_day_cache(self, target_date: date) -> dict[str, Any] | None:
        cached = self._read_day_cache(target_date)
        if not cached:
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

    def _save_day_cache(
        self,
        target_date: date,
        summary: dict[str, Any],
    ) -> None:
        cache_path = self._cache_path(target_date)
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = cache_path.with_suffix(".tmp")
        temp_path.write_text(
            json.dumps(summary, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temp_path.replace(cache_path)

    def settlement_day_summary(self, target_date: date) -> dict[str, Any]:
        cached = self._load_day_cache(target_date)
        if cached:
            return cached

        summary = summarize_composite_bill_day(
            target_date,
            self.query_composite_bills(target_date),
        )
        self._save_day_cache(target_date, summary)
        return summary

    def monthly_settlement_summary(self, through_date: date) -> dict[str, Any]:
        target_dates: list[date] = []
        current = through_date.replace(day=1)
        while current <= through_date:
            target_dates.append(current)
            current += timedelta(days=1)

        daily_summaries: list[dict[str, Any]] = []
        retry_at = self._active_rate_limit_retry_at()
        rate_limited = retry_at is not None
        if not rate_limited:
            for target_date in target_dates:
                try:
                    daily_summaries.append(
                        self.settlement_day_summary(target_date)
                    )
                except DouyinAPIError as error:
                    if error.code != 2119003:
                        raise
                    rate_limited = True
                    retry_at = self._mark_rate_limited()
                    break

        if rate_limited:
            daily_summaries = [
                cached
                for target_date in target_dates
                if (cached := self._read_day_cache(target_date))
            ]

        cached_dates = {
            str(summary.get("report_date") or "")
            for summary in daily_summaries
        }
        missing_dates = [
            target_date
            for target_date in target_dates
            if target_date.isoformat() not in cached_dates
        ]
        shop_names = {
            row["poi_id"]: row["store"]
            for row in self.query_shops()
        }
        result = merge_composite_bill_days(
            through_date,
            daily_summaries,
            shop_names,
            missing_dates,
            rate_limited,
            self.settlement_days,
        )
        if retry_at:
            result["rate_limit_retry_at"] = retry_at.isoformat(
                timespec="seconds"
            )
        return result

    def report_summary(self, month_through: date) -> dict[str, Any]:
        return {
            "report_month": month_through.strftime("%Y-%m"),
            "through_date": month_through.isoformat(),
            "generated_at": datetime.now(SHANGHAI).isoformat(timespec="seconds"),
            "monthly": self.monthly_settlement_summary(month_through),
        }


def main() -> None:
    parser = argparse.ArgumentParser(description="读取抖音来客本月到账数据")
    parser.add_argument(
        "--month-through",
        help="月度综合账单统计到哪一天，格式 YYYY-MM-DD；默认今天",
    )
    parser.add_argument("--pretty", action="store_true", help="格式化 JSON 输出")
    args = parser.parse_args()

    month_through = (
        date.fromisoformat(args.month_through)
        if args.month_through
        else datetime.now(SHANGHAI).date()
    )
    result = DouyinClient().report_summary(month_through)
    print(json.dumps(result, ensure_ascii=False, indent=2 if args.pretty else None))


if __name__ == "__main__":
    main()
