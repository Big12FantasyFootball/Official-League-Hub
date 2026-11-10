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
import time
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


# ---------------------------------------------------------------------------
# WHY THERE IS A BROWSER USER-AGENT HERE
#
# Every scheduled run of this script failed from 2026-10-13 onward — around
# forty consecutive failures — while the exact same endpoint kept answering
# fine from a browser. The CI job was healthy (checkout, setup-python and pip
# all green); only the `python espn_pull.py` step failed, and the projections
# script failed the same way at the same time.
#
# The one thing both scripts had in common was a non-browser User-Agent: this
# one sent requests' default `python-requests/2.x`, the other sent
# `big12-league-hub/1.0`. ESPN's fantasy endpoints are known to reject
# non-browser agents, and that fits every symptom.
#
# Being straight about it: the Actions logs need repo auth to read, so this
# was not confirmed from the error text. That is exactly why the retry and
# diagnosis below exist — the next failure should name its own cause in the
# log instead of needing to be deduced from the outside.
# ---------------------------------------------------------------------------
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

BASE_HEADERS = {
    "User-Agent": BROWSER_UA,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://fantasy.espn.com/",
    "X-Requested-With": "XMLHttpRequest",
}


def _diagnose(status, body):
    """Turn an HTTP status into something actionable in the Actions log."""
    if status in (401, 403):
        if "LEAGUE_NOT_VISIBLE" in body or "AUTH" in body.upper():
            return ("The league is no longer publicly viewable. Either flip\n"
                    "  ESPN League Settings > Basic Settings > 'Make League Viewable to\n"
                    "  Public' back to Yes, or set the ESPN_S2 and SWID repo secrets and\n"
                    "  uncomment the COOKIES block in this file.")
        return ("ESPN refused the request outright. Most often this is agent or\n"
                "  IP filtering rather than anything about the league. The request\n"
                "  already sends a browser User-Agent; if this persists, the runner's\n"
                "  datacenter IP range is the next suspect and the pull would need to\n"
                "  move somewhere with a residential IP.")
    if status == 404:
        return "League or season not found — check LEAGUE_ID and SEASON at the top."
    if status == 429:
        return "Rate limited. The backoff below should normally absorb this."
    if 500 <= status < 600:
        return "ESPN server-side error. Usually transient; the next scheduled run may succeed."
    return "Unexpected status. The response body above is the best clue."


def _get(url, params=None, headers=None, timeout=20, attempts=4):
    """
    GET with a browser-like UA and exponential backoff.

    Retries network blips, 429s and 5xx. Does NOT retry 401/403/404 — those
    are settings or identity problems and hammering them just burns minutes
    and buries the real message.
    """
    hdrs = dict(BASE_HEADERS)
    if headers:
        hdrs.update(headers)
    last = ""
    for attempt in range(1, attempts + 1):
        try:
            resp = requests.get(url, params=params, headers=hdrs,
                                cookies=COOKIES, timeout=timeout)
        except requests.RequestException as exc:
            last = f"{type(exc).__name__}: {exc}"
        else:
            if resp.status_code == 200:
                if attempt > 1:
                    print(f"  recovered on attempt {attempt}", file=sys.stderr)
                return resp
            body = resp.text[:600]
            last = f"HTTP {resp.status_code}"
            if resp.status_code in (401, 403, 404):
                print(f"ERROR: {last}", file=sys.stderr)
                print(body, file=sys.stderr)
                print("\nDIAGNOSIS:\n  " + _diagnose(resp.status_code, body), file=sys.stderr)
                sys.exit(1)
        if attempt < attempts:
            wait = 3 * (2 ** (attempt - 1))       # 3s, 6s, 12s
            print(f"  attempt {attempt}/{attempts} failed ({last}) — retrying in {wait}s",
                  file=sys.stderr)
            time.sleep(wait)
    print(f"ERROR: giving up after {attempts} attempts. Last failure: {last}",
          file=sys.stderr)
    print("\nDIAGNOSIS:\n  Could not reach ESPN at all. If this is a one-off the next\n"
          "  scheduled run will clear it; if it repeats, the endpoint or the\n"
          "  runner's network path has changed.", file=sys.stderr)
    sys.exit(1)


def fetch_league():
    params = [("view", v) for v in VIEWS]
    resp = _get(BASE, params=params)
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

        # ESPN's own live projected final score for each team. This is far more
        # useful than raw points mid-week: with only one game played, actual
        # points rank whoever happened to have a Thursday player first, while
        # the projection ranks by where the week is actually heading. It is
        # opponent-adjusted and injury-aware, and it converges to the real
        # score as games finish.
        def proj(side):
            if not side:
                return None
            v = side.get("totalProjectedPointsLive")
            if v is None:
                v = side.get("totalProjectedPoints")
            return round(float(v), 2) if v is not None else None

        def live(side):
            if not side:
                return None
            v = side.get("totalPointsLive")
            if v is None:
                v = side.get("totalPoints", 0)
            return round(float(v or 0), 2)

        out.append({
            "matchupPeriodId": m.get("matchupPeriodId"),
            "homeTeamId": home.get("teamId"),
            "homeScore": home.get("totalPoints", 0),
            "homeLive": live(home),
            "homeProjected": proj(home),
            "awayTeamId": away.get("teamId"),
            "awayScore": away.get("totalPoints", 0) if away else None,
            "awayLive": live(away),
            "awayProjected": proj(away),
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


def parse_full_schedule(data):
    """
    EVERY regular-season fixture, played or not.

    parse_season_matchups() deliberately drops undecided games, and
    parse_matchups() only keeps the current week — so between them the
    snapshot contained no record of who anyone plays NEXT. Strength of
    schedule needs exactly that: without it the "rest of season" column
    silently collapsed to "this week only" whenever the page was rendering
    from the committed file rather than a live browser poll.

    Scores are omitted on purpose; this is a fixture list, not results.
    Playoff and consolation tiers are excluded because those opponents are
    not knowable in advance.
    """
    out = []
    for m in data.get("schedule", []):
        if (m.get("playoffTierType") or "NONE") != "NONE":
            continue
        home = m.get("home", {}) or {}
        away = m.get("away", {}) or {}
        if home.get("teamId") is None or away.get("teamId") is None:
            continue
        out.append({
            "matchupPeriodId": m.get("matchupPeriodId"),
            "homeTeamId": home.get("teamId"),
            "awayTeamId": away.get("teamId"),
            "homeScore": round(float(home.get("totalPoints") or 0), 2),
            "awayScore": round(float(away.get("totalPoints") or 0), 2),
            "winner": m.get("winner", "UNDECIDED"),
            "playoffTierType": "NONE",
        })
    out.sort(key=lambda x: (x["matchupPeriodId"] or 0, x["homeTeamId"] or 0))
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
        "fullSchedule": parse_full_schedule(data),
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
