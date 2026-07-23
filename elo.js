/*
 * Persistent Manager Elo — Big 12 Fantasy Football
 *
 * Pure, stateless rating engine. Every run replays the FULL match history
 * (2024, 2025, and however much of 2026 has happened) from scratch through
 * the Elo formula and produces current ratings. No stored/incremental state
 * to get out of sync — feed it more matches next week, get updated ratings.
 *
 * Usage:
 *   const { ratings, history } = computeElo(matches);
 *   // ratings: { teamId: currentRating }
 *   // history: { teamId: [ {season, week, rating}, ... ] }  (for charting)
 *
 * `matches` must be in chronological order: 2024 season, then 2025, then
 * 2026 in-progress. Build this array by concatenating:
 *   - espn_history.json  -> seasons["2024"].allMatchups, seasons["2025"].allMatchups
 *   - espn_data.json     -> currentWeekMatchups (and, once you start archiving
 *                           weekly snapshots, every prior 2026 week too)
 *
 * Each match object needs: { homeTeamId, awayTeamId, homeScore, awayScore, winner }
 * `winner` must be "HOME", "AWAY", or "TIE" — matches still "UNDECIDED" should
 * be filtered out before calling this (they haven't happened yet).
 */

const DEFAULT_OPTIONS = {
  startingRating: 1500,
  kFactor: 32,
  useMarginOfVictory: true,   // blowouts move ratings more than nail-biters
  movDampener: 2.2,           // higher = MOV matters less; tune to taste
};

function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

// FiveThirtyEight-style margin-of-victory multiplier, adapted for fantasy
// point differentials instead of point-spread-adjusted score margins.
function movMultiplier(scoreA, scoreB, ratingA, ratingB, dampener) {
  const margin = Math.abs(scoreA - scoreB);
  const ratingDiff = ratingA - ratingB;
  return Math.log(margin + 1) * (dampener / ((ratingDiff * 0.001) + dampener));
}

function computeElo(matches, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const ratings = {};
  const history = {};

  // resetSeasons: { teamId: season } — if a teamId changed hands (ESPN
  // reassigns the same slot to a new manager), the new manager's rating
  // resets to startingRating the moment their first game of that season
  // is processed. Earlier matches under that teamId still ran through the
  // loop normally (so the departed manager's opponents got real credit),
  // this just stops the new manager from inheriting the old number.
  const resetSeasons = opts.resetSeasons || {};
  const alreadyReset = new Set();

  // Snapshot of each departed manager's FINAL rating/history at the moment
  // their slot got reset — otherwise that number would just be overwritten
  // by the incoming manager's fresh 1500 and lost entirely. Keyed by teamId
  // (the slot they used to hold), used by callers who want to still show
  // Dillon Jacobs/Timmy Hoffman/etc. as their own leaderboard entries.
  const departedRatings = {};
  const departedHistory = {};

  function ensureTeam(teamId) {
    if (!(teamId in ratings)) {
      ratings[teamId] = opts.startingRating;
      history[teamId] = [];
    }
  }

  function maybeReset(teamId, season) {
    const resetAt = resetSeasons[teamId];
    if (resetAt != null && season >= resetAt && !alreadyReset.has(teamId)) {
      departedRatings[teamId] = ratings[teamId];
      departedHistory[teamId] = history[teamId];
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
    else actualHome = 0.5; // TIE

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

  // Final pass: a manager whose reset season has already arrived (per
  // currentSeason, e.g. the live season we're pulling right now) but who
  // hasn't played a game yet should still show a fresh 1500, not whatever
  // their predecessor's rating happened to be. Without this, a new manager
  // sitting at 0-0 in the preseason would silently inherit the old owner's
  // number until their first game finally triggers the in-loop reset above.
  const currentSeason = opts.currentSeason ?? latestSeasonSeen;
  for (const teamIdStr of Object.keys(resetSeasons)) {
    const teamId = Number(teamIdStr);
    const resetAt = resetSeasons[teamId];
    if (resetAt <= currentSeason && !alreadyReset.has(teamId)) {
      if (teamId in ratings) {
        departedRatings[teamId] = ratings[teamId];
        departedHistory[teamId] = history[teamId];
      }
      ratings[teamId] = opts.startingRating;
      history[teamId] = [];
      alreadyReset.add(teamId);
    }
  }

  return { ratings, history, departedRatings, departedHistory };
}

// Consolation-ladder games (both winners' and losers' brackets) don't
// reflect real competitive standing — everyone who doesn't make the real
// playoffs still gets shuffled into one of these ladders and plays out
// meaningless games. Only regular season ("NONE") and the real playoff
// bracket ("WINNERS_BRACKET") should count toward Elo or records.
const EXCLUDED_TIERS = new Set(["WINNERS_CONSOLATION_LADDER", "LOSERS_CONSOLATION_LADDER"]);

function isCountedTier(playoffTierType) {
  return !EXCLUDED_TIERS.has(playoffTierType);
}

// Convenience: turn espn_history.json + espn_data.json into one chronological
// match list computeElo() can consume directly. Consolation-bracket games
// are filtered out here so every consumer (Elo, records) automatically
// gets the same clean set — regular season + real playoffs only.
function buildMatchListFromEspnFiles(historyJson, liveJson) {
  const matches = [];

  const seasonOrder = Object.keys(historyJson.seasons || {}).sort();
  for (const season of seasonOrder) {
    for (const m of historyJson.seasons[season].allMatchups) {
      if (!isCountedTier(m.playoffTierType)) continue;
      matches.push({ ...m, season: Number(season), week: m.matchupPeriodId });
    }
  }

  // seasonMatchups covers every completed week of the current season so
  // far (not just whatever week happens to be "current" today) — needed so
  // Elo keeps accumulating correctly as the season progresses, instead of
  // only ever seeing the latest week each time this runs.
  if (liveJson && liveJson.seasonMatchups) {
    for (const m of liveJson.seasonMatchups) {
      if (m.winner === "UNDECIDED") continue;
      if (!isCountedTier(m.playoffTierType)) continue;
      matches.push({ ...m, season: liveJson.season, week: m.matchupPeriodId });
    }
  }

  return matches;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { computeElo, buildMatchListFromEspnFiles, expectedScore };
}
