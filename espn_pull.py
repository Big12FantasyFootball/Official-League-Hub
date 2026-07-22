#!/usr/bin/env python3
"""
ESPN Fantasy Football data pull — 2026 Big 12 fantasy (leagueId 1480327482)

Pulls standings, current-week matchups/scores, and rosters from ESPN's
public (undocumented) league API and writes clean JSON to espn_data.json.

Requires no auth as long as the league stays set to "Make League Viewable
to Public: Yes" in ESPN League Settings > Basic Settings.

If you ever flip that back to private, this script will start failing with
AUTH_LEAGUE_NOT_VISIBLE — at that point you'd add ESPN_S2 / SWID cookies
(see the commented-out block below) rather than rewriting anything else.

Usage:
    pip install requests
    python espn_pull.py

Run it on a schedule (Task Scheduler on Windows, cron on Mac/Linux, or a
GitHub Actions workflow) to keep espn_data.json current. This script does
NOT try to reach espn.com from a sandboxed/cloud dev environment that
blocks outbound traffic to espn.com — run it somewhere with normal
internet access (your own machine, or a CI runner).
"""

import json
import sys
from datetime import datetime, timezone

import requests

LEAGUE_ID = 1480327482
SEASON = 2026
BASE = f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{SEASON}/segments/0/leagues/{LEAGUE_ID}"

# --- If the league ever goes private, uncomment and fill these in ---
# ESPN_S2 = "PASTE_YOUR_ESPN_S2_VALUE_HERE"
# SWID = "{PASTE-YOUR-SWID-VALUE-HERE}"
# COOKIES = {"espn_s2": ESPN_S2, "SWID": SWID}
COOKIES = {}

# Views: mSettings = league config, mTeam = standings/team info,
# mRoster = rosters, mMatchupScore = weekly matchups & scores
VIEWS = ["mSettings", "mTeam", "mRoster", "mMatchupScore"]


def fetch_league():
    params = [("view", v) for v in VIEWS]
    resp = requests.get(BASE, params=params, cookies=COOKIES, timeout=15)
    if resp.status_code != 200:
        print(f"ERROR: HTTP {resp.status_code}", file=sys.stderr)
        print(resp.text[:500], file=sys.stderr)
        sys.exit(1)
    data = resp.json()
    if "messages" in data:
        print("ERROR from ESPN API:", data["messages"], file=sys.stderr)
        sys.exit(1)
    return data


def parse_standings(data):
    """Turn raw `teams` array into a clean list, sorted by record."""
    teams = data.get("teams", [])
    out = []
    for t in teams:
        record = t.get("record", {}).get("overall", {})
        out.append({
            "teamId": t.get("id"),
            "name": f"{t.get('location', '').strip()} {t.get('nickname', '').strip()}".strip()
                    or t.get("name", f"Team {t.get('id')}"),
            "abbrev": t.get("abbrev"),
            "wins": record.get("wins", 0),
            "losses": record.get("losses", 0),
            "ties": record.get("ties", 0),
            "pointsFor": t.get("points", 0),
            "pointsAgainst": t.get("pointsAgainst", 0),
            "divisionId": t.get("divisionId"),
            "playoffSeed": t.get("playoffSeed"),
        })
    out.sort(key=lambda x: (-x["wins"], -x["pointsFor"]))
    return out


def parse_matchups(data, current_period=None):
    """Pull this week's (or all) matchups with scores."""
    schedule = data.get("schedule", [])
    if current_period is None:
        current_period = data.get("status", {}).get("currentMatchupPeriod", 1)

    out = []
    for m in schedule:
        if m.get("matchupPeriodId") != current_period:
            continue
        home = m.get("home", {})
        away = m.get("away", {})
        out.append({
            "matchupPeriodId": m.get("matchupPeriodId"),
            "homeTeamId": home.get("teamId"),
            "homeScore": home.get("totalPoints", 0),
            "awayTeamId": away.get("teamId"),
            "awayScore": away.get("totalPoints", 0) if away else None,
            "winner": m.get("winner"),  # "HOME", "AWAY", "UNDECIDED"
            "playoffTierType": m.get("playoffTierType", "NONE"),
        })
    return out


def parse_rosters(data):
    """Map teamId -> list of player names/positions currently rostered."""
    teams = data.get("teams", [])
    out = {}
    for t in teams:
        entries = t.get("roster", {}).get("entries", [])
        players = []
        for e in entries:
            pool_entry = e.get("playerPoolEntry", {})
            player = pool_entry.get("player", {})
            players.append({
                "name": player.get("fullName"),
                "proTeamId": player.get("proTeamId"),
                "lineupSlotId": e.get("lineupSlotId"),
                "injuryStatus": player.get("injuryStatus"),
            })
        out[t.get("id")] = players
    return out


def main():
    data = fetch_league()

    result = {
        "pulledAt": datetime.now(timezone.utc).isoformat(),
        "leagueId": LEAGUE_ID,
        "season": SEASON,
        "currentMatchupPeriod": data.get("status", {}).get("currentMatchupPeriod"),
        "draftCompleted": data.get("draftDetail", {}).get("drafted", False),
        "standings": parse_standings(data),
        "currentWeekMatchups": parse_matchups(data),
        "rosters": parse_rosters(data),
    }

    with open("espn_data.json", "w") as f:
        json.dump(result, f, indent=2)

    print(f"Wrote espn_data.json — {len(result['standings'])} teams, "
          f"matchup period {result['currentMatchupPeriod']}, "
          f"draft completed: {result['draftCompleted']}")


if __name__ == "__main__":
    main()
