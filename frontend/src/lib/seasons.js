import { api } from './api.js';
import { useFetch } from './useFetch.js';

/** GET /seasons: [{season, types, final_games}] newest first + meta.latest_with_games. */
export function useSeasons() {
  return useFetch('seasons', (signal) => api('/seasons', { signal }));
}

export const SEASON_TYPE_OPTIONS = [['regular', 'Regular'], ['play_in', 'Play-In'], ['playoffs', 'Playoffs'], ['all', 'All']];
