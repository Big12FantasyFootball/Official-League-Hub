/*
 * League Records — Big 12 Fantasy Football
 * Load AFTER elo.js and data.js. Renders into id="live-records" if present.
 */

function computeRecordsFromSlice(matches, nameAt) {
  const games = [];
  const contests = [];

  for (const m of matches) {
    if (m.winner === "UNDECIDED" || m.winner == null) continue;
    const homeWon = m.winner === "HOME";
    const homeName = nameAt(m.homeTeamId, m.season);
    const awayName = nameAt(m.awayTeamId, m.season);
    games.push({ season: m.season, week: m.week ?? m.matchupPeriodId, team: homeName, score: m.homeScore, opp: awayName, oppScore: m.awayScore, won: homeWon });
    games.push({ season: m.season, week: m.week ?? m.matchupPeriodId, team: awayName, score: m.awayScore, opp: homeName, oppScore: m.homeScore, won: !homeWon });
    contests.push({ season: m.season, week: m.week ?? m.matchupPeriodId, home: homeName, away: awayName, homeScore: m.homeScore, awayScore: m.awayScore, margin: Math.abs(m.homeScore - m.awayScore), combined: m.homeScore + m.awayScore });
  }

  const top = (arr, n = 1) => arr.slice(0, n);
  const byScoreDesc = [...games].sort((a, b) => b.score - a.score);
  const byScoreAsc = [...games].sort((a, b) => a.score - b.score);
  const losses = games.filter((g) => !g.won).sort((a, b) => b.score - a.score);
  const wins = games.filter((g) => g.won).sort((a, b) => a.score - b.score);
  const byMarginDesc = [...contests].sort((a, b) => b.margin - a.margin);
  const byMarginAsc = [...contests].sort((a, b) => a.margin - b.margin);
  const byCombinedDesc = [...contests].sort((a, b) => b.combined - a.combined);
  const byCombinedAsc = [...contests].sort((a, b) => a.combined - b.combined);

  return {
    highestScore: top(byScoreDesc, 3),
    lowestScore: top(byScoreAsc, 3),
    bestHeartbreakLoss: top(losses, 3),
    ugliestWin: top(wins, 3),
    biggestBlowout: top(byMarginDesc, 3),
    closestGame: top(byMarginAsc, 3),
    highestCombined: byCombinedDesc[0] || null,
    lowestCombined: byCombinedAsc[0] || null,
  };
}

function computeRecords(matches, nameAt) {
  const regularSeason = matches.filter((m) => (m.playoffTierType || "NONE") === "NONE");
  const playoffs = matches.filter((m) => m.playoffTierType === "WINNERS_BRACKET");

  return {
    regularSeason: computeRecordsFromSlice(regularSeason, nameAt),
    playoffs: computeRecordsFromSlice(playoffs, nameAt),
  };
}

function renderRecords(records) {
  const el = document.getElementById("live-records");
  if (!el) return;

  const line = (label, entries) => {
    if (!entries || entries.length === 0) return "";
    const e = entries[0];
    if (e.team) {
      return `<div class="record-row"><span class="record-label">${label}</span><span class="record-val">${e.team} — ${e.score.toFixed(2)} (${e.season} wk${e.week})</span></div>`;
    }
    return `<div class="record-row"><span class="record-label">${label}</span><span class="record-val">${e.home} ${e.homeScore.toFixed(2)} vs ${e.away} ${e.awayScore.toFixed(2)} (${e.season} wk${e.week})</span></div>`;
  };

  const section = (title, r) => `
    <div class="record-section-title">${title}</div>
    ${line("Highest single-game score", r.highestScore)}
    ${line("Lowest single-game score", r.lowestScore)}
    ${line("Toughest heartbreak loss", r.bestHeartbreakLoss)}
    ${line("Ugliest win", r.ugliestWin)}
    ${line("Biggest blowout", r.biggestBlowout)}
    ${line("Closest game ever", r.closestGame)}
  `;

  el.innerHTML = section("Regular Season Records", records.regularSeason) + section("Playoff Records", records.playoffs);
}

document.addEventListener("b12live:ready", (e) => {
  const records = computeRecords(e.detail.matches, e.detail.managerNameAt);
  window.B12Live.records = records;
  renderRecords(records);
});
