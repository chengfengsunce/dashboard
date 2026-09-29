from __future__ import annotations

import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

API_ROOT = "https://api.github.com"
OWNER = os.environ.get("GITHUB_OWNER", "chengfengsunce")
OUTPUT = Path(os.environ.get("GITHUB_OUTPUT_FILE", "data.json"))
PER_REPO = max(1, min(int(os.environ.get("GITHUB_ITEMS_PER_REPO", "20")), 100))
TOKEN = os.environ.get("GITHUB_TOKEN", "").strip()
PRIVATE_REPO_TOKEN = os.environ.get("PRIVATE_REPO_TOKEN", "").strip()
if PRIVATE_REPO_TOKEN:
    TOKEN = PRIVATE_REPO_TOKEN


def api_get(path: str, params: dict[str, str | int] | None = None):
    query = urlencode(params or {})
    url = f"{API_ROOT}{path}"
    if query:
        url = f"{url}?{query}"

    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": f"{OWNER}-dashboard-sync",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if TOKEN:
        headers["Authorization"] = f"Bearer {TOKEN}"

    try:
        with urlopen(Request(url, headers=headers), timeout=30) as response:
            return json.load(response)
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        if error.code == 409 and path.endswith("/commits"):
            return []
        try:
            detail = json.loads(detail).get("message", detail)
        except json.JSONDecodeError:
            pass
        raise RuntimeError(f"GitHub API {error.code} for {path}: {detail}") from error
    except URLError as error:
        raise RuntimeError(f"GitHub API network error for {path}: {error.reason}") from error


def get_all_pages(path: str, params: dict[str, str | int] | None = None) -> list[dict]:
    results: list[dict] = []
    page = 1
    while True:
        page_params = dict(params or {})
        page_params.update({"per_page": 100, "page": page})
        page_data = api_get(path, page_params)
        if not isinstance(page_data, list):
            raise RuntimeError(f"GitHub API returned an unexpected response for {path}")
        results.extend(page_data)
        if len(page_data) < 100:
            return results
        page += 1


def first_line(message: str | None) -> str:
    value = (message or "").strip()
    return value.splitlines()[0].strip() if value else "无提交说明"


def base_item(kind: str, repo: dict, item_id: str, title: str, url: str, updated_at: str | None) -> dict:
    return {
        "id": f"{kind}:{repo['full_name']}:{item_id}",
        "kind": kind,
        "repo": repo["name"],
        "repo_full_name": repo["full_name"],
        "repo_url": repo["html_url"],
        "title": title,
        "html_url": url,
        "updated_at": updated_at,
    }


def repo_activity(repo: dict) -> list[dict]:
    owner = repo["owner"]["login"]
    name = repo["name"]
    items: list[dict] = []

    commits = api_get(
        f"/repos/{owner}/{name}/commits",
        {"per_page": PER_REPO},
    )
    for commit in commits if isinstance(commits, list) else []:
        commit_data = commit.get("commit") or {}
        author = commit.get("author") or {}
        committer = commit_data.get("committer") or {}
        if author.get("login") == "github-actions[bot]":
            continue
        item = base_item(
            "commit",
            repo,
            commit.get("sha", "")[:12],
            first_line(commit_data.get("message")),
            commit.get("html_url", repo["html_url"]),
            author.get("date") or committer.get("date"),
        )
        item["actor"] = author.get("login") or (commit_data.get("author") or {}).get("name")
        items.append(item)

    issues = api_get(
        f"/repos/{owner}/{name}/issues",
        {"state": "all", "sort": "updated", "direction": "desc", "per_page": PER_REPO},
    )
    for issue in issues if isinstance(issues, list) else []:
        kind = "pull_request" if issue.get("pull_request") else "issue"
        item = base_item(
            kind,
            repo,
            str(issue.get("number", issue.get("id", ""))),
            issue.get("title", "无标题"),
            issue.get("html_url", repo["html_url"]),
            issue.get("updated_at"),
        )
        item["state"] = issue.get("state", "open")
        item["actor"] = (issue.get("user") or {}).get("login")
        item["labels"] = [label.get("name") for label in issue.get("labels", []) if label.get("name")]
        items.append(item)

    releases = api_get(
        f"/repos/{owner}/{name}/releases",
        {"per_page": min(PER_REPO, 20)},
    )
    for release in releases if isinstance(releases, list) else []:
        item = base_item(
            "release",
            repo,
            str(release.get("id", "")),
            release.get("name") or release.get("tag_name") or "新版本发布",
            release.get("html_url", repo["html_url"]),
            release.get("published_at") or release.get("created_at"),
        )
        item["actor"] = (release.get("author") or {}).get("login")
        item["tag_name"] = release.get("tag_name")
        item["prerelease"] = bool(release.get("prerelease"))
        items.append(item)

    return items


def repositories_for_sync() -> list[dict]:
    if PRIVATE_REPO_TOKEN:
        repositories = get_all_pages(
            "/user/repos",
            {
                "visibility": "all",
                "affiliation": "owner,collaborator,organization_member",
                "sort": "updated",
            },
        )
        return [
            repo
            for repo in repositories
            if (repo.get("owner") or {}).get("login", "").lower() == OWNER.lower()
        ]

    repositories = get_all_pages(f"/users/{OWNER}/repos", {"type": "all", "sort": "updated"})
    return [repo for repo in repositories if not repo.get("private")]


def main() -> int:
    repositories = repositories_for_sync()
    items: list[dict] = []

    with ThreadPoolExecutor(max_workers=min(8, max(1, len(repositories)))) as executor:
        jobs = {executor.submit(repo_activity, repo): repo["full_name"] for repo in repositories}
        for job in as_completed(jobs):
            try:
                items.extend(job.result())
            except RuntimeError as error:
                raise RuntimeError(f"{jobs[job]}: {error}") from error

    items.sort(key=lambda item: item.get("updated_at") or "", reverse=True)
    payload = {
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "owner": OWNER,
        "sync_scope": "account-visible" if PRIVATE_REPO_TOKEN else "public-only",
        "repositories": [
            {
                "name": repo["name"],
                "full_name": repo["full_name"],
                "html_url": repo["html_url"],
                "description": repo.get("description"),
                "language": repo.get("language"),
                "stargazers_count": repo.get("stargazers_count", 0),
                "updated_at": repo.get("pushed_at") or repo.get("updated_at"),
            }
            for repo in sorted(repositories, key=lambda value: value.get("pushed_at") or "", reverse=True)
        ],
        "items": items,
        "stats": {
            "repositories": len(repositories),
            "items": len(items),
            "commits": sum(item["kind"] == "commit" for item in items),
            "issues": sum(item["kind"] == "issue" for item in items),
            "pull_requests": sum(item["kind"] == "pull_request" for item in items),
            "releases": sum(item["kind"] == "release" for item in items),
        },
    }

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"同步完成：{len(repositories)} 个公开仓库，{len(items)} 条动态，写入 {OUTPUT}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as error:
        print(f"同步失败：{error}", file=sys.stderr)
        raise SystemExit(1)
