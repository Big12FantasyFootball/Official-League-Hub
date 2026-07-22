/*
 * Live data loader — Big 12 Fantasy Football
 * Load AFTER elo.js: <script src="elo.js"></script> then <script src="data.js"></script>
 */

const TEAM_MANAGER_MAP = {
  1:  { manager: "Nick Carullo", team: "Drake London and Friends" },
  2:  { manager: "Drew Sanford", team: "Flat Foot" },
  3:  { manager: "Jake Joyce", team: "Seal Team Nix" },
  4:  { manager: "Josh Sweeney", team: "Josh's Scary Team" },
  5:  { manager: "Joseph Lisa", team: "Team Lisa" },
  6:  { manager: "Jalen Peretz", team: "Bourne with Downs" },
  7:  { manager: "Aidan Goss", team: "Aidan's Astounding Team" },
  8:  { manager: "Nick Hawkins", team: "Curse of Ra" },
  9:  { manager: "Nick Furnari", team: "Nick's Nitty Team" },
  10: { manager: "Brandon Beland", team: "Brandon's Brilliant Team" },
  11: { manager: "Jojo Guarnaccia", team: "Fortnite Grinder" },
  12: { manager: "Ryan Dann", team: "Team Dann" },
};

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
    loadJSON("espn_history.json").catch(() => ({ seasons: {} })),
  ]);

  const matches = buildMatchListFromEspnFiles(historyData, liveData);
  const { ratings, history } = computeElo(matches, {
    resetSeasons: MANAGER_START_SEASON,
    currentSeason: liveData.season,
  });

  const managers = Object.keys(TEAM_MANAGER_MAP).map((teamIdStr) => {
    const teamId = Number(teamIdStr);
    const info = TEAM_MANAGER_MAP[teamId];
    const standing = (liveData.standings || []).find((s) => s.teamId === teamId) || {};
    return {
      teamId,
      manager: info.manager,
      team: info.team,
      managerSince: MANAGER_START_SEASON[teamId] || 2024,
      wins: standing.wins ?? 0,
      losses: standing.losses ?? 0,
      ties: standing.ties ?? 0,
      pointsFor: standing.pointsFor ?? 0,
      pointsAgainst: standing.pointsAgainst ?? 0,
      elo: Math.round(ratings[teamId] ?? 1500),
      eloHistory: history[teamId] || [],
    };
  });
  managers.sort((a, b) => b.elo - a.elo);

  window.B12Live = {
    live: liveData,
    history: historyData,
    matches,
    ratings,
    eloHistory: history,
    managers,
    managerNameAt,
    pulledAt: liveData.pulledAt,
    draftCompleted: liveData.draftCompleted,
  };

  document.dispatchEvent(new CustomEvent("b12live:ready", { detail: window.B12Live }));
  return window.B12Live;
}

function renderEloColumn(data) {
  const table = document.getElementById("mgr-tbl");
  if (!table) return;

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
    if (tr.querySelector('[data-elo-cell]')) return;
    const nameEl = tr.querySelector(".mn2");
    const name = nameEl ? nameEl.firstChild?.textContent?.trim() : null;
    const match = name ? managerByName[name] : null;

    const td = document.createElement("td");
    td.className = "r";
    td.dataset.eloCell = "1";
    td.textContent = match ? match.elo : "—";
    tr.appendChild(td);

    try {
      const vals = JSON.parse(tr.dataset.vals || "[]");
      vals.push(match ? String(match.elo) : "0");
      tr.dataset.vals = JSON.stringify(vals);
    } catch (e) {}
  });
}

document.addEventListener("DOMContentLoaded", () => {
  loadB12Live()
    .then((data) => renderEloColumn(data))
    .catch((err) => console.error("B12Live load failed:", err));
});
