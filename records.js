/*
 * League Records — Big 12 Fantasy Football
 * Load AFTER elo.js and data.js. Renders into id="live-records" as
 * feature-card tiles matching the site's existing card-grid styling.
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

  return {
    highestScore: top(byScoreDesc, 1),
    lowestScore: top(byScoreAsc, 1),
    bestHeartbreakLoss: top(losses, 1),
    ugliestWin: top(wins, 1),
    biggestBlowout: top(byMarginDesc, 1),
    closestGame: top(byMarginAsc, 1),
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

  const card = (kicker, entry, isGame) => {
    if (!entry) return "";
    let title, copy;
    if (isGame) {
      title = `${entry.score.toFixed(2)} pts`;
      copy = `${entry.team} ${entry.won ? "beat" : "lost to"} ${entry.opp} ${entry.oppScore.toFixed(2)} &mdash; ${entry.season}, Week ${entry.week}`;
    } else {
      title = `${entry.margin.toFixed(2)} pt margin`;
      copy = `${entry.home} ${entry.homeScore.toFixed(2)} vs ${entry.away} ${entry.awayScore.toFixed(2)} &mdash; ${entry.season}, Week ${entry.week}`;
    }
    return `<div class="feature-card">
      <div class="feature-k">${kicker}</div>
      <div class="feature-v">${title}</div>
      <div class="feature-copy">${copy}</div>
    </div>`;
  };

  const section = (r) => `
    ${card("Highest Score", r.highestScore[0], true)}
    ${card("Lowest Score", r.lowestScore[0], true)}
    ${card("Biggest Blowout", r.biggestBlowout[0], false)}
    ${card("Closest Game", r.closestGame[0], false)}
    ${card("Toughest Heartbreak", r.bestHeartbreakLoss[0], true)}
    ${card("Ugliest Win", r.ugliestWin[0], true)}
  `;

  const hasPlayoffData = records.playoffs.highestScore.length > 0;

  el.innerHTML = `
    <div class="card-grid">${section(records.regularSeason)}</div>
    ${hasPlayoffData ? `<div class="road-title">Playoff Records</div><div class="card-grid">${section(records.playoffs)}</div>` : ""}
  `;
}

document.addEventListener("b12live:ready", (e) => {
  const records = computeRecords(e.detail.matches, e.detail.managerNameAt);
  window.B12Live.records = records;
  renderRecords(records);
});
