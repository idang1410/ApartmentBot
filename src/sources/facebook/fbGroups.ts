import type { CityEntry } from '../../core/types.js';

/**
 * Facebook groups to read, per city key.
 *
 * These are groups the owner is already a member of - the bot cannot see a
 * private group otherwise, and joining one is a human decision. Values are the
 * slug or numeric id from the group URL:
 * facebook.com/groups/<slug-or-id>/
 *
 * More groups cost little: only posts nobody has judged yet reach the model,
 * so a group that repeats the same twenty posts for a week costs one call.
 */
export const FACEBOOK_GROUPS: Record<string, string[]> = {
  modiin: [
    'apartmentsmodiin', // דירות להשכרה ומכירה במודיעין ללא תיווך
    'modeiin.housing', // דירות להשכרה ומכירה במודיעין
    'diramodiin', // דירות להשכרה במודיעין
    'nadlan.modiin', // נדל"ן מודיעין
  ],
  // Rishon LeZion groups go here once the owner has joined them - the big city
  // groups, the "ללא תיווך" ones, and any neighbourhood group. Until then the
  // source simply does not run for Rishon.
  rishon: [],
  'tel-aviv': [
    '1492833544374932', // לוח דירות תל אביב- יפו-המובילה
    '718718724880874', // דירות להשכרה מכירה בתל אביב ריקות ושותפים
    '912651298791978', // Secret - Apartments/flats for rent in Tel aviv
    '429827780505313', // דירות שוות לזוגות ושותפים בתל אביב
    '349708402600974', // דירות בתל אביב צפון הישן
    'telavivrentals', // דירות צפון ישן מרכז לב תל אביב זה כאן
    '174312609376409', // דירות להשכרה במרכז תל אביב
    '108784732614979', // דירות מפייס לאוזן בתל אביב
    '1196843027043598', // דירות להשכרה מכירה תל אביב Tel Aviv Apartments
    '35819517694', // דירות מפה לאוזן בת"א
    '214095470858484', // להשכרה בתל אביב For rent in Tel Aviv
    '1593109454272943', // דירות מפה לאוזן בתל אביב
    '584681171701217', // דירות מפה לאוזן תל אביב
    '1427929940815001', // דירות להשכרה ללא תיווך יחידים , זוגות , שותפים
  ],
};

export function groupsForCity(city: CityEntry): string[] {
  return FACEBOOK_GROUPS[city.key] ?? [];
}
