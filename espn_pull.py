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
VIEWS = ["mSettings", "mTeam", "mRoster", "mMatchupScore", "mDraftDetail"]

# ESPN encodes positions and pro teams as ints. Small lookup tables so the
# site can render "RB - DET" without a second API call.
POSITION_BY_ID = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST"}
PRO_TEAM_BY_ID = {
    0: "FA", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN",
    8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA",
    16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI",
    23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR",
    30: "JAX", 33: "BAL", 34: "HOU",
}
# Which lineup slots are actual starters (vs bench/IR) in this league.
BENCH_SLOT_IDS = {20, 21}  # 20 = bench, 21 = IR


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
    """Pull just this week's matchups (for a 'what's live right now' view)."""
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


def parse_season_matchups(data):
    """
    Pull EVERY completed matchup so far this season (all weeks, not just
    current). Critical for two things: Elo needs the full season-to-date
    history to accumulate correctly (not just whatever week happens to be
    'current' the day this runs), and the Hawkins Cup needs Week 1 specifically
    preserved permanently as the qualification basis, even after later weeks
    make Week 1 no longer 'current'. Without this, both would silently lose
    data every time the season advances a week.
    """
    schedule = data.get("schedule", [])
    out = []
    for m in schedule:
        winner = m.get("winner", "UNDECIDED")
        if winner == "UNDECIDED":
            continue  # hasn't been played yet — nothing to record
        home = m.get("home", {})
        away = m.get("away", {})
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


def parse_rosters(data):
    """Map teamId -> rostered players, with enough detail to render a roster page."""
    teams = data.get("teams", [])
    out = {}
    for t in teams:
        entries = t.get("roster", {}).get("entries", [])
        players = []
        for e in entries:
            pool_entry = e.get("playerPoolEntry", {})
            player = pool_entry.get("player", {})
            slot_id = e.get("lineupSlotId")
            players.append({
                "playerId": player.get("id"),
                "name": player.get("fullName"),
                "pos": POSITION_BY_ID.get(player.get("defaultPositionId"), "?"),
                "proTeam": PRO_TEAM_BY_ID.get(player.get("proTeamId"), ""),
                "lineupSlotId": slot_id,
                "starter": slot_id is not None and slot_id not in BENCH_SLOT_IDS,
                "injuryStatus": player.get("injuryStatus"),
                "appliedTotal": round(pool_entry.get("appliedStatTotal", 0) or 0, 2),
            })
        out[t.get("id")] = players
    return out


def parse_draft(data, rosters):
    """
    Pick-by-pick draft results. ESPN returns only playerId here, so names are
    resolved from the roster payload (which does carry them). A player drafted
    and later dropped won't resolve — those keep the id and a null name rather
    than being silently omitted.
    """
    detail = data.get("draftDetail", {}) or {}
    if not detail.get("drafted"):
        return []

    name_by_id = {}
    for team_players in rosters.values():
        for pl in team_players:
            if pl.get("playerId") is not None:
                name_by_id[pl["playerId"]] = pl

    out = []
    for pick in detail.get("picks", []) or []:
        pid = pick.get("playerId")
        info = name_by_id.get(pid, {})
        out.append({
            "overallPickNumber": pick.get("overallPickNumber"),
            "round": pick.get("roundId"),
            "roundPickNumber": pick.get("roundPickNumber"),
            "teamId": pick.get("teamId"),
            "playerId": pid,
            "name": info.get("name"),
            "pos": info.get("pos"),
            "proTeam": info.get("proTeam"),
            "keeper": bool(pick.get("keeper", False)),
        })
    out.sort(key=lambda x: x["overallPickNumber"] or 0)
    return out


def main():
    data = fetch_league()
    rosters = parse_rosters(data)

    result = {
        "pulledAt": datetime.now(timezone.utc).isoformat(),
        "leagueId": LEAGUE_ID,
        "season": SEASON,
        "currentMatchupPeriod": data.get("status", {}).get("currentMatchupPeriod"),
        "draftCompleted": data.get("draftDetail", {}).get("drafted", False),
        "standings": parse_standings(data),
        "currentWeekMatchups": parse_matchups(data),
        "seasonMatchups": parse_season_matchups(data),
        "rosters": rosters,
        "draftPicks": parse_draft(data, rosters),
    }

    with open("espn_data.json", "w") as f:
        json.dump(result, f, indent=2)

    print(f"Wrote espn_data.json — {len(result['standings'])} teams, "
          f"matchup period {result['currentMatchupPeriod']}, "
          f"draft completed: {result['draftCompleted']}, "
          f"draft picks: {len(result['draftPicks'])}")


if __name__ == "__main__":
    main()
