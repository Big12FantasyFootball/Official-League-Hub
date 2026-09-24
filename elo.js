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

/*
 * kFactor was 32 — the chess default — but chess K is applied to a RAW result.
 * Here it is multiplied by a margin-of-victory term that routinely reaches 3-4x,
 * so the effective K was closer to 100 and single games swung ratings by up to
 * 119 points on a 1500 scale. That is roughly four chess games' worth of
 * movement from one Sunday, and it made the board track last week rather than
 * true strength.
 *
 * Chosen by walk-forward evaluation over the real 2024-2026 match list: predict
 * each game from the ratings as they stand, score the prediction, then update.
 * 2024 is burn-in, so 101 games (2025 + 2026 to date) are graded.
 *
 *     K       Brier      accuracy   max single-game swing
 *     32      0.2474     62.4%      119      <- old setting
 *     20      0.2378     64.4%       49
 *     16      0.2366     63.4%       38
 *     12      0.2353     62.4%       37      <- chosen
 *      8      0.2354     62.4%       22
 *
 * A coin flip scores 0.2500, so K=32 was capturing almost none of the available
 * signal. Accuracy is unchanged at K=12 while Brier improves, which means the
 * picks were already fine and it was the CONFIDENCE that was miscalibrated:
 * K=32 was overconfident.
 *
 * Honest limit: a paired bootstrap puts K=12 ahead of K=32 in 89.7% of
 * resamples, but the 95% CI is [-0.006, +0.031] and crosses zero. On 101 games
 * this is suggestive, not significant. The independent reason to prefer it is
 * that a 119-point swing from one game is not defensible whatever the test says.
 * Revisit once there are a few hundred more games.
 */
const DEFAULT_OPTIONS = {
  startingRating: 1500,
  kFactor: 12,
  useMarginOfVictory: true,   // blowouts move ratings more than nail-biters
  movDampener: 2.2,           // higher = MOV matters less; tune to taste
};

function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/*
 * FiveThirtyEight-style margin-of-victory multiplier, adapted for fantasy
 * point differentials instead of point-spread-adjusted score margins.
 *
 * THE ARGUMENTS ARE WINNER-FIRST, AND THAT IS THE WHOLE POINT.
 *
 * This previously took (home, away) and computed ratingDiff as
 * homeRating - awayRating. That is not what the 538 formula means. The term
 * exists to correct for autocorrelation: when a strong team beats a weak one,
 * the result is unsurprising and the rating should move LESS; when an underdog
 * wins, it should move MORE. That requires WINNER minus LOSER.
 *
 * Using home minus away made the multiplier depend on which side ESPN happened
 * to label "home" — a label that carries no meaning at all in fantasy football,
 * where there is no venue and no home advantage. Measured on the real 2024-26
 * match list, an identical game (favourite wins by 30 over an opponent rated
 * 400 lower) produced a multiplier of 2.91 with the favourite at home and 4.20
 * with the favourite away: a 44% larger rating swing from a coin-flip label.
 * Seven of twelve managers changed rank once corrected.
 *
 * The clamp is not decoration. The denominator (ratingDiff * 0.001 + 2.2)
 * reaches ZERO when the winner is rated ~2200 below the loser and goes NEGATIVE
 * beyond that — which would flip the sign of the rating change and push the
 * winner's rating DOWN. The league's widest gap today is ~454 so it has never
 * fired, but a rating system that silently inverts past a threshold is not one
 * to leave unguarded.
 */
function movMultiplier(winnerScore, loserScore, winnerRating, loserRating, dampener) {
  const margin = Math.abs(winnerScore - loserScore);
  const ratingDiff = winnerRating - loserRating;
  const denom = Math.max((ratingDiff * 0.001) + dampener, 0.25);
  return Math.log(margin + 1) * (dampener / denom);
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

    /*
     * Derive the result from the SCORES, not just ESPN's winner label. An
     * exact tie is possible in fantasy and ESPN's label for one is not
     * something to guess at — if the two totals are equal it is a tie, full
     * stop. Previously a dead-even game would have been scored as a clean win
     * for whichever side the label happened to name.
     */
    const isTie = homeScore != null && awayScore != null && homeScore === awayScore;
    let actualHome;
    if (isTie) actualHome = 0.5;
    else if (winner === "HOME") actualHome = 1;
    else if (winner === "AWAY") actualHome = 0;
    else actualHome = 0.5;

    let k = opts.kFactor;
    if (opts.useMarginOfVictory && !isTie) {
      // Winner first — see the note on movMultiplier.
      const homeWon = actualHome === 1;
      k *= movMultiplier(
        homeWon ? homeScore : awayScore,
        homeWon ? awayScore : homeScore,
        homeWon ? rHome : rAway,
        homeWon ? rAway : rHome,
        opts.movDampener);
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
