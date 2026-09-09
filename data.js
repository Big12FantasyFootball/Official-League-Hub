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
  // Rendered in two places: the Schedule panel and the Week 1 page.
  const targets = ["live-scoreboard", "week1-scoreboard"]
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  if (!targets.length) return;
  const el = { set innerHTML(v) { targets.forEach((t) => { t.innerHTML = v; }); } };

  const games = (data.live && data.live.currentWeekMatchups) || [];
  const played = games.filter((g) => (g.homeScore || 0) > 0 || (g.awayScore || 0) > 0);
  if (!games.length || !played.length) {
    el.innerHTML = '<p class="note" style="border:none;padding-left:0">'
      + 'Scores appear here once Week 1 kicks off &mdash; they update automatically '
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

  // Re-render only what depends on live scoring.
  try { renderScoreboard(data); } catch (e) { console.error(e); }
  try { renderCupQualification(data); } catch (e) { console.error(e); }
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

document.addEventListener("DOMContentLoaded", () => {
  loadB12Live()
    .then((data) => {
      renderEloColumn(data);
      renderEloLeaderboard(data);
      renderScoreboard(data);
      renderDraftBoard(data);
      renderDraftTrends(data);
      renderCupQualification(data);
      startEspnPolling();   // upgrade from the 30-min snapshot to 45-second live
      renderRostersPage(data);
    })
    .catch((err) => console.error("B12Live load failed:", err));
});
