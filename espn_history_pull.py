#!/usr/bin/env python3
"""
ESPN Fantasy Football HISTORY pull — 2026 Big 12 fantasy (leagueId 1480327482)

One-time (or occasional) backfill of completed seasons (2024, 2025) so the
site can seed Manager Elo with real history instead of starting everyone
flat in 2026. Unlike espn_pull.py, this does NOT need to run daily — past
seasons don't change. Run it once now, and again only if you add more
manager/season history later.

Reads ESPN_S2 / ESPN_SWID from environment variables (set as GitHub Actions
secrets — never hardcode real cookie values in this file).

Usage:
    pip install requests
    ESPN_S2=... ESPN_SWID=... python espn_history_pull.py
"""

import json
import os
import sys

import requests

LEAGUE_ID = 1480327482
SEASONS = [2024, 2025]  # completed seasons per ESPN's `previousSeasons` field
VIEWS = ["mTeam", "mMatchupScore"]

COOKIES = {
    "espn_s2": os.environ.get("ESPN_S2", ""),
    "SWID": os.environ.get("ESPN_SWID", ""),
}


def fetch_season(season):
    base = f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{LEAGUE_ID}"
    params = [("view", v) for v in VIEWS]
    resp = requests.get(base, params=params, cookies=COOKIES, timeout=15)
    if resp.status_code != 200:
        print(f"ERROR season {season}: HTTP {resp.status_code}", file=sys.stderr)
        print(resp.text[:500], file=sys.stderr)
        return None
    data = resp.json()
    if "messages" in data:
        print(f"ERROR season {season} from ESPN API:", data["messages"], file=sys.stderr)
        return None
    return data


def parse_standings(data):
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
            "finalPlace": t.get("rankCalculatedFinal") or t.get("playoffSeed"),
        })
    out.sort(key=lambda x: (-x["wins"], -x["pointsFor"]))
    return out


def parse_all_matchups(data):
    schedule = data.get("schedule", [])
    out = []
    for m in schedule:
        home = m.get("home", {})
        away = m.get("away", {})
        winner = m.get("winner", "UNDECIDED")
        if winner == "UNDECIDED":
            continue
        out.append({
            "matchupPeriodId": m.get("matchupPeriodId"),
            "homeTeamId": home.get("teamId"),
            "homeScore": home.get("totalPoints", 0),
            "awayTeamId": away.get("teamId"),
            "awayScore": away.get("totalPoints", 0) if away else None,
            "winner": winner,
            "playoffTierType": m.get("playoffTierType", "NONE"),
        })
    out.sort(key=lambda x: x["matchupPeriodId"])
    return out


def main():
    if not COOKIES["espn_s2"] or not COOKIES["SWID"]:
        print("ERROR: ESPN_S2 / ESPN_SWID environment variables not set.", file=sys.stderr)
        sys.exit(1)

    result = {"seasons": {}}
    for season in SEASONS:
        data = fetch_season(season)
        if data is None:
            continue
        result["seasons"][str(season)] = {
            "finalStandings": parse_standings(data),
            "allMatchups": parse_all_matchups(data),
        }
        print(f"Season {season}: {len(result['seasons'][str(season)]['finalStandings'])} teams, "
              f"{len(result['seasons'][str(season)]['allMatchups'])} completed matchups")

    with open("espn_history.json", "w") as f:
        json.dump(result, f, indent=2)

    print("Wrote espn_history.json")


if __name__ == "__main__":
    main()
