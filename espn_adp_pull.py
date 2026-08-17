#!/usr/bin/env python3
"""
ESPN live ADP -> index.html

Replaces the hand-transcribed ADP table with a live pull from ESPN's own
player-info endpoint (the same data behind their "Live Draft Trends" page).

Writes two things:
  espn_adp.json  — the raw pull, for inspection / debugging
  index.html     — PLAYERS_DATA adpRank / adpAvg updated in place

Safety: this rewrites a 880KB site file, so it refuses to touch index.html
unless the pull passes every sanity check below. A bad or partial ESPN
response leaves the site exactly as it was.

Usage:
    pip install requests
    python espn_adp_pull.py            # update index.html
    python espn_adp_pull.py --dry-run  # report only, write nothing
"""

import json
import re
import sys
from datetime import datetime, timezone

import requests

LEAGUE_ID = 1480327482
SEASON = 2026
BASE = (f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/"
        f"seasons/{SEASON}/segments/0/leagues/{LEAGUE_ID}")

POSITION_BY_ID = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST"}

# ---- sanity thresholds: the pull must clear all of these ----
MIN_PLAYERS_RETURNED = 300   # ESPN should hand back a full board
MIN_MATCHED = 200            # how many must map onto our pool
MAX_ADP = 400                # anything beyond this is nonsense
DRAFTED_CAP = 300            # ESPN marks undrafted players with a huge ADP


def fetch_adp():
    """Pull the player board with ownership/ADP attached."""
    headers = {
        "X-Fantasy-Filter": json.dumps({
            "players": {
                "limit": 1000,
                "sortPercOwned": {"sortPriority": 1, "sortAsc": False},
            }
        }),
        "User-Agent": "big12-league-hub/1.0",
    }
    resp = requests.get(BASE, params={"view": "kona_player_info"},
                        headers=headers, timeout=30)
    if resp.status_code != 200:
        print(f"ERROR: HTTP {resp.status_code}", file=sys.stderr)
        print(resp.text[:400], file=sys.stderr)
        sys.exit(1)

    data = resp.json()
    players = data.get("players")
    if not players:
        print("ERROR: response had no 'players' array — ESPN may have changed "
              "the view name or the filter header.", file=sys.stderr)
        print("top-level keys:", list(data.keys())[:20], file=sys.stderr)
        sys.exit(1)

    out = []
    for entry in players:
        p = entry.get("player", {}) or {}
        own = p.get("ownership") or {}
        adp = own.get("averageDraftPosition")
        if adp is None or adp <= 0:
            continue
        out.append({
            "playerId": p.get("id"),
            "name": p.get("fullName"),
            "pos": POSITION_BY_ID.get(p.get("defaultPositionId"), "?"),
            "adp": round(float(adp), 1),
            "percentOwned": round(float(own.get("percentOwned") or 0), 1),
        })
    out.sort(key=lambda x: x["adp"])
    return out


SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b")


def norm(name):
    n = (name or "").lower().replace(".", "").replace("'", "")
    n = SUFFIX.sub("", n)
    return re.sub(r"[^a-z]", "", n)


def load_players(html):
    tok = "const PLAYERS_DATA = "
    i = html.index(tok + "[")
    j = html.index("\n];", i)
    return json.loads(html[i + len(tok):j + 2]), i, j


def main():
    dry = "--dry-run" in sys.argv

    adp_rows = fetch_adp()
    print(f"ESPN returned {len(adp_rows)} players carrying an ADP")
    if len(adp_rows) < MIN_PLAYERS_RETURNED:
        print(f"ABORT: expected at least {MIN_PLAYERS_RETURNED}.", file=sys.stderr)
        sys.exit(1)

    with open("espn_adp.json", "w") as f:
        json.dump({"pulledAt": datetime.now(timezone.utc).isoformat(),
                   "season": SEASON, "players": adp_rows}, f, indent=2)
    print("wrote espn_adp.json")

    html = open("index.html", encoding="utf-8").read()
    players, start, end = load_players(html)

    by_key = {}
    for r in adp_rows:
        by_key.setdefault((norm(r["name"]), r["pos"]), r)

    matched = 0
    for p in players:
        # K and DST keep their hand-set bottom-of-board ranks on purpose:
        # ESPN's kicker ADP (~pick 86) reflects their default roster rules and
        # would drag every kicker into round 11 of a 16-round league.
        if p["pos"] in ("K", "DST"):
            continue
        hit = by_key.get((norm(p["name"]), p["pos"]))
        if not hit:
            continue
        p["adpAvg"] = hit["adp"]
        p["espnAvgPick"] = hit["adp"]
        p["adpSource"] = "espn-live"
        p["adpCapped"] = hit["adp"] >= DRAFTED_CAP
        matched += 1

    print(f"matched {matched} skill players onto the pool")
    if matched < MIN_MATCHED:
        print(f"ABORT: only {matched} matched, expected {MIN_MATCHED}+. "
              f"index.html left untouched.", file=sys.stderr)
        sys.exit(1)

    live = [p for p in players if p.get("adpSource") == "espn-live"]
    bad = [p for p in live if not (0 < p["adpAvg"] <= MAX_ADP)]
    if bad:
        print(f"ABORT: {len(bad)} players have an implausible ADP "
              f"(e.g. {bad[0]['name']} = {bad[0]['adpAvg']}).", file=sys.stderr)
        sys.exit(1)

    # Re-rank: skill players by live ADP, then K/DST left where they were.
    skill = sorted([p for p in players if p["pos"] not in ("K", "DST")],
                   key=lambda p: (p.get("adpAvg") or 9999))
    bottom = sorted([p for p in players if p["pos"] in ("K", "DST")],
                    key=lambda p: p["adpRank"])
    rank = 0
    for p in skill:
        rank += 1
        p["adpRank"] = rank
    for p in bottom:
        rank += 1
        p["adpRank"] = rank

    players = skill + bottom
    pos_count = {}
    for p in players:
        pos_count[p["pos"]] = pos_count.get(p["pos"], 0) + 1
        p["posRank"] = pos_count[p["pos"]]

    top = players[:5]
    print("new top of board: " + ", ".join(f"{p['name']} ({p['adpAvg']})" for p in top))

    if dry:
        print("\n--dry-run: index.html NOT modified")
        return

    new_html = (html[:start] + "const PLAYERS_DATA = "
                + json.dumps(players, indent=1) + ";" + html[end + 3:])
    open("index.html", "w", encoding="utf-8").write(new_html)
    print(f"index.html updated ({len(players)} players)")


if __name__ == "__main__":
    main()
