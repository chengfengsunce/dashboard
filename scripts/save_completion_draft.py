from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DEFAULT_API = "https://dashboard-issue-api.17760716857.workers.dev"
ORIGIN = "https://chengfengsunce.github.io"


def call_api(url: str, payload=None) -> dict:
    request = Request(url, headers={"Origin": ORIGIN, "Accept": "application/json",
        "Content-Type": "application/json", "User-Agent": "dashboard-completion-draft"},
        data=None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        method="GET" if payload is None else "PUT")
    try:
        with urlopen(request, timeout=25) as response:
            return json.load(response)
    except HTTPError as error:
        try:
            result = json.load(error)
            message = result.get("error") or "HTTP %d" % error.code
        except (ValueError, AttributeError):
            message = "HTTP %d" % error.code
        raise RuntimeError(message) from None
    except (URLError, TimeoutError, OSError, ValueError):
        raise RuntimeError("草稿保存结果未确认，请先读取该需求草稿核对，再决定是否重试。") from None


def main() -> int:
    parser = argparse.ArgumentParser(description="保存需求完成说明草稿，保留需求状态，不发通知")
    parser.add_argument("--issue", required=True, help="完整标识，如 chengfengsunce/dashboard#7")
    parser.add_argument("--summary-file", type=Path, required=True, help="UTF-8实际完成说明，最多500字")
    parser.add_argument("--expected-title", help="可选：保存前核对当前需求标题")
    parser.add_argument("--api-base-url", default=DEFAULT_API)
    args = parser.parse_args()
    match = re.fullmatch(r"(chengfengsunce/[a-zA-Z0-9_.-]+)#([1-9][0-9]{0,9})", args.issue)
    if not match:
        parser.error("请指定完整且有效的需求仓库与编号。")
    try:
        summary = args.summary_file.read_text(encoding="utf-8-sig").strip()
        if len(summary.encode("utf-16-le")) // 2 > 500:
            parser.error("完成说明不能超过500字。")
        route = "%s/api/issues/%s/%s/completion-draft" % (args.api_base_url.rstrip("/"), match[1], match[2])
        before = call_api(route)
        if args.expected_title is not None and before.get("title") != args.expected_title:
            raise RuntimeError("需求标题已变化或编号不符，未保存草稿。")
        saved = call_api(route, {"completion_summary": summary, "revision": before["revision"]})
        verified = call_api(route)
        if verified.get("completion_summary") != summary or saved.get("state") != before.get("state"):
            raise RuntimeError("草稿回读或状态核对不一致，请检查需求后再操作。")
        print(json.dumps({"issue": args.issue, "title": verified.get("title"), "state": verified.get("state"),
            "completion_summary": verified.get("completion_summary"), "saved": True, "notification": "not_requested"}, ensure_ascii=False))
        return 0
    except (OSError, RuntimeError, KeyError) as error:
        print(json.dumps({"issue": args.issue, "saved": False, "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
