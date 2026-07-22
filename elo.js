/*
 * Persistent Manager Elo — Big 12 Fantasy Football
 *
 * Pure, stateless rating engine. Every run replays the FULL match history
 * (2024, 2025, and however much of 2026 has happened) from scratch through
 * the Elo formula and produces current ratings. No stored/incremental state
 * to get out of sync — feed it more matches next week, get updated ratings.
 *
 * Each match object needs: { homeTeamId, awayTeamId, homeScore, awayScore, winner }
 * `winner` must be "HOME", "AWAY", or "TIE" — matches still "UNDECIDED" should
 * be filtered out before calling this (they haven't happened yet).
 */

const DEFAULT_OPTIONS = {
  startingRating: 1500,
  kFactor: 32,
  useMarginOfVictory: true,
  movDampener: 2.2,
};

function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

function movMultiplier(scoreA, scoreB, ratingA, ratingB, dampener) {
  const margin = Math.abs(scoreA - scoreB);
  const ratingDiff = ratingA - ratingB;
  return Math.log(margin + 1) * (dampener / ((ratingDiff * 0.001) + dampener));
}

function computeElo(matches, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const ratings = {};
  const history = {};

  const resetSeasons = opts.resetSeasons || {};
  const alreadyReset = new Set();

  function ensureTeam(teamId) {
    if (!(teamId in ratings)) {
      ratings[teamId] = opts.startingRating;
      history[teamId] = [];
    }
  }

  function maybeReset(teamId, season) {
    const resetAt = resetSeasons[teamId];
    if (resetAt != null && season >= resetAt && !alreadyReset.has(teamId)) {
      ratings[teamId] = opts.startingRating;
      history[teamId] = [];
      alreadyReset.add(teamId);
    }
  }

  let latestSeasonSeen = 0;

  for (const m of matches) {
    const { homeTeamId, awayTeamId, homeScore, awayScore, winner, season, week } = m;
    if (winner === "UNDECIDED" || winner == null) continue;
    if (season > latestSeasonSeen) latestSeasonSeen = season;

    ensureTeam(homeTeamId);
    ensureTeam(awayTeamId);
    maybeReset(homeTeamId, season);
    maybeReset(awayTeamId, season);

    const rHome = ratings[homeTeamId];
    const rAway = ratings[awayTeamId];

    const expHome = expectedScore(rHome, rAway);
    const expAway = 1 - expHome;

    let actualHome;
    if (winner === "HOME") actualHome = 1;
    else if (winner === "AWAY") actualHome = 0;
    else actualHome = 0.5;

    let k = opts.kFactor;
    if (opts.useMarginOfVictory && winner !== "TIE") {
      k *= movMultiplier(homeScore, awayScore, rHome, rAway, opts.movDampener);
    }

    const deltaHome = k * (actualHome - expHome);
    const deltaAway = k * ((1 - actualHome) - expAway);

    ratings[homeTeamId] = rHome + deltaHome;
    ratings[awayTeamId] = rAway + deltaAway;

    history[homeTeamId].push({ season, week, rating: ratings[homeTeamId] });
    history[awayTeamId].push({ season, week, rating: ratings[awayTeamId] });
  }

  const currentSeason = opts.currentSeason ?? latestSeasonSeen;
  for (const teamIdStr of Object.keys(resetSeasons)) {
    const teamId = Number(teamIdStr);
    const resetAt = resetSeasons[teamId];
    if (resetAt <= currentSeason && !alreadyReset.has(teamId)) {
      ratings[teamId] = opts.startingRating;
      history[teamId] = [];
      alreadyReset.add(teamId);
    }
  }

  return { ratings, history };
}

const EXCLUDED_TIERS = new Set(["WINNERS_CONSOLATION_LADDER", "LOSERS_CONSOLATION_LADDER"]);

function isCountedTier(playoffTierType) {
  return !EXCLUDED_TIERS.has(playoffTierType);
}

function buildMatchListFromEspnFiles(historyJson, liveJson) {
  const matches = [];

  const seasonOrder = Object.keys(historyJson.seasons || {}).sort();
  for (const season of seasonOrder) {
    for (const m of historyJson.seasons[season].allMatchups) {
      if (!isCountedTier(m.playoffTierType)) continue;
      matches.push({ ...m, season: Number(season), week: m.matchupPeriodId });
    }
  }

  if (liveJson && liveJson.seasonMatchups) {
    for (const m of liveJson.seasonMatchups) {
      if (m.winner === "UNDECIDED") continue;
      if (!isCountedTier(m.playoffTierType)) continue;
      matches.push({ ...m, season: liveJson.season, week: m.matchupPeriodId });
    }
  }

  return matches;
}
