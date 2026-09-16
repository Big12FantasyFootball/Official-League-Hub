/*
 * Live data loader — Big 12 Fantasy Football
 *
 * Fetches espn_data.json (daily live pull) + espn_history.json (2024/2025
 * backfill) from the same GitHub Pages origin, runs them through elo.js,
 * and exposes everything on window.B12Live for the rest of the site to
 * render from. Load this AFTER elo.js:
 *
 *   <script src="elo.js"></script>
 *   <script src="data.js"></script>
 *
 * TEAM_MANAGER_MAP below maps ESPN's real teamId -> the manager's real
 * name, since ESPN's API only gives us the fantasy TEAM name (e.g. "Curse
 * of Ra"), not the person's name. A few are filled in based on obvious
 * naming patterns and the existing site copy — the rest say "TODO: verify"
 * and need you to fill them in once. This only needs to happen a single
 * time; it doesn't change week to week.
 */

const TEAM_MANAGER_MAP = {
  1:  { manager: "Nick Carullo", team: "Drake London and Friends" }, // confirmed — matches ESPN league Creator field
  2:  { manager: "Drew Sanford", team: "Flat Foot" },                 // confirmed — new for 2026; Dillon Jacobs (2024 champion) owned this slot through 2025, departed
  3:  { manager: "Jake Joyce", team: "Seal Team Nix" },              // confirmed — rebranded from "Hawk Tua" in 2024, same manager
  4:  { manager: "Josh Sweeney", team: "Josh's Scary Team" },        // full name per the site's own LEAGUE_CONFIG
  5:  { manager: "Joseph Lisa", team: "Team Lisa" },                 // full name per the site's own LEAGUE_CONFIG
  6:  { manager: "Jalen Peretz", team: "Bourne with Downs" },        // confirmed — rebranded from "Jalen's Team" in 2024, same manager
  7:  { manager: "Aidan Goss", team: "Aidan's Astounding Team" },    // confirmed — new for 2026; Timmy Hoffman owned this slot through 2025, departed
  8:  { manager: "Nick Hawkins", team: "Curse of Ra" },              // confirmed — league supervisor/namesake
  9:  { manager: "Nick Furnari", team: "Nick's Nitty Team" },        // matches the site's own LEAGUE_CONFIG
  10: { manager: "Brandon Beland", team: "Brandon's Brilliant Team" }, // confirmed — new for 2026; Braden Lord ("BLORD") owned this slot through 2025, departed
  11: { manager: "Jojo Guarnaccia", team: "Fortnite Grinder" },      // confirmed — matches existing mgr-tbl row
  12: { manager: "Ryan Dann", team: "Team Dann" },                   // full name per the site's own LEAGUE_CONFIG
};

/*
 * These names must match the manager names printed in the site's static
 * historical tables (#mgr-tbl .mn2) exactly. renderEloColumn() joins the
 * live Elo ratings onto those rows BY NAME, so a first-name-only entry
 * silently leaves that manager's Elo cell blank — and the same name is
 * what shows up in League Records and the Hawkins Cup bracket.
 */

/*
 * ESPN reassigns the same teamId slot to whoever currently owns it. A
 * changed abbreviation is a USEFUL SIGNAL but not proof by itself — teams 3
 * and 6 both looked like manager changes (abbrev changed between 2024 and
 * 2025) but were actually the same people (Jake Joyce, Jalen) rebranding
 * their team names/abbreviations. Confirmed manager changes only:
 *   team 2: DDT (2024-25) -> FFB (2026)  — new manager (Flat Foot) starting 2026, confirmed
 *   team 7: Th (2024-25) -> AAT (2026)   — new manager (Aidan Goss) starting 2026, confirmed
 *   team 10: BL (2024-25) -> BBT (2026)  — new manager (Brandon Beland) starting 2026, confirmed
 *
 * Everyone else (1, 3, 4, 5, 6, 8, 9, 11, 12) has confirmed continuous
 * 2024-2026 history under one real manager. Lesson learned: don't trust
 * the abbreviation heuristic alone — verify with the actual league before
 * resetting anyone's history.
 */
const MANAGER_START_SEASON = {
  2: 2026,
  7: 2026,
  10: 2026,
};

// Real names of the departed managers who owned these slots before the
// current occupant. Needed anywhere historical (pre-handoff) games get
// displayed with a name attached — e.g. league records — so a blowout
// Timmy Hoffman lost in 2025 doesn't get mislabeled as Aidan Goss's.
const DEPARTED_MANAGERS = {
  2: "Dillon Jacobs",
  7: "Timmy Hoffman",
  10: "Braden Lord",
};

// Season-aware name resolver: a team's real name depends on WHEN the game
// was played, not just which teamId slot it was. Use this (not a flat
// teamId -> name map) anywhere you're labeling a specific historical match.
function managerNameAt(teamId, season) {
  const handoffSeason = MANAGER_START_SEASON[teamId];
  if (handoffSeason != null && season < handoffSeason) {
    return DEPARTED_MANAGERS[teamId] || `Team ${teamId} (former manager)`;
  }
  const info = TEAM_MANAGER_MAP[teamId];
  return info ? info.manager : `Team ${teamId}`;
}

async function loadJSON(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${path}: HTTP ${res.status}`);
  return res.json();
}

async function loadB12Live() {
  const [liveData, historyData] = await Promise.all([
    loadJSON("espn_data.json"),
    loadJSON("espn_history.json").catch(() => ({ seasons: {} })), // ok if missing early on
  ]);

  const matches = buildMatchListFromEspnFiles(historyData, liveData);
  const { ratings, history, departedRatings, departedHistory } = computeElo(matches, {
    resetSeasons: MANAGER_START_SEASON,
    currentSeason: liveData.season, // 2026 — ensures preseason new-managers show 1500, not a predecessor's rating
  });

  // Merge everything into one convenient array, sorted by current Elo desc.
  const managers = Object.keys(TEAM_MANAGER_MAP).map((teamIdStr) => {
    const teamId = Number(teamIdStr);
    const info = TEAM_MANAGER_MAP[teamId];
    const standing = (liveData.standings || []).find((s) => s.teamId === teamId) || {};
    return {
      teamId,
      manager: info.manager,
      team: info.team,
      managerSince: MANAGER_START_SEASON[teamId] || 2024,
      departed: false,
      wins: standing.wins ?? 0,
      losses: standing.losses ?? 0,
      ties: standing.ties ?? 0,
      pointsFor: standing.pointsFor ?? 0,
      pointsAgainst: standing.pointsAgainst ?? 0,
      elo: Math.round(ratings[teamId] ?? 1500),
      eloHistory: history[teamId] || [],
    };
  });

  // Departed managers (slots that got reassigned) get their own leaderboard
  // entries too, frozen at whatever their rating was the moment they left —
  // computeElo() snapshotted this into departedRatings/departedHistory right
  // before overwriting the slot for the incoming manager. Without this,
  // Dillon Jacobs/Timmy Hoffman/Braden Lord would just vanish from the board
  // even though their 2024-25 record is real and still on file.
  const departedManagers = Object.keys(DEPARTED_MANAGERS)
    .map(Number)
    .filter((teamId) => teamId in departedRatings)
    .map((teamId) => ({
      teamId,
      manager: DEPARTED_MANAGERS[teamId],
      team: `Formerly Team ${teamId}`,
      managerSince: null,
      departed: true,
      wins: null,
      losses: null,
      ties: null,
      pointsFor: null,
      pointsAgainst: null,
      elo: Math.round(departedRatings[teamId]),
      eloHistory: departedHistory[teamId] || [],
    }));

  const allManagers = managers.concat(departedManagers);
  allManagers.sort((a, b) => b.elo - a.elo);

  window.B12Live = {
    live: liveData,
    history: historyData,
    matches,
    ratings,
    eloHistory: history,
    departedRatings,
    departedHistory,
    managers: allManagers,
    managerNameAt, // (teamId, season) -> real name, correct even for departed managers
    pulledAt: liveData.pulledAt,
    draftCompleted: liveData.draftCompleted,
  };

  document.dispatchEvent(new CustomEvent("b12live:ready", { detail: window.B12Live }));
  return window.B12Live;
}

/*
 * Adds a live "Elo" column to the existing #mgr-tbl (Historical Manager
 * Stats table). Matches by the manager name already printed in each row's
 * .mn2 div, so it works against the table's real static markup without
 * needing to touch/replace any existing rows.
 */
function renderEloColumn(data) {
  const table = document.getElementById("mgr-tbl");
  if (!table) return; // table not on this page/panel — nothing to do

  const headRow = table.querySelector("thead tr");
  if (headRow && !headRow.querySelector('[data-elo-col]')) {
    const th = document.createElement("th");
    th.className = "r";
    th.dataset.type = "num";
    th.dataset.eloCol = "1";
    th.textContent = "Elo";
    headRow.appendChild(th);
  }

  const managerByName = {};
  for (const m of data.managers) managerByName[m.manager] = m;

  table.querySelectorAll("tbody tr").forEach((tr) => {
    if (tr.querySelector('[data-elo-cell]')) return; // already rendered
    const nameEl = tr.querySelector(".mn2");
    const name = nameEl ? nameEl.firstChild?.textContent?.trim() : null;
    const match = name ? managerByName[name] : null;

    const td = document.createElement("td");
    td.className = "r";
    td.dataset.eloCell = "1";
    td.textContent = match ? match.elo : "—";
    tr.appendChild(td);

    // keep the click-to-sort data-vals array in sync
    try {
      const vals = JSON.parse(tr.dataset.vals || "[]");
      vals.push(match ? String(match.elo) : "0");
      tr.dataset.vals = JSON.stringify(vals);
    } catch (e) {
      // static rows without data-vals just skip sort-sync silently
    }
  });
}

// Auto-run on page load. Listen for "b12live:ready" elsewhere to render
// once data's in, e.g.:
//   document.addEventListener('b12live:ready', (e) => renderEloColumn(e.detail));
/*
 * Standalone Elo leaderboard — its own visible section rather than just a
 * bolt-on column, since persistent Elo is a new marquee feature and
 * deserves to be seen without digging through the old stats table. Shows
 * rank, manager, team, current rating, and a week-over-week trend arrow
 * (comparing the two most recent entries in eloHistory). New-for-2026
 * managers get a NEW badge instead of a trend, since they have no prior
 * week to compare against yet. Departed managers (Dillon Jacobs, Timmy
 * Hoffman, Braden Lord) still show up ranked by their frozen final rating,
 * marked with a FORMER badge instead of a trend since they're not playing
 * any more games to trend from.
 */
function renderEloLeaderboard(data) {
  const el = document.getElementById("live-elo");
  if (!el) return;

  const rows = data.managers.map((m, i) => {
    const hist = m.eloHistory;
    const isNew = !m.departed && m.managerSince === 2026 && hist.length === 0;

    let trendHtml;
    if (m.departed) {
      trendHtml = '<span class="elo-badge-former">FORMER</span>';
    } else if (isNew) {
      trendHtml = '<span class="elo-badge-new">NEW</span>';
    } else if (hist.length >= 2) {
      const prev = hist[hist.length - 2].rating;
      const delta = m.elo - prev;
      if (delta > 0.5) trendHtml = `<span class="elo-trend-up">▲ ${Math.round(delta)}</span>`;
      else if (delta < -0.5) trendHtml = `<span class="elo-trend-down">▼ ${Math.round(Math.abs(delta))}</span>`;
      else trendHtml = '<span class="elo-trend-flat">–</span>';
    } else {
      trendHtml = '<span class="elo-trend-flat">–</span>';
    }

    const rowClass = m.departed ? "elo-row elo-row-departed" : "elo-row";

    return `<div class="${rowClass}">
      <span class="elo-rank">#${i + 1}</span>
      <span class="elo-name">${m.manager}<span class="elo-team">${m.team}</span></span>
      <span class="elo-rating">${m.elo}</span>
      <span class="elo-trend">${trendHtml}</span>
    </div>`;
  }).join("");

  el.innerHTML = `
    <div class="elo-header-row">
      <span>Rank</span><span>Manager</span><span>Elo</span><span>Trend</span>
    </div>
    ${rows}
  `;
}

/*
 * Live scoreboard — this week's real matchups straight from ESPN.
 * Shows a "when the season starts" note until there are games to display,
 * so the section exists on the page all preseason instead of appearing
 * from nowhere in September.
 */
function renderScoreboard(data) {
  /*
   * CURRENT week only — so this is the Schedule panel's board, and nothing
   * else. It used to also fill #week1-scoreboard on the Week 1 page, which
   * was correct for exactly as long as the current week WAS Week 1. The
   * moment ESPN rolled over to Week 2, the Week 1 tab started showing Week 2
   * scores under a "Live Week 1 Scoreboard" heading. #week1-scoreboard is now
   * a mount for renderWeek1Results(), which is pinned to Week 1 by design.
   */
  const targets = ["live-scoreboard"]
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  if (!targets.length) return;
  const el = { set innerHTML(v) { targets.forEach((t) => { t.innerHTML = v; }); } };

  const games = (data.live && data.live.currentWeekMatchups) || [];
  const played = games.filter((g) => (g.homeScore || 0) > 0 || (g.awayScore || 0) > 0);
  if (!games.length || !played.length) {
    const wk = (data.live && data.live.currentMatchupPeriod) || 1;
    el.innerHTML = '<p class="note" style="border:none;padding-left:0">'
      + `Scores appear here once Week ${wk} kicks off &mdash; they update automatically `
      + 'through Sunday and Monday night.</p>';
    return;
  }

  const week = data.live.currentMatchupPeriod;
  const nameAt = data.managerNameAt;
  const season = data.live.season;
  const rows = games.map((g) => {
    const home = nameAt(g.homeTeamId, season);
    const away = nameAt(g.awayTeamId, season);
    const hs = g.homeScore || 0, as = g.awayScore || 0;
    const decided = g.winner && g.winner !== "UNDECIDED";
    const homeWon = g.winner === "HOME", awayWon = g.winner === "AWAY";
    return `<div class="sb-row">
      <span class="sb-team${awayWon ? " sb-win" : ""}">${away}</span>
      <span class="sb-score${awayWon ? " sb-win" : ""}">${as.toFixed(2)}</span>
      <span class="sb-at">${decided ? "FINAL" : "vs"}</span>
      <span class="sb-score${homeWon ? " sb-win" : ""}">${hs.toFixed(2)}</span>
      <span class="sb-team sb-right${homeWon ? " sb-win" : ""}">${home}</span>
    </div>`;
  }).join("");

  el.innerHTML = `<div class="sb-head">Week ${week}${freshnessLabel()}</div>${rows}`;
}

function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/*
 * The real draft board — every pick, grouped by round.
 *
 * espn_pull.py resolves player names from the roster payload, so a player who
 * was drafted and has since been dropped comes back with a null name. Those
 * still get a slot on the board (marked "dropped") rather than vanishing,
 * which would silently renumber the round.
 */
function renderDraftBoard(data) {
  const el = document.getElementById("draft-board");
  if (!el) return;

  const picks = (data.live && data.live.draftPicks) || [];
  if (!picks.length) {
    const done = data.live && data.live.draftCompleted;
    el.innerHTML = '<p class="note" style="border:none;padding-left:0">'
      + (done
        ? "The draft is complete, but the results haven't been pulled yet. "
          + "The board fills in on the next scheduled ESPN pull."
        : "Draft results appear here as soon as the draft is complete.")
      + "</p>";
    return;
  }

  const season = data.live.season;
  const nameAt = data.managerNameAt;

  const rounds = new Map();
  picks.forEach((p) => {
    const r = p.round || 1;
    if (!rounds.has(r)) rounds.set(r, []);
    rounds.get(r).push(p);
  });

  const html = [...rounds.keys()].sort((a, b) => a - b).map((r) => {
    const list = rounds.get(r)
      .slice()
      .sort((a, b) => (a.overallPickNumber || 0) - (b.overallPickNumber || 0));
    const cells = list.map((p) => {
      const label = `${r}.${String(p.roundPickNumber || 0).padStart(2, "0")}`;
      const owner = nameAt(p.teamId, season);
      const who = p.name
        ? escHtml(p.name)
        : '<span style="color:var(--muted);font-style:italic">dropped since draft</span>';
      const meta = [p.pos, p.proTeam].filter(Boolean).join(" · ");
      return `<div class="rdb-pick">
        <span class="rdb-num">${label}</span>
        <span class="rdb-body">
          <span class="rdb-player">${who}</span>
          <span class="rdb-owner">${escHtml(owner)}${meta ? ` <span class="rdb-pos">${escHtml(meta)}</span>` : ""}</span>
        </span>
      </div>`;
    }).join("");
    return `<div class="rdb-round">
      <div class="rdb-round-head">Round ${r}</div>
      <div class="rdb-grid">${cells}</div>
    </div>`;
  }).join("");

  el.innerHTML = `<p class="note" style="margin-bottom:1.5rem">${picks.length} picks`
    + ` &middot; ${rounds.size} rounds.</p>${html}`;
}

/* ============================================================
   DIRECT ESPN POLLING  —  真 live scoring
   ------------------------------------------------------------
   GitHub Actions cron can't run faster than every 5 minutes and
   is delayed under load, so the committed espn_data.json is a
   30-minute snapshot at best. That's fine for Elo and records,
   useless for watching a Sunday.

   This league is PUBLIC and ESPN's read API sends permissive CORS
   headers, which means the visitor's own browser can call ESPN
   directly — verified from this exact origin, 200 with readable
   JSON in ~185ms. So scores refresh every 45 seconds in the page
   without touching GitHub at all.

   Design rules:
     - espn_data.json remains the source of truth on first paint,
       so the page is never blank and works offline.
     - Polling only ever ADDS freshness. Any failure (CORS change,
       rate limit, ESPN outage) silently falls back to the
       committed snapshot rather than blanking the board.
     - Three consecutive failures stops polling for the session.
     - Paused while the tab is hidden; resumes on focus. No point
       hammering ESPN for a tab nobody is looking at.
   ============================================================ */
const ESPN_LEAGUE = 1480327482;
const POLL_MS = 45000;
const POLL_MAX_FAILURES = 3;
let LIVE_META = null;      // { asOf: Date, source: "espn-live" | "snapshot" }
let _pollTimer = null, _pollFails = 0, _pollStopped = false;

function espnMatchupUrl(season, period) {
  return `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}`
    + `/segments/0/leagues/${ESPN_LEAGUE}?view=mMatchupScore&scoringPeriodId=${period}`;
}

// ESPN's raw schedule -> the same shape espn_pull.py writes, so every
// renderer downstream is unaware of which source it got.
function normalizeEspnMatchups(schedule, period) {
  const num = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100);
  return (schedule || [])
    .filter((m) => m.matchupPeriodId === period)
    .map((m) => {
      const h = m.home || {}, a = m.away || {};
      const pick = (s, live, proj) => ({
        score: num(s.totalPoints) || 0,
        live: num(s.totalPointsLive != null ? s.totalPointsLive : s.totalPoints) || 0,
        proj: num(s.totalProjectedPointsLive != null
          ? s.totalProjectedPointsLive : s.totalProjectedPoints),
      });
      const H = pick(h), A = pick(a);
      return {
        matchupPeriodId: m.matchupPeriodId,
        homeTeamId: h.teamId, homeScore: H.score, homeLive: H.live, homeProjected: H.proj,
        awayTeamId: a.teamId, awayScore: A.score, awayLive: A.live, awayProjected: A.proj,
        winner: m.winner || "UNDECIDED",
        playoffTierType: m.playoffTierType || "NONE",
      };
    });
}

async function pollEspnOnce() {
  const data = window.B12Live;
  if (!data || !data.live) return false;
  const season = data.live.season;
  const period = data.live.currentMatchupPeriod || 1;

  const res = await fetch(espnMatchupUrl(season, period), { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const json = await res.json();
  const games = normalizeEspnMatchups(json.schedule, period);
  if (!games.length) throw new Error("no matchups for period " + period);

  // Splice the fresh scores in. seasonMatchups keeps its finished weeks;
  // only the current period is replaced.
  data.live.currentWeekMatchups = games;
  const others = (data.live.seasonMatchups || []).filter((g) => g.matchupPeriodId !== period);
  const finishedNow = games.filter((g) => g.winner && g.winner !== "UNDECIDED");
  data.live.seasonMatchups = others.concat(finishedNow);

  LIVE_META = { asOf: new Date(), source: "espn-live" };

  // Re-render only what depends on live scoring. The Cup bracket is included
  // because it can now seed off live scores when ESPN is slow to finalise a
  // week — see hcGetTeamWeekScores.
  try { renderScoreboard(data); } catch (e) { console.error(e); }
  try { renderCupQualification(data); } catch (e) { console.error(e); }
  try {
    if (typeof computeHawkinsCup === "function") {
      data.hawkinsCup = computeHawkinsCup(data.matches, season, data.managerNameAt, data.live);
      renderHawkinsCup(data.hawkinsCup);
    }
  } catch (e) { console.error(e); }
  // Cup scoreboard AFTER the bracket recompute above — it reads data.hawkinsCup,
  // so running it first would paint a round stale by one tick.
  try { renderCupScoreboard(data); } catch (e) { console.error(e); }
  try { renderWeek2(data); } catch (e) { console.error(e); }
  return true;
}

function startEspnPolling() {
  if (_pollStopped) return;
  const tick = async () => {
    if (document.hidden) return;               // paused while tab is in the background
    try {
      await pollEspnOnce();
      _pollFails = 0;
    } catch (err) {
      _pollFails += 1;
      console.warn(`ESPN live poll failed (${_pollFails}/${POLL_MAX_FAILURES}):`, err.message);
      if (_pollFails >= POLL_MAX_FAILURES) {
        _pollStopped = true;
        clearInterval(_pollTimer);
        console.warn("Live polling disabled for this session — falling back to the "
          + "committed espn_data.json snapshot.");
        try { renderCupQualification(window.B12Live); } catch (e) {}
      }
    }
  };
  tick();
  _pollTimer = setInterval(tick, POLL_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
}

function freshnessLabel() {
  if (!LIVE_META) return "";
  const secs = Math.max(0, Math.round((Date.now() - LIVE_META.asOf.getTime()) / 1000));
  const when = secs < 10 ? "just now"
    : secs < 90 ? secs + "s ago"
    : Math.round(secs / 60) + "m ago";
  return ` &middot; live from ESPN, ${when}`;
}

/*
 * LIVE HAWKINS CUP QUALIFICATION
 *
 * Week 1 decides the Cup field: top 8 of 12 scores are in, bottom 4 are out.
 * The bracket in hawkins-cup.js deliberately stays "TBD" until Week 1 is
 * FINAL, because elo.js filters out any matchup still marked UNDECIDED — you
 * don't want a seeded bracket reshuffling itself all Sunday afternoon.
 *
 * But that left nothing to watch during the games. This is the running
 * leaderboard: current Week 1 points, who's in, who's out, and how far the
 * bubble teams are from the cut. It is explicitly labelled IN PROGRESS until
 * every game is decided, then switches to FINAL and matches the bracket.
 *
 * It reads currentWeekMatchups (which DOES carry in-progress scores) while
 * Week 1 is live, and falls back to seasonMatchups once the league moves on
 * to Week 2 so the page keeps showing the real qualification result.
 */
function renderCupQualification(data) {
  const el = document.getElementById("cup-qualification");
  if (!el) return;

  const live = data.live || {};
  const period = live.currentMatchupPeriod;
  const season = live.season;
  const nameAt = data.managerNameAt;

  // Week 1 games, wherever they currently live.
  let games = (live.seasonMatchups || []).filter((g) => g.matchupPeriodId === 1);
  if (!games.length && period === 1) games = live.currentWeekMatchups || [];

  // Because the ranking is projection-based, the board is meaningful BEFORE
  // anyone has scored a point — it shows the projected field. Only bail if we
  // have neither points nor projections to work with.
  const anyPoints = games.some((g) => (g.homeScore || 0) > 0 || (g.awayScore || 0) > 0);
  const anyProj = games.some((g) => g.homeProjected != null || g.awayProjected != null);
  if (!games.length || (!anyPoints && !anyProj)) {
    el.innerHTML = '<p class="note" style="border:none;padding-left:0">'
      + "Week 1 projections aren't available yet. Once they are, this becomes a "
      + "running leaderboard of who's in the Cup field and who's on the wrong "
      + "side of the cut, refreshed live from ESPN.</p>";
    return;
  }

  const decided = games.filter((g) => g.winner && g.winner !== "UNDECIDED").length;
  const isFinal = decided === games.length && games.length >= 6;

  // Ranked by ESPN's LIVE PROJECTED final score, not by points already
  // banked. With a Wednesday opener, raw points would rank whoever happened
  // to own a Seahawk first and leave everyone else tied on zero — technically
  // true, completely uninformative. The projection is opponent-adjusted,
  // injury-aware, and converges on the real number as games finish.
  //
  // Once every game is final the projection is moot, so the board switches to
  // actual points, which is what the bracket seeds off.
  const scores = [];
  games.forEach((g) => {
    scores.push({
      teamId: g.homeTeamId,
      pts: g.homeLive != null ? g.homeLive : (g.homeScore || 0),
      proj: g.homeProjected,
    });
    scores.push({
      teamId: g.awayTeamId,
      pts: g.awayLive != null ? g.awayLive : (g.awayScore || 0),
      proj: g.awayProjected,
    });
  });

  // If projections are missing (older pull, or the pull predates this field)
  // fall back to actual points so the board still works.
  const haveProj = scores.filter((s) => s.proj != null).length === scores.length;
  const rankBy = (s) => (isFinal || !haveProj ? s.pts : s.proj);
  scores.sort((a, b) => rankBy(b) - rankBy(a));

  const SPOTS = 8;
  const cut = scores[SPOTS - 1] ? rankBy(scores[SPOTS - 1]) : 0;
  const firstOut = scores[SPOTS] ? rankBy(scores[SPOTS]) : 0;

  // ---- Cup odds ----------------------------------------------------------
  // Moved here from the old roster-based "Projected Cup Field", now seeded
  // from ESPN's projections. A ranking alone implies the field is settled; it
  // isn't, because the gap between best and worst roster (~10 pts) is small
  // next to weekly scoring noise (~23 pts).
  //
  // Crucially the uncertainty SHRINKS as the week resolves: with five of six
  // games final there is very little left to happen, so odds should harden
  // toward 100/0. Scaling the standard deviation by the square root of the
  // unplayed fraction does that, and lands exactly on 0 when everything is in.
  const odds = (() => {
    const n = scores.length;
    const remainingFrac = Math.max(0, 1 - decided / games.length);
    if (isFinal || remainingFrac === 0) {
      return scores.map((_, i) => (i < SPOTS ? 1 : 0));   // decided
    }
    // league scoring spread, from real history where available
    const hist = (data.history && data.history.seasons) || {};
    const past = [];
    Object.keys(hist).forEach((s) => (hist[s].allMatchups || []).forEach((m) => {
      if (m.winner === "UNDECIDED" || (m.playoffTierType || "NONE") !== "NONE") return;
      past.push(m.homeScore, m.awayScore);
    }));
    let sd = 23.4;
    if (past.length >= 50) {
      const mu = past.reduce((a, b) => a + b, 0) / past.length;
      sd = Math.sqrt(past.reduce((a, b) => a + (b - mu) * (b - mu), 0) / past.length);
    }
    sd *= Math.sqrt(remainingFrac);

    const mu = scores.map(rankBy);
    let seed = 20260913;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const gauss = () => {
      const u = rnd() || 1e-9, v = rnd();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const SIMS = 20000;
    const made = new Array(n).fill(0);
    const draw = new Array(n);
    for (let s = 0; s < SIMS; s++) {
      for (let i = 0; i < n; i++) draw[i] = { i, v: mu[i] + gauss() * sd };
      draw.sort((a, b) => b.v - a.v);
      for (let k = 0; k < SPOTS && k < n; k++) made[draw[k].i]++;
    }
    return made.map((c) => c / SIMS);
  })();

  const rows = scores.map((s, i) => {
    const inField = i < SPOTS;
    const margin = inField ? rankBy(s) - firstOut : rankBy(s) - cut;
    const divider = i === SPOTS
      ? `<div class="cq-cut"><span>Cut line &mdash; ${cut.toFixed(2)}`
        + `${isFinal ? " pts" : " projected (and moving)"}</span></div>`
      : "";
    return divider + `<div class="cq-row${inField ? "" : " out"}">
      <span class="cq-rank">${i + 1}</span>
      <span class="cq-mgr">${escHtml(nameAt(s.teamId, season))}</span>
      <span class="cq-proj">${s.proj != null ? s.proj.toFixed(2) : "&mdash;"}</span>
      <span class="cq-pts">${s.pts.toFixed(2)}</span>
      <span class="cq-margin">${margin >= 0 ? "+" : ""}${margin.toFixed(2)}</span>
      <span class="cq-oddsbar"><span class="cq-oddsfill" style="width:${Math.round(odds[i]*100)}%"></span></span>
      <span class="cq-odds">${Math.round(odds[i]*100)}%</span>
      <span class="cq-tag">${inField ? "IN" : "OUT"}</span>
    </div>`;
  }).join("");

  const banner = isFinal
    ? '<div class="cq-status final">Final &mdash; Cup field is set</div>'
    : `<div class="cq-status live">Projected &mdash; ${decided} of ${games.length} games final${freshnessLabel()}</div>`;

  el.innerHTML = banner
    + `<div class="cq-list">
        <div class="cq-row head"><span class="cq-rank"></span><span class="cq-mgr">Manager</span>
        <span class="cq-proj">Proj</span><span class="cq-pts">Actual</span>
        <span class="cq-margin">Margin</span><span class="cq-oddsbar"></span>
        <span class="cq-odds">Cup Odds</span><span class="cq-tag"></span></div>
        ${rows}
      </div>`
    + '<p class="note" style="margin-top:1rem">'
    + (isFinal
        ? "Final Week 1 scores. The eight above the line are seeded 1&ndash;8 in the bracket below."
        : "<strong>Ranked by ESPN's projected final score</strong>, which is the only meaningful "
          + "ordering until everyone has played &mdash; actual points just favour whoever owns a "
          + "Wednesday or Thursday player. Margin is against the projected cut line. "
          + "Nothing is settled until the last Monday night snap.")
    + "</p>";
}

/*
 * "How The Board Fell" — the league-wide shape of the draft.
 *
 * The single most useful number here is mean ADP deviation by position:
 * pick number minus ADP, averaged. Negative means the league consistently
 * took that position EARLIER than the market does. It explains why almost
 * everybody's individual value score came out negative — you cannot all
 * reach on running backs and also all beat ADP.
 *
 * K/DST are excluded for the same reason they're excluded from grading:
 * their ADP in this pool is a synthetic bottom-of-board rank.
 */
function renderDraftTrends(data) {
  const el = document.getElementById("draft-trends");
  if (!el) return;
  const raw = (data.live && data.live.draftPicks) || [];
  const grader = window.__b12grades;
  if (!raw.length || !grader) {
    el.innerHTML = '<p class="note" style="border:none;padding-left:0">'
      + "Draft trends appear once the results have been pulled from ESPN.</p>";
    return;
  }

  const picks = raw.map((pk) => ({ ...pk, p: grader.findPlayer(pk) })).filter((x) => x.p);
  const priced = picks.filter((x) => x.p.pos !== "K" && x.p.pos !== "DST")
    .map((x) => ({
      name: x.p.name, pos: x.p.pos,
      label: x.round + "." + String(x.roundPickNumber).padStart(2, "0"),
      dev: x.overallPickNumber - x.p.adpAvg,
    }));
  if (!priced.length) { el.innerHTML = ""; return; }

  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const POS = ["RB", "WR", "TE", "QB"];
  const stats = POS.map((pos) => {
    const set = priced.filter((x) => x.pos === pos).map((x) => x.dev);
    return set.length ? {
      pos, n: set.length, dev: mean(set),
      reached: set.filter((v) => v < -8).length,
      stole: set.filter((v) => v > 8).length,
    } : null;
  }).filter(Boolean).sort((a, b) => a.dev - b.dev);

  const maxAbs = Math.max(...stats.map((s) => Math.abs(s.dev)), 1);
  const bars = stats.map((s) => {
    const pct = Math.round((Math.abs(s.dev) / maxAbs) * 50);
    const early = s.dev < 0;
    return `<div class="rdt-row">
      <span class="rdt-pos">${s.pos}</span>
      <span class="rdt-bar">
        <span class="rdt-fill ${early ? "early" : "late"}"
              style="${early ? "right:50%" : "left:50%"};width:${pct}%"></span>
        <span class="rdt-mid"></span>
      </span>
      <span class="rdt-val ${early ? "early" : "late"}">${s.dev > 0 ? "+" : ""}${s.dev.toFixed(1)}</span>
      <span class="rdt-note">${s.reached} reaches / ${s.stole} steals of ${s.n}</span>
    </div>`;
  }).join("");

  const firstOf = {};
  picks.forEach((x) => { if (firstOf[x.p.pos] == null) firstOf[x.p.pos] = x.overallPickNumber; });
  const r1 = picks.filter((x) => x.round === 1)
    .reduce((acc, x) => { acc[x.p.pos] = (acc[x.p.pos] || 0) + 1; return acc; }, {});

  const sorted = priced.slice().sort((a, b) => a.dev - b.dev);
  const list = (arr, cls) => arr.map((x) => `<div class="rdt-item">
      <span class="rdt-d ${cls}">${x.dev > 0 ? "+" : ""}${Math.round(x.dev)}</span>
      <span class="rdt-nm">${escHtml(x.name)}</span>
      <span class="rdt-meta">${x.pos} &middot; ${x.label}</span>
    </div>`).join("");

  const totalR = priced.filter((x) => x.dev < -8).length;
  const totalS = priced.filter((x) => x.dev > 8).length;

  el.innerHTML = `
    <p class="note" style="margin-bottom:1.4rem">Mean ADP deviation by position &mdash; how many picks
      earlier or later than the market this league took each position.
      <strong>Negative = the room reached.</strong> K and D/ST are excluded (no real ADP).</p>
    <div class="rdt-chart">
      <div class="rdt-axis"><span>drafted earlier than ADP</span><span>later than ADP</span></div>
      ${bars}
    </div>
    <div class="rdt-cards">
      <div class="rdt-card">
        <div class="rdt-card-h">Biggest Reaches</div>${list(sorted.slice(0, 5), "neg")}
      </div>
      <div class="rdt-card">
        <div class="rdt-card-h">Biggest Steals</div>${list(sorted.slice(-5).reverse(), "pos")}
      </div>
    </div>
    <p class="note" style="margin-top:1.3rem">Round 1 went
      <strong>${r1.RB || 0} RB, ${r1.WR || 0} WR</strong>${(r1.QB || r1.TE) ? "" : " &mdash; no QB, no TE"}.
      First QB off the board at pick <strong>${firstOf.QB || "&mdash;"}</strong>,
      first TE at <strong>${firstOf.TE || "&mdash;"}</strong>.
      Across ${priced.length} priced picks there were <strong>${totalR} reaches</strong>
      and only <strong>${totalS} steals</strong>, which is why most managers show a negative
      value score: the room bid RB and WR up, and left QB and TE sitting.</p>`;
}

/*
 * Rosters page — every team side by side, starters first then bench.
 * Populates after the draft; shows a note until then.
 */
function renderRostersPage(data) {
  const el = document.getElementById("rosters-body");
  if (!el) return;

  const rosters = (data.live && data.live.rosters) || {};
  const teamIds = Object.keys(rosters).filter((id) => (rosters[id] || []).length);
  if (!teamIds.length) {
    el.innerHTML = '<p class="note" style="border:none;padding-left:0">'
      + "Rosters appear here once the draft results have been pulled from ESPN "
      + "&mdash; they refresh automatically as adds, drops and trades happen.</p>";
    return;
  }

  const season = data.live.season;
  const nameAt = data.managerNameAt;
  const POS_ORDER = { QB: 0, RB: 1, WR: 2, TE: 3, K: 4, DST: 5 };
  const teamNameById = {};
  ((data.live && data.live.standings) || []).forEach((t) => { teamNameById[t.teamId] = t.name; });

  const cards = teamIds
    .map(Number)
    .sort((a, b) => nameAt(a, season).localeCompare(nameAt(b, season)))
    .map((id) => {
      const list = (rosters[id] || []).slice().sort((a, b) => {
        if (a.starter !== b.starter) return a.starter ? -1 : 1;
        return (POS_ORDER[a.pos] ?? 9) - (POS_ORDER[b.pos] ?? 9);
      });
      let benchStarted = false;
      const rows = list.map((p) => {
        let divider = "";
        if (!p.starter && !benchStarted) {
          benchStarted = true;
          divider = '<div class="rp-divider">Bench</div>';
        }
        const inj = p.injuryStatus && p.injuryStatus !== "ACTIVE"
          ? `<span class="rp-inj">${escHtml(p.injuryStatus.slice(0, 3))}</span>` : "";
        return `${divider}<div class="rp-row${p.starter ? "" : " bench"}">
          <span class="rp-slot">${p.starter ? escHtml(p.pos) : "BN"}</span>
          <span class="rp-name">${escHtml(p.name) || "&mdash;"}${inj}</span>
          <span class="rp-meta">${escHtml(p.proTeam || "")}</span>
        </div>`;
      }).join("");
      return `<div class="rp-card">
        <div class="rp-head">
          <div class="rp-mgr">${escHtml(nameAt(id, season))}</div>
          <div class="rp-team">${escHtml(teamNameById[id] || "")}</div>
        </div>
        <div class="rp-list">${rows}</div>
      </div>`;
    }).join("");

  el.innerHTML = `<div class="rp-grid">${cards}</div>`;
}

/* ===========================================================================
 * LIVE HAWKINS CUP SCOREBOARD  +  WEEK 2 PANEL
 *
 * THE THING TO UNDERSTAND BEFORE READING ANY OF THIS: a Cup pairing is not an
 * ESPN matchup. The Cup seeds 1v8 / 4v5 / 2v7 / 3v6 off Week 1 point totals.
 * ESPN's regular-season schedule was drawn months before those seeds existed.
 * The two only coincide by luck.
 *
 * In Week 2 of 2026 exactly two of the four quarterfinals are also real ESPN
 * head-to-heads (2v7 Guarnaccia/Beland, 4v5 Carullo/Peretz). The other two —
 * 1v8 Lisa/Hawkins and 3v6 Furnari/Sweeney — are each playing somebody else
 * entirely, and the Cup simply compares their two weekly totals.
 *
 * Consequence: a manager can win their ESPN matchup and be eliminated from the
 * Cup on the same Sunday. If this board just mirrored ESPN's scoreboard it
 * would show the wrong opponent for half the bracket and everyone would
 * reasonably conclude the site was broken. So it renders the CUP opponent and
 * names the ESPN opponent underneath whenever they differ.
 * =========================================================================== */

const CUP_ROUND_NAME = { 2: "Quarterfinals", 3: "Semifinals", 4: "Final" };

/*
 * Every team's number for a given week: live-first points, ESPN's live
 * projection, who ESPN has them playing, and whether ESPN has stamped it
 * final. currentWeekMatchups is checked first because it is the pool the
 * 45-second poll refreshes; seasonMatchups backfills weeks the league has
 * already moved past.
 */
function cupWeekScores(live, week) {
  const out = {};
  const pools = [live.currentWeekMatchups || [], live.seasonMatchups || []];
  pools.forEach((pool) => {
    pool.forEach((g) => {
      if ((g.matchupPeriodId != null ? g.matchupPeriodId : g.week) !== week) return;
      const decided = !!(g.winner && g.winner !== "UNDECIDED");
      const put = (id, pts, proj, oppId) => {
        if (id == null || out[id]) return;   // first pool wins — it's the freshest
        out[id] = { pts: pts || 0, proj: proj != null ? proj : null, oppId, decided };
      };
      put(g.homeTeamId, g.homeLive != null ? g.homeLive : g.homeScore,
          g.homeProjected, g.awayTeamId);
      put(g.awayTeamId, g.awayLive != null ? g.awayLive : g.awayScore,
          g.awayProjected, g.homeTeamId);
    });
  });
  return out;
}

function renderCupScoreboard(data) {
  const targets = ["cup-scoreboard", "cup-scoreboard-2"]
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  if (!targets.length) return;
  const write = (v) => targets.forEach((t) => { t.innerHTML = v; });

  const live = data.live || {};
  const season = live.season;
  const nameAt = data.managerNameAt;
  const cup = data.hawkinsCup
    || (window.B12Live && window.B12Live.hawkinsCup)
    || (typeof computeHawkinsCup === "function"
        ? computeHawkinsCup(data.matches, season, nameAt, live)
        : null);

  if (!cup || cup.status !== "determined") {
    write('<p class="note" style="border:none;padding-left:0">'
      + 'The Cup field is set the moment Week 1 goes final. Quarterfinal cards '
      + 'appear here with live scoring as soon as the bracket exists.</p>');
    return;
  }

  // Show the furthest round that actually has pairings, never ahead of the
  // week the league is on. cup.sf stays empty until every QF is final, and
  // cup.final stays null until both SFs are — so this degrades backwards on
  // its own without needing to know the calendar.
  const period = live.currentMatchupPeriod || 2;
  let pairs, roundWeek;
  if (period >= 4 && cup.final) { pairs = [cup.final]; roundWeek = 4; }
  else if (period >= 3 && cup.sf && cup.sf.length) { pairs = cup.sf; roundWeek = 3; }
  else { pairs = cup.qf || []; roundWeek = 2; }
  const roundName = CUP_ROUND_NAME[roundWeek] || "Quarterfinals";

  if (!pairs.length) {
    write('<p class="note" style="border:none;padding-left:0">'
      + `The ${roundName.toLowerCase()} fill in once the previous round is final.</p>`);
    return;
  }

  const scores = cupWeekScores(live, roundWeek);
  const teamNameById = {};
  Object.keys(TEAM_MANAGER_MAP).forEach((id) => {
    teamNameById[id] = TEAM_MANAGER_MAP[id].team;
  });

  const cards = pairs.map((p, i) => {
    const A = p.teamA, B = p.teamB;
    if (!A || !B) return "";
    const sa = scores[A.teamId] || { pts: 0, proj: null, oppId: null, decided: false };
    const sb = scores[B.teamId] || { pts: 0, proj: null, oppId: null, decided: false };

    // A Cup game is over only when BOTH sides' weeks are over — which for a
    // split pairing means two different ESPN matchups both going final.
    const done = sa.decided && sb.decided;
    const started = sa.pts > 0 || sb.pts > 0;
    const aWin = done && sa.pts >= sb.pts;   // ties break to the better seed
    const bWin = done && sb.pts > sa.pts;
    const state = done ? "Final" : started ? "Live" : "Pregame";
    const stateCls = done ? "final" : started ? "live" : "";

    const side = (t, s, win, lose) => `<div class="cs-side${win ? " win" : ""}${lose ? " lose" : ""}">
      <span class="cs-seed">${t.seed != null ? "#" + t.seed : "&mdash;"}</span>
      <span class="cs-who">
        <span class="cs-mgr">${escHtml(t.name)}</span>
        <span class="cs-team">${escHtml(teamNameById[t.teamId] || "")}</span>
      </span>
      <span class="cs-nums">
        <span class="cs-pts">${s.pts.toFixed(2)}</span>
        <span class="cs-proj">${s.proj != null ? "proj " + s.proj.toFixed(1) : "&nbsp;"}</span>
      </span>
    </div>`;

    // Is this Cup pairing also the ESPN head-to-head? If not, say who each of
    // them is actually playing — otherwise the numbers look unexplainable.
    const sameGame = sa.oppId != null && sa.oppId === B.teamId;
    let foot;
    if (sameGame) {
      foot = `<div class="cs-foot"><strong>Head to head on ESPN.</strong> `
        + `This is their real Week ${roundWeek} matchup &mdash; the Cup result and the `
        + `regular-season result are the same game.</div>`;
    } else {
      const aOpp = sa.oppId != null ? nameAt(sa.oppId, season) : "&mdash;";
      const bOpp = sb.oppId != null ? nameAt(sb.oppId, season) : "&mdash;";
      foot = `<div class="cs-foot cs-split"><strong>Not an ESPN matchup.</strong> `
        + `${escHtml(A.name)} plays ${escHtml(aOpp)}, ${escHtml(B.name)} plays `
        + `${escHtml(bOpp)}. The Cup compares their two weekly totals, so either can `
        + `win on ESPN and still go out here.</div>`;
    }

    const margin = Math.abs(sa.pts - sb.pts);
    const marginLine = started && !done
      ? `<div class="cs-foot">${escHtml((sa.pts >= sb.pts ? A : B).name)} leads by `
        + `<strong>${margin.toFixed(2)}</strong>.</div>`
      : done
        ? `<div class="cs-foot"><strong>${escHtml((aWin ? A : B).name)}</strong> advances by `
          + `${margin.toFixed(2)}.</div>`
        : "";

    const label = roundWeek === 4 ? "Hawkins Cup Final"
      : `${roundName.replace(/s$/, "")} ${i + 1}`;

    return `<article class="cs-card">
      <div class="cs-top">
        <span class="cs-label">${label}</span>
        <span class="cs-state ${stateCls}">${state}</span>
      </div>
      ${side(A, sa, aWin, bWin)}
      ${side(B, sb, bWin, aWin)}
      ${marginLine}
      ${foot}
    </article>`;
  }).join("");

  write(`<div class="cs-head">
      <span class="cs-round">${roundName} &middot; Week ${roundWeek}</span>
      <span class="cs-when">${cup.provisional ? "Seeds provisional &middot; " : ""}`
    + `Live scoring${freshnessLabel()}</span>
    </div>
    <div class="cs-grid">${cards}</div>`);
}

/*
 * Week 2's real ESPN scoreboard — all six matchups, live points plus ESPN's
 * projected final, tagged with what each game means for the Cup.
 *
 * Unlike renderScoreboard() this renders BEFORE anyone has scored, because
 * with projections there is something worth looking at on a Wednesday.
 */
function renderWeek2(data) {
  const el = document.getElementById("week2-scoreboard");
  if (!el) return;

  const live = data.live || {};
  const season = live.season;
  const nameAt = data.managerNameAt;
  const week = live.currentMatchupPeriod || 2;

  let games = (live.currentWeekMatchups || []).filter((g) =>
    g.matchupPeriodId === week);
  if (!games.length) {
    games = (live.seasonMatchups || []).filter((g) => g.matchupPeriodId === week);
  }
  if (!games.length) {
    el.innerHTML = '<p class="note" style="border:none;padding-left:0">'
      + `Week ${week} matchups aren't posted yet. They appear here automatically.</p>`;
    return;
  }

  const cup = data.hawkinsCup || (window.B12Live && window.B12Live.hawkinsCup);
  const seedOf = {};
  if (cup && cup.status === "determined") {
    (cup.qualifiers || []).forEach((q) => { seedOf[q.teamId] = q.seed; });
  }
  // Which teams are still alive in whichever Cup round matches this week.
  const alive = {};
  if (cup && cup.status === "determined" && week === 2) {
    (cup.qf || []).forEach((m) => { alive[m.teamA.teamId] = 1; alive[m.teamB.teamId] = 1; });
  }

  const cards = games.map((g, i) => {
    const hs = g.homeLive != null ? g.homeLive : (g.homeScore || 0);
    const as = g.awayLive != null ? g.awayLive : (g.awayScore || 0);
    const done = !!(g.winner && g.winner !== "UNDECIDED");
    const started = hs > 0 || as > 0;
    const homeWon = done && g.winner === "HOME";
    const awayWon = done && g.winner === "AWAY";

    // Both teams in this ESPN game happen to be each other's Cup opponent?
    // Then this single game decides a quarterfinal outright.
    const isCupGame = alive[g.homeTeamId] && alive[g.awayTeamId]
      && (cup.qf || []).some((m) =>
        (m.teamA.teamId === g.homeTeamId && m.teamB.teamId === g.awayTeamId)
        || (m.teamA.teamId === g.awayTeamId && m.teamB.teamId === g.homeTeamId));

    const row = (id, pts, proj, win, lose) => `<div class="w2-grow${win ? " win" : ""}${lose ? " lose" : ""}">
      <span class="w2-gname">${escHtml(nameAt(id, season))}`
      + `${seedOf[id] ? ` <span class="w2-cuptag">#${seedOf[id]}</span>` : ""}</span>
      <span class="w2-gpts">${pts.toFixed(2)}</span>
      <span class="w2-gproj">${proj != null ? proj.toFixed(1) : "&mdash;"}</span>
    </div>`;

    return `<div class="w2-game">
      <div class="w2-gtop">
        <span>Game ${i + 1} &middot; Week ${week}</span>
        <span class="${isCupGame ? "w2-cuptag" : ""}">${
          done ? "Final" : started ? "Live" : "Pregame"
        }${isCupGame ? " &middot; Cup QF" : ""}</span>
      </div>
      ${row(g.awayTeamId, as, g.awayProjected, awayWon, homeWon)}
      ${row(g.homeTeamId, hs, g.homeProjected, homeWon, awayWon)}
    </div>`;
  }).join("");

  const finals = games.filter((g) => g.winner && g.winner !== "UNDECIDED").length;
  el.innerHTML = `<div class="sb-head">Week ${week} &middot; ${finals} of ${games.length} final${freshnessLabel()}</div>`
    + `<div class="w2-sb">${cards}</div>`
    + '<p class="note">Left column is live points, right column is ESPN\'s projected final. '
    + 'A <span style="color:#A16207">#n</span> beside a name is that manager\'s Hawkins Cup seed &mdash; '
    + 'no number means they were eliminated in Week 1.</p>';
}

/*
 * Week 1, final. The permanent record of how the Cup field got cut: every
 * score, the head-to-head result, and the seed it earned. Reads seasonMatchups
 * so it survives the league moving on to later weeks.
 */
function renderWeek1Results(data) {
  // Two mounts: the Week 2 page's recap, and the Week 1 page's own board
  // (which renderScoreboard used to own and was about to mislabel).
  const targets = ["week1-results", "week1-scoreboard"]
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  if (!targets.length) return;
  const el = { set innerHTML(v) { targets.forEach((t) => { t.innerHTML = v; }); } };

  const live = data.live || {};
  const season = live.season;
  const nameAt = data.managerNameAt;

  let games = (live.seasonMatchups || []).filter((g) => g.matchupPeriodId === 1);
  if (!games.length) {
    games = (live.currentWeekMatchups || []).filter((g) => g.matchupPeriodId === 1);
  }
  if (!games.length) {
    el.innerHTML = '<p class="note" style="border:none;padding-left:0">'
      + 'Week 1 results load from ESPN once the week is on file.</p>';
    return;
  }

  const rows = [];
  games.forEach((g) => {
    const hs = g.homeScore != null && g.homeScore > 0
      ? g.homeScore : (g.homeLive || 0);
    const as = g.awayScore != null && g.awayScore > 0
      ? g.awayScore : (g.awayLive || 0);
    rows.push({ teamId: g.homeTeamId, pts: hs, won: hs > as });
    rows.push({ teamId: g.awayTeamId, pts: as, won: as > hs });
  });
  rows.sort((a, b) => b.pts - a.pts);

  const SPOTS = 8;
  const cut = rows[SPOTS - 1] ? rows[SPOTS - 1].pts : 0;
  const firstOut = rows[SPOTS] ? rows[SPOTS].pts : 0;

  const body = rows.map((r, i) => {
    const inField = i < SPOTS;
    const divider = i === SPOTS
      ? `<div class="w1r-cut"><span>Cut line &mdash; ${cut.toFixed(2)} `
        + `&middot; missed by ${(cut - firstOut).toFixed(2)}</span></div>`
      : "";
    return divider + `<div class="w1r-row${inField ? "" : " out"}">
      <span class="w1r-seed">${inField ? i + 1 : "&mdash;"}</span>
      <span class="w1r-mgr">${escHtml(nameAt(r.teamId, season))}</span>
      <span class="w1r-pts">${r.pts.toFixed(2)}</span>
      <span class="w1r-rec">${r.won ? "W" : "L"}</span>
      <span class="w1r-tag">${inField ? "SEEDED" : "ELIMINATED"}</span>
    </div>`;
  }).join("");

  // Count the actual crossovers rather than asserting a number. The first
  // draft of this line claimed "four managers won and still missed" — in the
  // real Week 1 that number was ZERO, and two managers lost and got in. Any
  // hardcoded figure here is a sentence that goes stale or was never true.
  const wonAndMissed = rows.filter((r, i) => r.won && i >= SPOTS).length;
  const lostAndMade = rows.filter((r, i) => !r.won && i < SPOTS).length;
  const plural = (n, s) => `${n} manager${n === 1 ? "" : "s"} ${n === 1 ? s[0] : s[1]}`;
  const crossovers = [];
  if (lostAndMade) crossovers.push(plural(lostAndMade, ["lost", "lost"]) + " their matchup and still got in");
  if (wonAndMissed) crossovers.push(plural(wonAndMissed, ["won", "won"]) + " theirs and still missed");

  el.innerHTML = `<div class="w1r-list">
      <div class="w1r-row head"><span class="w1r-seed">Seed</span>
      <span class="w1r-mgr">Manager</span><span class="w1r-pts">Week 1</span>
      <span class="w1r-rec">H2H</span><span class="w1r-tag">Cup</span></div>
      ${body}
    </div>`
    + '<p class="note">Seeds are Week 1 points, nothing else &mdash; the head-to-head '
    + 'column is there to show how little it mattered. '
    + (crossovers.length
        ? crossovers.join(", and ").replace(/^./, (c) => c.toUpperCase()) + "."
        : "Every Cup seed also won their matchup this time &mdash; that will not hold.")
    + "</p>";
}

document.addEventListener("DOMContentLoaded", () => {
  loadB12Live()
    .then((data) => {
      renderEloColumn(data);
      renderEloLeaderboard(data);
      renderScoreboard(data);
      renderDraftBoard(data);
      renderDraftTrends(data);
      renderCupQualification(data);
      renderWeek1Results(data);
      // Both of these want data.hawkinsCup, which hawkins-cup.js sets from its
      // own b12live:ready listener. That listener already ran synchronously
      // inside loadB12Live()'s dispatchEvent, before this .then() — so the
      // bracket exists by now. renderCupScoreboard falls back to computing it
      // itself if that ever stops being true.
      renderCupScoreboard(data);
      renderWeek2(data);
      startEspnPolling();   // upgrade from the 30-min snapshot to 45-second live
      renderRostersPage(data);
    })
    .catch((err) => console.error("B12Live load failed:", err));
});
