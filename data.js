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

  el.innerHTML = `<div class="sb-head">Week ${week}</div>${rows}`;
}

// The teamId this site belongs to — used only to highlight his picks on the
// draft board. Cosmetic; nothing breaks if the id is ever wrong.
const SITE_TEAM_ID = 8; // Nick Hawkins, "Curse of Ra"

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
      const mine = p.teamId === SITE_TEAM_ID;
      const who = p.name
        ? escHtml(p.name)
        : '<span style="color:var(--muted);font-style:italic">dropped since draft</span>';
      const meta = [p.pos, p.proTeam].filter(Boolean).join(" · ");
      return `<div class="rdb-pick${mine ? " mine" : ""}">
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
    + ` &middot; ${rounds.size} rounds &middot; your picks are highlighted.</p>${html}`;
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
      renderRostersPage(data);
    })
    .catch((err) => console.error("B12Live load failed:", err));
});
