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
  // Florentin and Jaffa: the owner's areas.
  'tel-aviv': [
    '282971075172305',
    '305724686290054',
    '1529488140613580', // דירות שוות בפלורנטין ללא תיווך
    'florentinrentals', // פלורנטין לוח דירות
    '250039025123837', // דירות להשכרה בפלורנטין
    '355014791349237', // Tel Aviv secret Florentine Group
    '296346570481003', // דירות להשכרה בפלורנטין
    '1963585216999831', // דירות בין חברים פלורנטין והסביבה
    '984493515014643', // דירות להשכרה בפלורנטין הסביבה וצפון יפו
    '573303232756062', // דירות להשכרה פלורנטין
    '799178415987802', // פלורנטין והסביבה. דירות להשכרה
    '141136760102682', // דירות להשכרה ומכירה פלורנטין
    '534654323319632', // דירות להשכרה בכרם התימנים, נווה צדק, פלורנטין
    '208978618098229', // דירות להשכרה בשכונת פלורנטין והסביבה
    '186565171064368', // דירות להשכרה בפלורנטין והסביבה
    '747320376058590', // דירות בין חברים פלורנטין והסביבה
    '252996637878752', // דירות בפלורנטין בכרם נווה צדק לב העיר והסביבה
    '188311471748006', // דירות בפלורנטין
    '743669175688649', // דירות להשכרה ביפו
    '711814002180965', // דירות ביפו - תל אביב והסביבה
    '1613526922033848', // דירות שוות בצפון יפו (נגה, פשפשים, פלורנטין)
    'jaffarent', // דירות ביפו והסביבה להשכרה
    '431777307446085', // דירות ומציאות ביפו
    '813086479024117', // דירות להשכרה ביפו
    '446464629539590', // דירות להשכרה בשוק
  ],
};

/** City-wide groups, read a few per run in turn so that one run stays short. */
export const ROTATING_GROUPS: Record<string, string[]> = {
  'tel-aviv': [
    '1492833544374932', // לוח דירות תל אביב- יפו-המובילה
    '718718724880874', // דירות להשכרה מכירה בתל אביב ריקות ושותפים
    '912651298791978', // Secret - Apartments/flats for rent in Tel aviv
    '429827780505313', // דירות שוות לזוגות ושותפים בתל אביב
    '108784732614979', // דירות מפייס לאוזן בתל אביב
    '1196843027043598', // דירות להשכרה מכירה תל אביב Tel Aviv Apartments
    '35819517694', // דירות מפה לאוזן בת"א
    '214095470858484', // להשכרה בתל אביב For rent in Tel Aviv
    '1593109454272943', // דירות מפה לאוזן בתל אביב
    '584681171701217', // דירות מפה לאוזן תל אביב
    '1427929940815001', // דירות להשכרה ללא תיווך יחידים , זוגות , שותפים
    '2541381749432833', // דירות שוות להשכרה בתל אביב
    'TelAvivApartments', // Looking for an Apartment in Tel Aviv
    '1749183625345821', // דירות זולות להשכרה בתל אביב (בלי תיווך)
    '314227591934262', // Tel Aviv Area apartments, rooms
    'tlv.rental.apartments', // דירות להשכרה בתל אביב
    '1340182724091096', // דירות להשכרה בתל אביב
    'TLVAPT', // דירות תל אביב Tel Aviv Apartments
    '599822590152094', // דירות שוות להשכרה בתל אביב
    'emptyLiveableTLVapartments', // דירות להשכרה בתל אביב
    '391306014262850', // דירות לזוגות ושותפים בתל אביב להשכרה בלבד
    '1432828703704444', // TEL AVIV APARTMENT RENTALS ENGLISH NO REALESTATE AGENTS
    '127333294132312', // Looking for an apartment/room or sublet in Tel Aviv (No Realtors)
    'tel.aviv.dirot', // לוח דירות תל אביב-יפו
    '295395253832427', // דירות בתל אביב
    '333022240594651', // דירות להשכרה במחירים שפויים תל אביב
    '457465901082882', // דירות בתל אביב ללא תיווך
    '1110501595666914', // דירות בתל אביב ללא תיווך
    '13625164631', // Tel Aviv Apartment available
    '2062839573767306', // תל אביבית - דירות למכירה / השכרה בתל אביב
    'ApartmentsrentinTelAviv', // דירות להשכרה/מכירה בתל אביב
    '1673941052823845', // דירות להשכרה בתל אביב
    '2098391913533248', // דירות להשכרה בגבעתיים ר"ג ותל אביב
    'tlvapartment', // דירות בתל אביב ללא תיווך
    '968184269974550', // דירות מציאה מפייס לאוזן בת״א המאגר המלא
    '2065942027026008', // דירות מציאה מפייס לאוזן בתל אביב המאגר המלא
    '701606563293824', // דירות מציאה מפייס לאוזן בת"א לזוגות ושותפים
    '1756832341197124', // דירות להשכרה תל אביב
    '1132155870320163', // דירות מציאה להשכרה לשותפים וזוגות בתל אביב
    '101875683484689', // דירות מפה לאוזן בתל אביב
    'barothashaga', // דירות להשכרה בתל אביב ללא תיווך
    'ApartmentsTelAviv', // דירות להשכרה ריקות או שותפים בתל אביב
    '458499457501175', // דירות להשכרה לזוגות, שותפים ומשפחות בתל אביב
    '1418386708398199', // דירות להשכרה בתל אביב - המאגר המלא
  ],
};

const ROTATING_PER_RUN = 12;
const rotation = new Map<string, number>();

export function groupsForCity(city: CityEntry): string[] {
  return [...(FACEBOOK_GROUPS[city.key] ?? []), ...(ROTATING_GROUPS[city.key] ?? [])];
}

/** The groups for one run: every fixed group, then the next slice of the rotating ones. */
export function groupsToRead(city: CityEntry): string[] {
  const rotating = ROTATING_GROUPS[city.key] ?? [];
  const start = rotation.get(city.key) ?? 0;
  const slice = Array.from(
    { length: Math.min(ROTATING_PER_RUN, rotating.length) },
    (_, i) => rotating[(start + i) % rotating.length]!,
  );
  if (rotating.length > 0) rotation.set(city.key, (start + slice.length) % rotating.length);
  return [...(FACEBOOK_GROUPS[city.key] ?? []), ...slice];
}
