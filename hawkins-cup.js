/*
 * Hawkins Cup bracket — Big 12 Fantasy Football
 *
 * Top 8 scorers from Week 1 qualify (seeded 1-8 by Week 1 point total),
 * bottom 4 are out immediately. Week 2 = Quarterfinals, Week 3 = Semifinals,
 * Week 4 = Final, matching the site's own "Road to the Hawkins Cup" copy
 * and existing static bracket markup in the Hawkins Cup tab. A team's Cup
 * result each week is decided by their real regular-season score that
 * week compared to their bracket opponent's — confirmed by the existing
 * note under the bracket: "scores are tied to the regular-season matchup
 * for that week."
 *
 * Load AFTER elo.js and data.js. Populates the EXISTING #panel-cup bracket
 * (the "#1 Seed" / "QF1 Winner" / etc. placeholders) in place — no new
 * markup needed, just fills in real names and scores as they become real.
 *
 * NOTE ON NAMING: every plain <script> tag on this page shares ONE global
 * scope — there's no module isolation. index.html's own season SIMULATOR
 * already declares a global `resolveCupRound(pairs, managerScores)` used to
 * resolve its own practice-season Hawkins Cup/playoff rounds. This file
 * used to declare its own function with that exact same name, which
 * silently overwrote the simulator's version (last script tag to load
 * wins) and broke the simulator's week-to-week advancing — the "Skip to
 * Week N" bug. Every helper here is now prefixed `hc` so this can't happen
 * again with any other script on the page.
 */

/*
 * Week scores, with a deliberate fallback.
 *
 * `matches` only carries matchups ESPN has marked decided (elo.js drops
 * anything still UNDECIDED, correctly — Elo must not count unfinished games).
 * But ESPN is slow to flip that flag: after Week 1 2026 every NFL game had
 * been over for hours while the fantasy matchups still read UNDECIDED with
 * totalPoints of 0, the real numbers sitting only in totalPointsLive.
 *
 * Waiting on ESPN's flag meant the Cup bracket stayed blank on a week that
 * was plainly finished. So if the official list doesn't cover all 12 teams,
 * fall back to the live scores in the matchup payload and mark the result
 * PROVISIONAL. It re-derives on every load, so once ESPN finalises (and any
 * stat corrections land) the bracket simply corrects itself.
 */
function hcGetTeamWeekScores(matches, season, week, live) {
  const scores = {};
  for (const m of matches) {
    if (m.season !== season) continue;
    if ((m.week ?? m.matchupPeriodId) !== week) continue;
    scores[m.homeTeamId] = m.homeScore;
    scores[m.awayTeamId] = m.awayScore;
  }
  if (Object.keys(scores).length >= 12 || !live) return scores;

  // Not all 12 official yet — top up from live numbers.
  const pools = [live.seasonMatchups || [], live.currentWeekMatchups || []];
  for (const pool of pools) {
    for (const g of pool) {
      if ((g.matchupPeriodId ?? g.week) !== week) continue;
      const hv = g.homeLive != null ? g.homeLive : g.homeScore;
      const av = g.awayLive != null ? g.awayLive : g.awayScore;
      if (scores[g.homeTeamId] == null && hv != null && hv > 0) scores[g.homeTeamId] = hv;
      if (scores[g.awayTeamId] == null && av != null && av > 0) scores[g.awayTeamId] = av;
    }
  }
  return scores;
}

// True when a week's scores had to lean on live numbers rather than ESPN's
// finalised matchups — used to label the bracket as provisional.
function hcWeekIsOfficial(matches, season, week) {
  let n = 0;
  for (const m of matches) {
    if (m.season !== season) continue;
    if ((m.week ?? m.matchupPeriodId) !== week) continue;
    n += 2;
  }
  return n >= 12;
}

function hcResolveRound(pairs, matches, season, week, live) {
  const weekScores = hcGetTeamWeekScores(matches, season, week, live);
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

function computeHawkinsCup(matches, currentSeason, nameAt, live) {
  const week1Scores = hcGetTeamWeekScores(matches, currentSeason, 1, live);
  const teamIds = Object.keys(week1Scores).map(Number);

  if (teamIds.length < 12) {
    return { status: "pending" };
  }

  // Seeded off live numbers because ESPN hasn't finalised the week yet.
  const provisional = !hcWeekIsOfficial(matches, currentSeason, 1);

  const ranked = teamIds
    .map((teamId) => ({ teamId, seedScore: week1Scores[teamId], name: nameAt(teamId, currentSeason) }))
    .sort((a, b) => b.seedScore - a.seedScore);

  const qualifiers = ranked.slice(0, 8).map((t, i) => ({ ...t, seed: i + 1 }));
  const eliminated = ranked.slice(8);

  const seed = (n) => qualifiers[n - 1];

  const qfPairs = [
    { round: "QF", index: 1, teamA: seed(1), teamB: seed(8) },
    { round: "QF", index: 2, teamA: seed(4), teamB: seed(5) },
    { round: "QF", index: 3, teamA: seed(2), teamB: seed(7) },
    { round: "QF", index: 4, teamA: seed(3), teamB: seed(6) },
  ];
  const qf = hcResolveRound(qfPairs, matches, currentSeason, 2, live);

  let sf = [];
  if (qf.every((r) => r.status === "final")) {
    const sfPairs = [
      { round: "SF", index: 1, teamA: qf[0].winner, teamB: qf[1].winner },
      { round: "SF", index: 2, teamA: qf[2].winner, teamB: qf[3].winner },
    ];
    sf = hcResolveRound(sfPairs, matches, currentSeason, 3, live);
  }

  let final = null;
  if (sf.length === 2 && sf.every((r) => r.status === "final")) {
    final = hcResolveRound([{ round: "Final", teamA: sf[0].winner, teamB: sf[1].winner }], matches, currentSeason, 4, live)[0];
  }

  return {
    status: "determined",
    provisional,
    qualifiers,
    eliminated,
    qf,
    sf,
    final,
    champion: final && final.status === "final" ? final.winner : null,
  };
}

// Given a team, finds their score/entry within a given round's results.
function scoreFor(teamId, roundEntries) {
  for (const r of roundEntries) {
    if (r.status !== "final") continue;
    if (r.teamA.teamId === teamId) return r.scoreA;
    if (r.teamB.teamId === teamId) return r.scoreB;
  }
  return null;
}

function renderHawkinsCup(cup) {
  const bracket = document.querySelector("#panel-cup .bracket");
  if (!bracket || cup.status !== "determined") return; // leave "TBD" placeholders as-is pre-Week-1

  bracket.querySelectorAll(".match-row").forEach((row) => {
    const seedSpan = row.querySelector(".match-seed");
    const nameSpan = row.querySelector(".match-name");
    const scoreSpan = row.querySelector(".match-score");
    if (!seedSpan || !nameSpan || !scoreSpan) return;
    const label = seedSpan.textContent.trim();

    // Quarterfinal rows are labeled "#1 Seed".."#8 Seed"
    const seedMatch = label.match(/^#(\d+) Seed$/);
    if (seedMatch) {
      const q = cup.qualifiers.find((x) => x.seed === Number(seedMatch[1]));
      if (!q) return;
      nameSpan.textContent = q.name;
      const s = scoreFor(q.teamId, cup.qf);
      if (s != null) scoreSpan.textContent = s.toFixed(2);
      return;
    }

    // Semifinal rows are labeled "QF1 Winner".."QF4 Winner"
    const qfMatch = label.match(/^QF(\d) Winner$/);
    if (qfMatch) {
      const qfEntry = cup.qf[Number(qfMatch[1]) - 1];
      if (!qfEntry || qfEntry.status !== "final") return;
      nameSpan.textContent = qfEntry.winner.name;
      const s = scoreFor(qfEntry.winner.teamId, cup.sf);
      if (s != null) scoreSpan.textContent = s.toFixed(2);
      return;
    }

    // Final row is labeled "SF1 Winner" / "SF2 Winner"
    const sfMatch = label.match(/^SF(\d) Winner$/);
    if (sfMatch) {
      const sfEntry = cup.sf[Number(sfMatch[1]) - 1];
      if (!sfEntry || sfEntry.status !== "final") return;
      nameSpan.textContent = sfEntry.winner.name;
      if (cup.final && cup.final.status === "final") {
        const s = cup.final.teamA.teamId === sfEntry.winner.teamId ? cup.final.scoreA : cup.final.scoreB;
        scoreSpan.textContent = s.toFixed(2);
      }
    }
  });

  // Say so when the field is seeded off live scores ESPN hasn't finalised.
  // Stat corrections can still move a seed, and on a 0.4-point cut line that
  // matters — better to flag it than let people assume it's settled.
  let note = document.querySelector("#panel-cup .cup-provisional-note");
  if (cup.provisional) {
    if (!note) {
      note = document.createElement("div");
      note.className = "cup-provisional-note";
      bracket.parentNode.insertBefore(note, bracket);
    }
    note.innerHTML = "<strong>Provisional.</strong> Every Week 1 game is over, but ESPN "
      + "hasn't stamped the matchups final yet, so this is seeded from live scores. "
      + "It re-checks on every load and will correct itself if a stat adjustment "
      + "moves a seed.";
  } else if (note) {
    note.remove();
  }

  if (cup.champion) {
    let banner = document.querySelector("#panel-cup .cup-champion-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.className = "cup-champion-banner";
      bracket.parentNode.insertBefore(banner, bracket.nextSibling);
    }
    banner.innerHTML = `&#127942; ${cup.champion.name} wins the Hawkins Cup`;
  }
}

document.addEventListener("b12live:ready", (e) => {
  const cup = computeHawkinsCup(
    e.detail.matches, e.detail.live.season, e.detail.managerNameAt, e.detail.live);
  window.B12Live.hawkinsCup = cup;
  renderHawkinsCup(cup);
});
