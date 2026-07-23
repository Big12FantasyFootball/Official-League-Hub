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
  4:  { manager: "Josh", team: "Josh's Scary Team" },              // guessed from team name
  5:  { manager: "Lisa", team: "Team Lisa" },                        // guessed from team name
  6:  { manager: "Jalen", team: "Bourne with Downs" },               // confirmed — rebranded from "Jalen's Team" in 2024, same manager
  7:  { manager: "Aidan Goss", team: "Aidan's Astounding Team" },    // confirmed — new for 2026; Timmy Hoffman owned this slot through 2025, departed
  8:  { manager: "Nick Hawkins", team: "Curse of Ra" },              // confirmed — league supervisor/namesake
  9:  { manager: "Nick Furnari", team: "Nick's Nitty Team" },        // guessed from team name
  10: { manager: "Brandon Beland", team: "Brandon's Brilliant Team" }, // confirmed — new for 2026; Braden Lord ("BLORD") owned this slot through 2025, departed
  11: { manager: "Jojo Guarnaccia", team: "Fortnite Grinder" },      // confirmed — matches existing mgr-tbl row
  12: { manager: "Dann", team: "Team Dann" },                        // guessed from team name
};

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

document.addEventListener("DOMContentLoaded", () => {
  loadB12Live()
    .then((data) => {
      renderEloColumn(data);
      renderEloLeaderboard(data);
    })
    .catch((err) => console.error("B12Live load failed:", err));
});
