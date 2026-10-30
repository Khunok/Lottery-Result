#!/usr/bin/env python3
"""
A Thousand Dreams — automatic Thai Government Lottery results.

Runs on GitHub Actions. Fetches the latest draw from two independent sources,
checks the numbers are complete and that the sources agree, then updates:

  lottery.json            latest draw (the old keys stay, so old app versions keep working)
  history/YYYY-MM-DD.json one file per draw
  history/index.json      list of all saved draws, newest first

Nothing is written if the data looks wrong. Only the Python standard library is used.

  python scripts/update_lottery.py                 # update with the latest draw
  python scripts/update_lottery.py --dry-run       # only print what would change
  python scripts/update_lottery.py --date 2026-10-16   # (re)load one past draw into history
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LATEST = os.path.join(ROOT, "lottery.json")
HIST_DIR = os.path.join(ROOT, "history")
UA = "Mozilla/5.0 (A-Thousand-Dreams lottery bot; +https://github.com/Khunok/Lottery-Result)"
TIMEOUT = 25

# How many numbers each prize must have, and how many digits each number has
SHAPE = {
    "first": (1, 6), "near_first": (2, 6), "second": (5, 6), "third": (10, 6),
    "fourth": (50, 6), "fifth": (100, 6), "front3": (2, 3), "back3": (2, 3), "last2": (1, 2),
}

THAI_MONTHS = {
    "มกราคม": 1, "กุมภาพันธ์": 2, "มีนาคม": 3, "เมษายน": 4, "พฤษภาคม": 5, "มิถุนายน": 6,
    "กรกฎาคม": 7, "สิงหาคม": 8, "กันยายน": 9, "ตุลาคม": 10, "พฤศจิกายน": 11, "ธันวาคม": 12,
}


def log(*a):
    print(*a, flush=True)


def http_json(url, body=None):
    data = None
    headers = {"User-Agent": UA, "Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method="POST" if body is not None else "GET")
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8"))


def find_dict_with(obj, keys):
    """Depth-first search for the first dict that has all `keys`."""
    if isinstance(obj, dict):
        if all(k in obj for k in keys):
            return obj
        for v in obj.values():
            hit = find_dict_with(v, keys)
            if hit is not None:
                return hit
    elif isinstance(obj, list):
        for v in obj:
            hit = find_dict_with(v, keys)
            if hit is not None:
                return hit
    return None


def find_iso_date(obj):
    """First YYYY-MM-DD string anywhere in obj (Buddhist years are converted)."""
    if isinstance(obj, str):
        m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", obj)
        if m:
            y = int(m.group(1))
            if y > 2400:
                y -= 543
            return f"{y:04d}-{m.group(2)}-{m.group(3)}"
        return None
    items = obj.items() if isinstance(obj, dict) else enumerate(obj) if isinstance(obj, list) else []
    # prefer keys literally called "date"
    if isinstance(obj, dict) and isinstance(obj.get("date"), str):
        d = find_iso_date(obj["date"])
        if d:
            return d
    for _, v in items:
        d = find_iso_date(v)
        if d:
            return d
    return None


def thai_text_date(s):
    """'16 ตุลาคม 2569' -> '2026-10-16'"""
    m = re.search(r"(\d{1,2})\s+(\S+)\s+(\d{4})", s or "")
    if not m or m.group(2) not in THAI_MONTHS:
        return None
    y = int(m.group(3))
    if y > 2400:
        y -= 543
    return f"{y:04d}-{THAI_MONTHS[m.group(2)]:02d}-{int(m.group(1)):02d}"


# ---------------------------------------------------------------- sources

def _glo_numbers(block):
    nums = []
    for n in (block or {}).get("number", []):
        v = n.get("value") if isinstance(n, dict) else n
        if v is not None:
            nums.append(str(v).strip())
    return nums


def source_glo(date=None):
    """Government Lottery Office (official website API)."""
    if date:
        y, m, d = date.split("-")
        j = http_json("https://www.glo.or.th/api/checking/getLotteryResult",
                      {"date": d, "month": m, "year": y})
    else:
        j = http_json("https://www.glo.or.th/api/lottery/getLatestLottery", {})
    data = find_dict_with(j, ["first", "last2"])
    if data is None:
        raise ValueError("GLO: prize data not found in response")
    res = {
        "first": _glo_numbers(data.get("first")),
        "near_first": _glo_numbers(data.get("near1")),
        "second": _glo_numbers(data.get("second")),
        "third": _glo_numbers(data.get("third")),
        "fourth": _glo_numbers(data.get("fourth")),
        "fifth": _glo_numbers(data.get("fifth")),
        "front3": _glo_numbers(data.get("last3f")),
        "back3": _glo_numbers(data.get("last3b")),
        "last2": _glo_numbers(data.get("last2")),
    }
    return find_iso_date(j) or date, res


def source_rayriffy(date=None):
    """Community API (github.com/rayriffy/thai-lotto-api)."""
    if date:
        y, m, d = date.split("-")
        j = http_json(f"https://lotto.api.rayriffy.com/lotto/{d}{m}{int(y) + 543}")
    else:
        j = http_json("https://lotto.api.rayriffy.com/latest")
    r = j.get("response", j)
    by_id = {}
    for p in (r.get("prizes") or []) + (r.get("runningNumbers") or []):
        by_id[p.get("id")] = [str(x).strip() for x in p.get("number", [])]
    res = {
        "first": by_id.get("prizeFirst", []),
        "near_first": by_id.get("prizeFirstNear", []),
        "second": by_id.get("prizeSecond", []),
        "third": by_id.get("prizeThird", []),
        "fourth": by_id.get("prizeForth", by_id.get("prizeFourth", [])),
        "fifth": by_id.get("prizeFifth", []),
        "front3": by_id.get("runningNumberFrontThree", []),
        "back3": by_id.get("runningNumberBackThree", []),
        "last2": by_id.get("runningNumberBackTwo", []),
    }
    return thai_text_date(r.get("date", "")) or date, res


SOURCES = [("glo", source_glo), ("rayriffy", source_rayriffy)]

# ---------------------------------------------------------------- checks


def problems(date, res):
    out = []
    if not date or not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
        out.append(f"bad date {date!r}")
    for key, (count, digits) in SHAPE.items():
        nums = res.get(key, [])
        if len(nums) != count:
            out.append(f"{key}: expected {count} numbers, got {len(nums)}")
        bad = [n for n in nums if not (n.isdigit() and len(n) == digits)]
        if bad:
            out.append(f"{key}: bad numbers {bad[:3]}")
    return out


def same_main_numbers(a, b):
    keys = ("first", "front3", "back3", "last2", "near_first")
    return all(sorted(a[k]) == sorted(b[k]) for k in keys)


# ---------------------------------------------------------------- files


def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")


def build_record(date, res, source):
    y, m, d = date.split("-")
    return {
        # --- keys the current app already reads (do not rename) ---
        "date": f"({d}/{m}/{y})",
        "num_1": res["first"][0],
        "last_2": res["last2"][0],
        "front_numb3": res["front3"],
        "last_num3": res["back3"],
        # --- new: full results for future app versions ---
        "draw_date": date,
        "prizes": {k: res[k] for k in ("first", "near_first", "second", "third", "fourth", "fifth")},
        "running": {"front3": res["front3"], "back3": res["back3"], "last2": res["last2"]},
        "source": source,
        "updated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def current_date():
    cur = read_json(LATEST, {}) or {}
    if cur.get("draw_date"):
        return cur["draw_date"]
    m = re.search(r"(\d{2})/(\d{2})/(\d{4})", cur.get("date", ""))
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else None


def summary(text):
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write(text + "\n")


# ---------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--date", help="YYYY-MM-DD: load this past draw (history only)")
    args = ap.parse_args()

    good = []
    for name, fn in SOURCES:
        try:
            date, res = fn(args.date)
        except Exception as e:  # network error, format change, ...
            log(f"[{name}] failed: {e}")
            continue
        p = problems(date, res)
        if p:
            log(f"[{name}] not complete yet / invalid ({date}): " + "; ".join(p[:4]))
            continue
        log(f"[{name}] OK {date}: first={res['first'][0]} last2={res['last2'][0]}")
        good.append((name, date, res))

    if not good:
        log("No complete result from any source — nothing changed.")
        summary("⏳ No complete result yet — nothing changed.")
        return 0

    name, date, res = good[0]
    for other_name, other_date, other_res in good[1:]:
        if other_date == date and not same_main_numbers(res, other_res):
            log(f"!! {name} and {other_name} disagree for {date} — refusing to publish.")
            summary(f"⚠️ Sources disagree for {date}. Nothing published. Please check by hand.")
            return 1

    record = build_record(date, res, "+".join(n for n, d, _ in good if d == date))
    hist_path = os.path.join(HIST_DIR, f"{date}.json")
    index = read_json(os.path.join(HIST_DIR, "index.json"), []) or []
    cur = current_date()
    is_newest = args.date is None and (cur is None or date >= cur)

    old = read_json(LATEST, {}) or {}
    unchanged = (not is_newest or (old.get("draw_date") == date and old.get("prizes") == record["prizes"]))
    have_hist = os.path.exists(hist_path)

    if unchanged and have_hist:
        log(f"Already up to date ({date}).")
        summary(f"✅ Already up to date ({date}).")
        return 0

    log(f"Will save {date}: newest={is_newest}, history={'update' if have_hist else 'new'}")
    if args.dry_run:
        log(json.dumps(record, ensure_ascii=False)[:600] + " ...")
        summary(f"🧪 Dry run — would save draw {date} (first prize {res['first'][0]}).")
        return 0

    write_json(hist_path, record)
    if date not in index:
        index.append(date)
    write_json(os.path.join(HIST_DIR, "index.json"), sorted(set(index), reverse=True))
    if is_newest and not unchanged:
        write_json(LATEST, record)
    summary(f"🎉 Saved draw {date} — first prize **{res['first'][0]}**, last 2 **{res['last2'][0]}**.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
