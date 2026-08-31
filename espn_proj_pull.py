#!/usr/bin/env python3
"""
ESPN live projections -> espn_projections.json

Replaces the hand-imported FantasyPros CSVs with a live pull of ESPN's own
season projections. Two reasons this is strictly better:

  1. ESPN's `appliedTotal` is already scored with THIS league's exact rules
     (PPR, bonuses, the lot), so no scoring conversion is needed or possible
     to get wrong.
  2. It updates continuously. A player who tears an ACL drops to 0 the same
     day, instead of the site carrying a preseason number all season.

Unlike espn_adp_pull.py this does NOT rewrite index.html. It writes a small
sidecar JSON that the page overlays onto PLAYERS_DATA at load time, so this
can run daily without churning a 900KB file through git every morning.

The stat row we want is statSourceId=1 (projected), statSplitTypeId=0
(full season), scoringPeriodId=0, for the current season. ESPN also returns
statSourceId=0 (actual) and per-week projections; those are ignored here.

Usage:
    pip install requests
    python espn_proj_pull.py
    python espn_proj_pull.py --dry-run
"""

import json
import sys
from datetime import datetime, timezone

import requests

LEAGUE_ID = 1480327482
SEASON = 2026
BASE = (f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/"
        f"seasons/{SEASON}/segments/0/leagues/{LEAGUE_ID}")

POSITION_BY_ID = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST"}
PRO_TEAM_BY_ID = {
    0: "FA", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL",
    7: "DEN", 8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV",
    14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG",
    20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF",
    26: "SEA", 27: "TB", 28: "WSH", 29: "CAR", 30: "JAX", 33: "BAL",
    34: "HOU",
}

# ---- sanity thresholds: a bad pull must not overwrite good data ----
MIN_RETURNED = 400      # ESPN should hand back a full board
MIN_WITH_PROJ = 250     # how many must actually carry a season projection
MAX_WEEKLY = 40.0       # nobody projects above this per week; guards unit errors
GAMES = 17


def fetch_players():
    headers = {
        "X-Fantasy-Filter": json.dumps({
            "players": {
                "limit": 900,
                "sortPercOwned": {"sortPriority": 1, "sortAsc": False},
            }
        }),
        "User-Agent": "big12-league-hub/1.0",
    }
    resp = requests.get(BASE, params={"view": "kona_player_info"},
                        headers=headers, timeout=45)
    if resp.status_code != 200:
        print(f"ERROR: HTTP {resp.status_code}", file=sys.stderr)
        print(resp.text[:400], file=sys.stderr)
        sys.exit(1)

    data = resp.json()
    players = data.get("players")
    if not players:
        print("ERROR: response carried no 'players' array — ESPN may have "
              "changed the view name or the filter header.", file=sys.stderr)
        print("top-level keys:", list(data.keys())[:20], file=sys.stderr)
        sys.exit(1)
    return players


def season_projection(player):
    """The full-season projected total for the current season, or None."""
    for s in player.get("stats", []) or []:
        if (s.get("seasonId") == SEASON
                and s.get("statSourceId") == 1        # projected, not actual
                and s.get("statSplitTypeId") == 0     # whole season
                and s.get("scoringPeriodId") == 0):
            total = s.get("appliedTotal")
            if total is None:
                return None
            avg = s.get("appliedAverage")
            weekly = avg if avg is not None else total / GAMES
            return round(float(total), 2), round(float(weekly), 3)
    return None


def main():
    dry = "--dry-run" in sys.argv

    players = fetch_players()
    print(f"ESPN returned {len(players)} players")
    if len(players) < MIN_RETURNED:
        print(f"ABORT: expected at least {MIN_RETURNED}.", file=sys.stderr)
        sys.exit(1)

    rows = []
    for entry in players:
        p = entry.get("player", {}) or {}
        proj = season_projection(p)
        if proj is None:
            continue
        total, weekly = proj
        rows.append({
            "playerId": p.get("id"),
            "name": p.get("fullName"),
            "pos": POSITION_BY_ID.get(p.get("defaultPositionId"), "?"),
            "proTeam": PRO_TEAM_BY_ID.get(p.get("proTeamId"), ""),
            "seasonProj": total,
            "weekly": weekly,
            "injuryStatus": p.get("injuryStatus"),
        })

    print(f"{len(rows)} carry a {SEASON} season projection")
    if len(rows) < MIN_WITH_PROJ:
        print(f"ABORT: only {len(rows)} had projections, expected "
              f"{MIN_WITH_PROJ}+. Nothing written.", file=sys.stderr)
        sys.exit(1)

    # A unit slip (season total landing in the weekly field) would quietly
    # wreck every projection on the site, so check the ceiling explicitly.
    bad = [r for r in rows if not (0 <= r["weekly"] <= MAX_WEEKLY)]
    if bad:
        print(f"ABORT: {len(bad)} implausible weekly projections "
              f"(e.g. {bad[0]['name']} = {bad[0]['weekly']}).", file=sys.stderr)
        sys.exit(1)

    rows.sort(key=lambda r: -r["weekly"])
    top = ", ".join(f"{r['name']} {r['weekly']}" for r in rows[:5])
    print("top of the board: " + top)
    zeroed = [r for r in rows if r["weekly"] == 0]
    print(f"{len(zeroed)} players project 0 (out / IR / free agents)")

    payload = {
        "pulledAt": datetime.now(timezone.utc).isoformat(),
        "season": SEASON,
        "source": "espn-kona_player_info",
        "scoring": "league-applied",   # already scored with this league's rules
        "count": len(rows),
        "players": rows,
    }

    if dry:
        print("\n--dry-run: espn_projections.json NOT written")
        return

    with open("espn_projections.json", "w") as f:
        json.dump(payload, f, indent=1)
    print(f"wrote espn_projections.json ({len(rows)} players)")


if __name__ == "__main__":
    main()
