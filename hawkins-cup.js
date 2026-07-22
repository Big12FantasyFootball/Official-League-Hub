/*
 * Hawkins Cup bracket — Big 12 Fantasy Football
 *
 * Top 8 scorers from Week 1 qualify (seeded 1-8 by Week 1 point total),
 * bottom 4 are out immediately. Week 2 = Quarterfinals, Week 3 = Semifinals,
 * Week 4 = Final. A team's Cup result each week is decided by comparing
 * the two BRACKET-PAIRED teams' real scores that week, not by their real
 * ESPN opponent. Flag if that assumption's wrong.
 *
 * Load AFTER elo.js and data.js.
 * Standard 8-team seeding: QF1: 1v8  QF2: 4v5  QF3: 3v6  QF4: 2v7
 */

function getTeamWeekScores(matches, season, week) {
  const scores = {};
  for (const m of matches) {
    if (m.season !== season) continue;
    if ((m.week ?? m.matchupPeriodId) !== week) continue;
    scores[m.homeTeamId] = m.homeScore;
    scores[m.awayTeamId] = m.awayScore;
  }
  return scores;
}

function resolveCupRound(pairs, matches, season, week) {
  const weekScores = getTeamWeekScores(matches, season, week);
  return pairs.map((p) => {
    const scoreA = weekScores[p.teamA.teamId];
    const scoreB = weekScores[p.teamB.teamId];
    if (scoreA == null || scoreB == null) {
      return { ...p, scoreA, scoreB, winner: null, status: "pending" };
    }
    const winner = scoreA >= scoreB ? p.teamA : p.teamB;
    return { ...p, scoreA, scoreB, winner, status: "final" };
  });
}

function computeHawkinsCup(matches, currentSeason, nameAt) {
  const week1Scores = getTeamWeekScores(matches, currentSeason, 1);
  const teamIds = Object.keys(week1Scores).map(Number);

  if (teamIds.length < 12) {
    return {
      status: "pending",
      message: "Week 1 isn't complete yet — the Cup field locks in once every team has a Week 1 score.",
    };
  }

  const ranked = teamIds
    .map((teamId) => ({ teamId, seedScore: week1Scores[teamId], name: nameAt(teamId, currentSeason) }))
    .sort((a, b) => b.seedScore - a.seedScore);

  const qualifiers = ranked.slice(0, 8).map((t, i) => ({ ...t, seed: i + 1 }));
  const eliminated = ranked.slice(8);

  const seed = (n) => qualifiers[n - 1];

  const qfPairs = [
    { round: "QF", teamA: seed(1), teamB: seed(8) },
    { round: "QF", teamA: seed(4), teamB: seed(5) },
    { round: "QF", teamA: seed(3), teamB: seed(6) },
    { round: "QF", teamA: seed(2), teamB: seed(7) },
  ];
  const qf = resolveCupRound(qfPairs, matches, currentSeason, 2);

  let sf = [];
  const qfDone = qf.every((r) => r.status === "final");
  if (qfDone) {
    const sfPairs = [
      { round: "SF", teamA: qf[0].winner, teamB: qf[1].winner },
      { round: "SF", teamA: qf[2].winner, teamB: qf[3].winner },
    ];
    sf = resolveCupRound(sfPairs, matches, currentSeason, 3);
  }

  let final = null;
  const sfDone = sf.length === 2 && sf.every((r) => r.status === "final");
  if (sfDone) {
    const finalPair = [{ round: "Final", teamA: sf[0].winner, teamB: sf[1].winner }];
    final = resolveCupRound(finalPair, matches, currentSeason, 4)[0];
  }

  return {
    status: "determined",
    qualifiers,
    eliminated,
    qf,
    sf,
    final,
    champion: final && final.status === "final" ? final.winner : null,
  };
}

function renderHawkinsCup(cup) {
  const el = document.getElementById("live-hawkins-cup");
  if (!el) return;

  if (cup.status === "pending") {
    el.innerHTML = `<div class="cup-pending">${cup.message}</div>`;
    return;
  }

  const matchupLine = (m) => {
    if (!m) return "";
    const a = m.teamA ? `${m.teamA.name}${m.teamA.seed ? " (#" + m.teamA.seed + ")" : ""}` : "TBD";
    const b = m.teamB ? `${m.teamB.name}${m.teamB.seed ? " (#" + m.teamB.seed + ")" : ""}` : "TBD";
    const scoreStr = m.status === "final" ? ` — ${m.scoreA.toFixed(2)} to ${m.scoreB.toFixed(2)}` : " — pending";
    const winnerStr = m.status === "final" ? ` (${m.winner.name} advances)` : "";
    return `<div class="cup-matchup">${a} vs ${b}${scoreStr}${winnerStr}</div>`;
  };

  const fieldList = cup.qualifiers.map((q) => `<li>#${q.seed} ${q.name} — ${q.seedScore.toFixed(2)}</li>`).join("");
  const outList = cup.eliminated.map((q) => `<li>${q.name} — ${q.seedScore.toFixed(2)}</li>`).join("");

  el.innerHTML = `
    <div class="cup-section-title">Cup Field (seeded by Week 1 score)</div>
    <ul class="cup-field-list">${fieldList}</ul>
    <div class="cup-section-title">Eliminated Week 1</div>
    <ul class="cup-field-list">${outList}</ul>
    <div class="cup-section-title">Quarterfinals (Week 2)</div>
    ${cup.qf.map(matchupLine).join("")}
    <div class="cup-section-title">Semifinals (Week 3)</div>
    ${cup.sf.length ? cup.sf.map(matchupLine).join("") : '<div class="cup-pending">Set once Quarterfinals finish</div>'}
    <div class="cup-section-title">Final (Week 4)</div>
    ${cup.final ? matchupLine(cup.final) : '<div class="cup-pending">Set once Semifinals finish</div>'}
    ${cup.champion ? `<div class="cup-champion">🏆 ${cup.champion.name} wins the Hawkins Cup</div>` : ""}
  `;
}

document.addEventListener("b12live:ready", (e) => {
  const cup = computeHawkinsCup(e.detail.matches, e.detail.live.season, e.detail.managerNameAt);
  window.B12Live.hawkinsCup = cup;
  renderHawkinsCup(cup);
});
