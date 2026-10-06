import { InlineKeyboard } from 'grammy';
import type { Context } from 'grammy';
import {
  REGION_ALIASES,
  findCityByKey,
  isKnownAreaName,
  normalizePlace,
  searchCities,
} from '../core/cities.js';
import { lookupPlaces } from '../core/places.js';
import { AMENITY_VOCABULARY, describeSearch, nearMissReason } from '../core/filter.js';
import { applyDraftToExisting, type SearchDraft } from '../llm/parseSearchRequest.js';
import { CARDS_PAGE, formatDigest, orderSnapshot } from './digest.js';
import type { PollCycle } from '../core/pollCycle.js';
import type { SavedSearch, SearchRequirements } from '../core/types.js';
import type { ListingsRepo } from '../db/listings.repo.js';
import type { SearchesRepo } from '../db/searches.repo.js';
import { logger } from '../logger.js';
import { escapeHtml, searchTitle } from './format.js';

type Step =
  | 'city'
  | 'rooms'
  | 'price'
  | 'custom-rooms'
  | 'custom-price'
  | 'custom-area'
  | 'custom-sqm'
  | 'custom-keyword';

interface WizardState {
  step: Step;
  /** Cities chosen so far; the picker toggles entries in and out. */
  cityKeys: string[];
  /**
   * The city buttons on screen. The picker cannot list ~1,300 cities, so it shows the
   * chosen ones, whatever was typed last, and a few familiar ones, and it must keep showing
   * the same set while cities are toggled.
   */
  offeredCityKeys: string[];
  minRooms: number | null;
  maxRooms: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  /** City key -> chosen streets and neighbourhoods. Empty means whole city. */
  areas: Record<string, string[]>;
  /** The city whose areas are being edited, while that screen is open. */
  areaCity: string | null;
  /**
   * What the area keyboard is currently showing. Telegram limits callback
   * data to 64 bytes, too small for a Hebrew street name, so buttons carry
   * an index into this list instead of the name itself.
   */
  areaOptions: string[];
  /** Must-haves beyond the bounds; empty object means none. */
  requirements: SearchRequirements;
  /**
   * The saved search this wizard was opened on, if any.
   *
   * /add prefills from the last search, so it reads as editing that one. Its
   * id is carried here so a save that changed the bounds can offer to update
   * it instead of quietly leaving it running alongside the new one.
   */
  originId: number | null;
}

/** At most this many typed keywords, so the button label stays readable. */
const MAX_KEYWORDS = 5;

/** Cities per keyboard row - three fits Hebrew names without truncating. */
const CITIES_PER_ROW = 3;

/** City buttons shown before anything is typed. */
const MAX_CITY_BUTTONS = 9;

/** Matches offered for a typed city name. */
const TYPED_CITY_MATCHES = 6;

/** Offered before anything is typed: the largest rental markets. */
export const POPULAR_CITY_KEYS = [
  'tel-aviv',
  'jerusalem',
  'haifa',
  'rishon',
  'petah-tikva',
  'beer-sheva',
  'netanya',
  'modiin',
  'ramat-gan',
];

/**
 * The cities the picker shows. Chosen and just-typed cities always appear; the chat's own
 * and the popular ones fill the rest, up to MAX_CITY_BUTTONS.
 */
export function offeredCityKeys(selected: string[], typed: string[], recent: string[]): string[] {
  const must = [...new Set([...selected, ...typed])];
  const extra = [...new Set([...recent, ...POPULAR_CITY_KEYS])].filter((key) => !must.includes(key));
  return [...must, ...extra.slice(0, Math.max(0, MAX_CITY_BUTTONS - must.length))];
}

/**
 * The /add flow, as an explicit state machine.
 *
 * State is deliberately in memory: there is one owner, and a restart part-way
 * through simply means running /add again - cheaper than persisting it.
 */
export class AddWizard {
  private readonly states = new Map<number, WizardState>();

  constructor(
    private readonly searches: SearchesRepo,
    private readonly cycle: PollCycle,
    private readonly listings: ListingsRepo,
  ) {}

  isActive(chatId: number): boolean {
    return this.states.has(chatId);
  }

  cancel(chatId: number): void {
    this.states.delete(chatId);
  }

  async start(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;

    // Opens on what is already saved rather than a blank slate: /add is far
    // more often "and Rishon too" than "forget everything I told you". The
    // cities come back ticked, so adding accumulates and unticking removes.
    const all = this.searches.list(chatId);
    const existing = all.at(-1);
    const selected = existing ? [...existing.cityKeys] : [];
    // Cities from every search the chat has, so "and Rishon too" is one tap away.
    const recent = [...new Set(all.flatMap((search) => search.cityKeys))];

    const state: WizardState = {
      step: 'city',
      cityKeys: selected,
      offeredCityKeys: offeredCityKeys(selected, [], recent),
      minRooms: existing?.minRooms ?? null,
      maxRooms: existing?.maxRooms ?? null,
      minPrice: existing?.minPrice ?? null,
      maxPrice: existing?.maxPrice ?? null,
      areas: existing?.areas ? structuredClone(existing.areas) : {},
      areaCity: null,
      areaOptions: [],
      requirements: existing?.requirements ? structuredClone(existing.requirements) : {},
      originId: existing?.id ?? null,
    };
    this.states.set(chatId, state);

    // The chosen cities are drawn ticked. They used to be drawn blank while already in
    // state, so tapping one to add it silently removed it.
    await ctx.reply('באילו ערים לחפש? אפשר לבחור כמה שתרצה, או לכתוב שם של עיר:', {
      reply_markup: cityKeyboard(state.offeredCityKeys, state.cityKeys),
    });
  }

  /**
   * Opens the wizard on its confirmation screen with everything a free-text
   * request already said, so a sentence becomes a search in one tap.
   */
  async startFromDraft(ctx: Context, requested: SearchDraft): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;

    // Like /add, this opens on what is already saved: "גם ראשון" adds a city
    // to the existing search rather than starting one with no bounds.
    const existing = this.searches.list(chatId).at(-1);
    const draft = applyDraftToExisting(requested, existing);

    // An area name nothing can match would silence the search - the same
    // failure the typed-area path warns about. Keep only names that are a
    // region alias or a place some listing has actually used.
    const areas: Record<string, string[]> = {};
    const unknownAreas: string[] = [];
    for (const [cityKey, names] of Object.entries(draft.areas)) {
      const city = findCityByKey(cityKey);
      if (!city) continue;
      const known = this.listings.knownAreas(city.name, 200);
      const kept = names.filter((name) => isKnownAreaName(cityKey, name, known));
      unknownAreas.push(...names.filter((name) => !kept.includes(name)));
      if (kept.length > 0) areas[cityKey] = kept;
    }

    const state: WizardState = {
      step: 'price',
      cityKeys: [...draft.cityKeys],
      offeredCityKeys: [...draft.cityKeys],
      minRooms: draft.minRooms,
      maxRooms: draft.maxRooms,
      minPrice: draft.minPrice,
      maxPrice: draft.maxPrice,
      areas,
      areaCity: null,
      areaOptions: [],
      requirements: draft.requirements ? structuredClone(draft.requirements) : {},
      originId: existing?.id ?? null,
    };
    this.states.set(chatId, state);

    const notes = [
      ...draft.unresolved.map((item) => `לא הצלחתי למפות: ${item}`),
      ...unknownAreas.map((name) => `לא מצאתי שכונה או רחוב בשם "${name}", אז לא סיננתי לפיו`),
    ];
    if (notes.length > 0) {
      await ctx.reply(`${notes.join('\n')}\nאפשר לתקן דרך הכפתורים לפני השמירה.`);
    }
    await this.showConfirmation(ctx, state);
  }

  /** Handles free text while the wizard is waiting for some. */
  async handleText(ctx: Context, text: string): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const state = this.states.get(chatId);
    if (!state) return;

    // On the city step, text searches the whole city list; on the custom steps, it is the
    // value itself.
    if (state.step === 'city') return this.handleCityText(ctx, state, text);
    if (state.step === 'custom-rooms') return this.handleCustomRooms(ctx, state, text);
    if (state.step === 'custom-price') return this.handleCustomPrice(ctx, state, text);
    if (state.step === 'custom-area') return this.handleCustomArea(ctx, state, text);
    if (state.step === 'custom-sqm') return this.handleCustomSqm(ctx, state, text);
    if (state.step === 'custom-keyword') return this.handleCustomKeyword(ctx, state, text);
  }

  /** A typed city name: offer its matches, and tick it outright when only one fits. */
  private async handleCityText(ctx: Context, state: WizardState, text: string): Promise<void> {
    const typed = searchCities(text, TYPED_CITY_MATCHES).map((city) => city.key);
    if (typed.length === 0) {
      await ctx.reply('לא מצאתי עיר בשם הזה. נסה שוב, למשל "כפר יונה".');
      return;
    }

    const only = typed.length === 1 ? typed[0] : undefined;
    if (only && !state.cityKeys.includes(only)) state.cityKeys = [...state.cityKeys, only];
    state.offeredCityKeys = offeredCityKeys(state.cityKeys, typed, state.offeredCityKeys);

    await ctx.reply(only ? `נוספה: ${cityNames([only])}` : 'בחר מהרשימה:', {
      reply_markup: cityKeyboard(state.offeredCityKeys, state.cityKeys),
    });
  }

  /** Handles every add:* button press. */
  async handleCallback(ctx: Context, data: string): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;

    const [, action, value] = data.split(':');

    if (action === 'cancel') {
      this.states.delete(chatId);
      await ctx.editMessageText('בוטל.');
      return;
    }

    const state = this.states.get(chatId);
    if (!state) {
      await ctx.editMessageText('האשף פג תוקף. שלח /add כדי להתחיל מחדש.');
      return;
    }

    switch (action) {
      // Toggling a city redraws the same message, so the list never scrolls
      // away while you are choosing.
      case 'city': {
        if (!value || !findCityByKey(value)) return;
        state.cityKeys = state.cityKeys.includes(value)
          ? state.cityKeys.filter((k) => k !== value)
          : [...state.cityKeys, value];

        await ctx.editMessageReplyMarkup({
          reply_markup: cityKeyboard(state.offeredCityKeys, state.cityKeys),
        });
        return;
      }

      case 'cities-done': {
        if (state.cityKeys.length === 0) {
          await ctx.answerCallbackQuery({ text: 'בחר לפחות עיר אחת' }).catch(() => undefined);
          return;
        }
        state.step = 'rooms';
        await ctx.editMessageText(`ערים: ${cityNames(state.cityKeys)}\n\nכמה חדרים?`, {
          reply_markup: roomsKeyboard(),
        });
        return;
      }

      case 'rooms':
        applyRooms(state, value ?? 'any');
        if (value === 'custom') {
          state.step = 'custom-rooms';
          await ctx.editMessageText('כתוב טווח חדרים, למשל 2.5-4 או 3');
          return;
        }
        state.step = 'price';
        await ctx.editMessageText('מה התקציב החודשי המקסימלי?', {
          reply_markup: priceKeyboard(),
        });
        return;

      case 'price':
        if (value === 'custom') {
          state.step = 'custom-price';
          await ctx.editMessageText('כתוב מחיר מקסימלי, למשל 6500, או טווח כמו 4000-6500');
          return;
        }
        applyPrice(state, value ?? 'any');
        await this.showConfirmation(ctx, state);
        return;

      case 'save':
        await this.save(ctx, chatId, state);
        return;

      // Shown only when /add finds a search with identical rooms and budget.
      case 'update': {
        const id = Number(value);
        if (!Number.isInteger(id)) return;
        await this.updateExisting(ctx, chatId, state, id);
        return;
      }

      case 'new':
        await this.createNew(ctx, chatId, state);
        return;

      // ---- streets and neighbourhoods -------------------------------------
      case 'areas':
        // With one city there is nothing to choose between, so skip the menu.
        if (state.cityKeys.length === 1) {
          state.areaCity = state.cityKeys[0]!;
          await this.showAreaPicker(ctx, state);
        } else {
          await this.showAreaCityMenu(ctx, state);
        }
        return;

      case 'areacity':
        if (!value || !state.cityKeys.includes(value)) return;
        state.areaCity = value;
        await this.showAreaPicker(ctx, state);
        return;

      case 'area': {
        const name = state.areaOptions[Number(value)];
        const city = state.areaCity;
        if (!name || !city) return;

        const chosen = state.areas[city] ?? [];
        state.areas[city] = chosen.includes(name)
          ? chosen.filter((a) => a !== name)
          : [...chosen, name];

        await this.showAreaPicker(ctx, state);
        return;
      }

      case 'areatype':
        state.step = 'custom-area';
        await ctx.editMessageText(
          'כתוב שם של רחוב או שכונה, ואחפש אותו.\nלמשל: רוטשילד, או הכרמים',
        );
        return;

      case 'areaclear':
        if (state.areaCity) delete state.areas[state.areaCity];
        await this.showAreaPicker(ctx, state);
        return;

      case 'areadone':
        state.areaCity = null;
        state.areaOptions = [];
        if (state.cityKeys.length > 1) {
          await this.showAreaCityMenu(ctx, state);
        } else {
          await this.showConfirmation(ctx, state);
        }
        return;

      case 'areasdone':
        state.areaCity = null;
        state.areaOptions = [];
        await this.showConfirmation(ctx, state);
        return;

      // ---- must-haves ------------------------------------------------------
      case 'reqs':
        await this.showRequirementsPicker(ctx, state);
        return;

      case 'req': {
        const name = AMENITY_VOCABULARY[Number(value)];
        if (!name) return;
        const chosen = state.requirements.amenities ?? [];
        state.requirements = {
          ...state.requirements,
          amenities: chosen.includes(name) ? chosen.filter((a) => a !== name) : [...chosen, name],
        };
        await this.showRequirementsPicker(ctx, state);
        return;
      }

      case 'reqbroker':
        state.requirements = {
          ...state.requirements,
          brokers: state.requirements.brokers === 'private-only' ? 'any' : 'private-only',
        };
        await this.showRequirementsPicker(ctx, state);
        return;

      case 'reqsqm':
        state.step = 'custom-sqm';
        await ctx.editMessageText('כתוב גודל מינימלי במ״ר, למשל 80. כתוב 0 כדי לבטל.');
        return;

      case 'reqkeyword':
        state.step = 'custom-keyword';
        await ctx.editMessageText(
          'כתוב מילה שחייבת להופיע במודעה - למשל: נוף, מרפסת שמש, קרוב לרכבת.\nכתוב "נקה" כדי להסיר את כולן.',
        );
        return;

      case 'reqclear':
        state.requirements = {};
        await this.showRequirementsPicker(ctx, state);
        return;

      case 'reqdone':
        await this.showConfirmation(ctx, state);
        return;
    }
  }

  /**
   * What the flat must have. One missing amenity still gets sent, flagged as a
   * near miss - the difference between "no parking" and "did not mention it".
   */
  private async showRequirementsPicker(ctx: Context, state: WizardState): Promise<void> {
    const requirements = state.requirements;
    const chosen = new Set(requirements.amenities ?? []);

    const keyboard = new InlineKeyboard();
    AMENITY_VOCABULARY.forEach((name, index) => {
      keyboard.text(`${chosen.has(name) ? '✅' : '▫️'} ${name}`, `add:req:${index}`);
      if (index % 2 === 1) keyboard.row();
    });
    keyboard.row();
    keyboard
      .text(`${requirements.brokers === 'private-only' ? '✅' : '▫️'} ללא תיווך`, 'add:reqbroker')
      .row();
    keyboard
      .text(requirements.minSqm ? `📏 מינימום ${requirements.minSqm} מ״ר` : '📏 גודל מינימלי', 'add:reqsqm')
      .text(
        requirements.keywords?.length ? `🔎 ${requirements.keywords.join(', ')}` : '🔎 מילת מפתח',
        'add:reqkeyword',
      )
      .row();
    if (hasRequirements(requirements)) keyboard.text('🗑 נקה דרישות', 'add:reqclear').row();
    keyboard.text('✅ סיום', 'add:reqdone');

    const text =
      'מה חייב להיות בדירה?\n' +
      'דירה שחסר בה פריט אחד בלבד עדיין תישלח, מסומנת "כמעט מתאים". מה שהמודעה לא מציינת לא נספר נגדה.';
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { reply_markup: keyboard });
    } else {
      await ctx.reply(text, { reply_markup: keyboard });
    }
  }

  private async handleCustomSqm(ctx: Context, state: WizardState, text: string): Promise<void> {
    const value = Number(text.replace(/[^\d]/g, ''));
    if (!Number.isFinite(value) || text.trim() === '') {
      await ctx.reply('לא הבנתי. כתוב מספר, למשל 80, או 0 כדי לבטל.');
      return;
    }
    const { minSqm: _dropped, ...rest } = state.requirements;
    state.requirements = value > 0 ? { ...rest, minSqm: value } : rest;
    await this.showRequirementsPicker(ctx, state);
  }

  private async handleCustomKeyword(ctx: Context, state: WizardState, text: string): Promise<void> {
    const typed = text.trim();
    if (!typed) return;

    const { keywords: current = [], ...rest } = state.requirements;
    if (/^(נקה|ביטול|clear)$/i.test(typed)) {
      state.requirements = rest;
    } else if (current.length >= MAX_KEYWORDS) {
      await ctx.reply(`אפשר עד ${MAX_KEYWORDS} מילות מפתח. כתוב "נקה" כדי להתחיל מחדש.`);
      return;
    } else if (!current.includes(typed)) {
      state.requirements = { ...rest, keywords: [...current, typed] };
    }
    await this.showRequirementsPicker(ctx, state);
  }

  /** Which city's areas to edit, when the search covers several. */
  private async showAreaCityMenu(ctx: Context, state: WizardState): Promise<void> {
    const keyboard = new InlineKeyboard();
    for (const key of state.cityKeys) {
      const city = findCityByKey(key);
      if (!city) continue;
      const chosen = state.areas[key] ?? [];
      keyboard
        .text(`${city.name} - ${chosen.length > 0 ? `${chosen.length} נבחרו` : 'כל העיר'}`, `add:areacity:${key}`)
        .row();
    }
    keyboard.text('⬅️ חזרה', 'add:areasdone');

    await ctx.editMessageText('לאיזו עיר לבחור רחובות?', { reply_markup: keyboard });
  }

  /**
   * The area picker for one city.
   *
   * Suggestions come from neighbourhoods actually seen advertised there, so
   * every button leads somewhere with real inventory. Anything missing is
   * reachable by typing, which is also the only practical way to reach one of
   * several hundred streets.
   */
  private async showAreaPicker(ctx: Context, state: WizardState): Promise<void> {
    const cityKey = state.areaCity;
    const city = cityKey ? findCityByKey(cityKey) : undefined;
    if (!cityKey || !city) return;

    const chosen = state.areas[cityKey] ?? [];
    // Chosen entries first so a typed street stays visible and removable;
    // then the everyday region names, then the neighbourhoods actually seen.
    const suggestions = [
      ...Object.keys(REGION_ALIASES[cityKey] ?? {}),
      ...this.listings.knownAreas(city.name),
    ];
    state.areaOptions = [...chosen, ...suggestions.filter((s) => !chosen.includes(s))];

    const keyboard = new InlineKeyboard();
    state.areaOptions.forEach((name, index) => {
      const label = `${chosen.includes(name) ? '✅' : '▫️'} ${name}`;
      keyboard.text(label, `add:area:${index}`);
      if (index % 2 === 1) keyboard.row();
    });
    keyboard.row();
    keyboard.text('➕ הקלד רחוב', 'add:areatype').row();
    if (chosen.length > 0) keyboard.text('🗑 כל העיר', 'add:areaclear').row();
    keyboard.text('✅ סיום', 'add:areadone');

    // Typed names are the owner's own text inside an HTML-mode message.
    const body =
      chosen.length > 0
        ? `נבחרו: ${chosen.map(escapeHtml).join(', ')}`
        : 'לא נבחר כלום - אחפש בכל העיר.';

    await ctx.editMessageText(`<b>${city.name}</b>\n${body}`, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  }

  /** Resolves typed text against Yad2's address index. */
  private async handleCustomArea(ctx: Context, state: WizardState, text: string): Promise<void> {
    const cityKey = state.areaCity;
    const city = cityKey ? findCityByKey(cityKey) : undefined;
    if (!cityKey || !city) return;

    const matches = await lookupPlaces(text, city.name);
    const typed = text.trim();

    // Offering the raw text as a last option means a lookup failure, or a
    // local name Yad2 does not carry, never blocks the choice.
    const options = matches.map((m) => m.name);
    const typedIsNew = Boolean(typed) && !options.some((o) => normalizePlace(o) === normalizePlace(typed));
    if (typedIsNew) options.push(typed);

    // A name that neither Yad2 nor any listing has ever used can never match,
    // so saving it would silence the search - which is exactly what happened
    // with "צפון ראשון". Say so before the owner commits to it.
    const recognised =
      !typedIsNew || isKnownAreaName(cityKey, typed, this.listings.knownAreas(city.name, 200));

    state.areaOptions = options;
    const keyboard = new InlineKeyboard();
    options.forEach((name, index) => {
      const label = name === typed && typedIsNew && !recognised ? `⚠️ הוסף בכל זאת: ${name}` : name;
      keyboard.text(label, `add:area:${index}`).row();
    });
    keyboard.text('⬅️ חזרה', 'add:areadone');

    // Stay on this step so a second attempt can simply be typed.
    state.step = 'custom-area';
    await ctx.reply(
      matches.length > 0
        ? 'מצאתי את אלה - בחר מה להוסיף:'
        : recognised
          ? `לא מצאתי "${typed}" ביד2, אבל הוא מופיע במודעות. אפשר להוסיף:`
          : `⚠️ לא מצאתי שכונה או רחוב בשם "${typed}" - לא ביד2 ולא באף מודעה.\n` +
            'אם תוסיף אותו, אף מודעה לא תתאים והחיפוש ישתתק. עדיף לחזור ולבחור מהרשימה.',
      { reply_markup: keyboard },
    );
  }

  private async handleCustomRooms(ctx: Context, state: WizardState, text: string): Promise<void> {
    const range = parseRange(text);
    if (!range) {
      await ctx.reply('לא הבנתי. כתוב מספר כמו 3, או טווח כמו 2.5-4');
      return;
    }
    state.minRooms = range.min;
    state.maxRooms = range.max;
    state.step = 'price';
    await ctx.reply('מה התקציב החודשי המקסימלי?', { reply_markup: priceKeyboard() });
  }

  private async handleCustomPrice(ctx: Context, state: WizardState, text: string): Promise<void> {
    const range = parseRange(text);
    if (!range) {
      await ctx.reply('לא הבנתי. כתוב מחיר כמו 6500, או טווח כמו 4000-6500');
      return;
    }
    // A single number means "up to this much", which is how people phrase budgets.
    if (range.max === range.min) {
      state.minPrice = null;
      state.maxPrice = range.max;
    } else {
      state.minPrice = range.min;
      state.maxPrice = range.max;
    }
    await this.showConfirmation(ctx, state);
  }

  private async showConfirmation(ctx: Context, state: WizardState): Promise<void> {
    const summary = searchTitle(this.toSearchPreview(state));
    const keyboard = new InlineKeyboard()
      .text('📍 רחובות ואזורים', 'add:areas')
      .text('⚙️ דרישות נוספות', 'add:reqs')
      .row()
      .text('✅ שמור', 'add:save')
      .text('❌ ביטול', 'add:cancel');

    const text =
      `לשמור את החיפוש הזה?\n\n<b>${summary}</b>\n` + describeAreas(state.areas, state.cityKeys);
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    }
  }

  /**
   * Decides between updating an existing search and adding another one.
   *
   * Without this, /add could only ever stack: adding a city produced a second
   * search sitting on top of the first, and /list filled up with overlapping
   * entries that were really one intent expressed twice.
   *
   * Stacking is worse than untidy. Seen-ness is keyed per chat, so the
   * loosest search claims a listing before a narrower one is consulted: a
   * leftover whole-city search makes a three-street filter do nothing at all.
   * The decision itself lives in `chooseSaveTarget`, where it can be tested.
   */
  private async save(ctx: Context, chatId: number, state: WizardState): Promise<void> {
    const cities = state.cityKeys.map(findCityByKey).filter((c) => c !== undefined);
    if (cities.length === 0) {
      await ctx.editMessageText('משהו השתבש. שלח /add כדי להתחיל מחדש.');
      this.states.delete(chatId);
      return;
    }

    const target = chooseSaveTarget(
      {
        cityKeys: cities.map((c) => c.key),
        minRooms: state.minRooms,
        maxRooms: state.maxRooms,
        minPrice: state.minPrice,
        maxPrice: state.maxPrice,
        originId: state.originId,
      },
      this.searches.list(chatId),
    );

    if (target.kind === 'new') {
      await this.createNew(ctx, chatId, state);
      return;
    }

    if (target.kind === 'duplicate') {
      this.states.delete(chatId);
      await ctx.editMessageText(`החיפוש הזה כבר קיים:\n\n<b>${escapeHtml(target.search.name)}</b>`, {
        parse_mode: 'HTML',
      });
      return;
    }

    const keyboard = new InlineKeyboard()
      .text('🔄 עדכן את הקיים', `add:update:${target.search.id}`)
      .row()
      .text('➕ צור חיפוש נוסף', 'add:new')
      .row()
      .text('❌ ביטול', 'add:cancel');

    // Two different questions, and the wrong answer to the second one is what
    // sends a whole city to someone who asked for three streets - so it spells
    // out that the old search keeps running, rather than implying a rename.
    const question =
      target.kind === 'same-bounds'
        ? 'יש לך כבר חיפוש עם אותם חדרים ותקציב:\n' +
          `<b>${escapeHtml(target.search.name)}</b>\n\n` +
          `לעדכן אותו לערים ${cityNames(state.cityKeys)}, או לשמור חיפוש נפרד?`
        : 'זה נראה כמו עדכון של החיפוש הקיים:\n' +
          `<b>${escapeHtml(target.search.name)}</b>\n` +
          `⬇️\n<b>${searchTitle(this.toSearchPreview(state))}</b>\n\n` +
          'לעדכן אותו, או לשמור חיפוש נוסף? ' +
          'שים לב: חיפוש נוסף לא מבטל את הקיים - שניהם ימשיכו לשלוח התראות.';

    await ctx.editMessageText(question, { parse_mode: 'HTML', reply_markup: keyboard });
  }

  /** Points an existing search at the edited bounds and cities, keeping its history. */
  private async updateExisting(ctx: Context, chatId: number, state: WizardState, id: number): Promise<void> {
    if (!this.searches.belongsTo(id, chatId)) {
      this.states.delete(chatId);
      await ctx.editMessageText('החיפוש הזה לא שלך.');
      return;
    }

    const cities = state.cityKeys.map(findCityByKey).filter((c) => c !== undefined);
    // Bounds first: "update" used to be offered only when they already
    // matched, so it never had to write them. It is now also how a search is
    // narrowed, and a narrowing that silently kept the old bounds would be
    // the same bug wearing a different hat.
    this.searches.setBounds(id, {
      minRooms: state.minRooms,
      maxRooms: state.maxRooms,
      minPrice: state.minPrice,
      maxPrice: state.maxPrice,
    });
    this.searches.setRequirements(id, state.requirements);
    const search = this.searches.setCities(
      id,
      cities.map((c) => c.key),
      cities.map((c) => c.name).join(', '),
      describeSearch(this.toSearchPreview(state)),
      state.areas,
    );
    this.states.delete(chatId);

    if (!search) {
      await ctx.editMessageText('משהו השתבש. שלח /add כדי להתחיל מחדש.');
      return;
    }

    await ctx.editMessageText(`עודכן: <b>${escapeHtml(search.name)}</b>\n\nסורק מודעות קיימות…`, {
      parse_mode: 'HTML',
    });

    // Seeding again matters here: a city just added to the search has a whole
    // back catalogue this chat has never been shown, and without this it would
    // all arrive at once as "new".
    await this.seedAndReport(ctx, search);
  }

  private async createNew(ctx: Context, chatId: number, state: WizardState): Promise<void> {
    const cities = state.cityKeys.map(findCityByKey).filter((c) => c !== undefined);

    const search = this.searches.create({
      chatId,
      name: describeSearch(this.toSearchPreview(state)),
      cityKeys: cities.map((c) => c.key),
      cityName: cities.map((c) => c.name).join(', '),
      minRooms: state.minRooms,
      maxRooms: state.maxRooms,
      minPrice: state.minPrice,
      maxPrice: state.maxPrice,
      areas: state.areas,
      requirements: state.requirements,
    });
    this.states.delete(chatId);

    await ctx.editMessageText(`נשמר: <b>${escapeHtml(search.name)}</b>\n\nסורק מודעות קיימות…`, {
      parse_mode: 'HTML',
    });

    await this.seedAndReport(ctx, search);
  }

  /**
   * Records what is already advertised so only genuinely new ads raise an
   * alert. Shared by both paths, because adding a city to an existing search
   * needs it just as much as creating one from scratch.
   */
  private async seedAndReport(ctx: Context, search: SavedSearch): Promise<void> {
    try {
      const { seeded, snapshot } = await this.cycle.seedSearch(search);
      await ctx.reply(
        `מצאתי ${seeded} מודעות שכבר מפורסמות וסימנתי אותן כנראות.\n` +
          `מעכשיו תקבל התראה על כל מודעה <b>חדשה</b> שתואמת. 🏠`,
        { parse_mode: 'HTML' },
      );

      // Silence right after /add reads as "found nothing". Show the market as
      // it stands, from the sweep that just ran, so the first impression is
      // what is out there - and whether the bounds are drawn right.
      const ordered = orderSnapshot(snapshot, () => false);
      if (ordered.length === 0) {
        await ctx.reply('אין כרגע אף מודעה שתואמת, מתוך ' + `${snapshot.all.length} בעיר.`);
        return;
      }
      const counts =
        `${snapshot.matching.length} מתאימות` +
        (snapshot.near.length > 0 ? `, ${snapshot.near.length} כמעט` : '');
      await ctx.reply(
        `<b>זה מה שיש בשוק עכשיו</b> (${counts}):\n\n` +
          formatDigest(ordered, {
            offset: 0,
            pageSize: CARDS_PAGE,
            alreadySent: () => false,
            nearMiss: (l) => (snapshot.near.includes(l) ? nearMissReason(l, search) : null),
          }) +
          (ordered.length > CARDS_PAGE ? `\n\n…ועוד ${ordered.length - CARDS_PAGE}.` : ''),
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
      );
    } catch (error) {
      logger.error({ err: error, search: search.id }, 'seeding failed');
      await ctx.reply(
        'החיפוש נשמר, אבל הסריקה הראשונית נכשלה. אנסה שוב בסבב הבא.',
      );
    }
  }

  private toSearchPreview(state: WizardState): SavedSearch {
    const cities = state.cityKeys.map(findCityByKey).filter((c) => c !== undefined);
    return {
      id: 0,
      chatId: 0,
      name: '',
      cityKeys: cities.map((c) => c.key),
      cityName: cities.map((c) => c.name).join(', '),
      minRooms: state.minRooms,
      maxRooms: state.maxRooms,
      minPrice: state.minPrice,
      maxPrice: state.maxPrice,
      ...(hasRequirements(state.requirements) ? { requirements: state.requirements } : {}),
      active: true,
      createdAt: '',
    };
  }
}

function hasRequirements(requirements: SearchRequirements): boolean {
  return Boolean(
    requirements.amenities?.length ||
      requirements.brokers === 'private-only' ||
      requirements.minSqm ||
      requirements.propertyTypes?.length ||
      requirements.keywords?.length,
  );
}

/** The offered cities as toggles, with a tick on the chosen ones. */
export function cityKeyboard(offered: string[], selected: string[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const cities = offered.map(findCityByKey).filter((city) => city !== undefined);

  cities.forEach((city, index) => {
    const chosen = selected.includes(city.key);
    keyboard.text(`${chosen ? '✅ ' : ''}${city.name}`, `add:city:${city.key}`);
    if ((index + 1) % CITIES_PER_ROW === 0) keyboard.row();
  });

  keyboard.row();
  keyboard.text(
    selected.length > 0 ? `המשך (${selected.length}) ➡️` : 'המשך ➡️',
    'add:cities-done',
  );
  keyboard.text('ביטול', 'add:cancel');
  return keyboard;
}

function cityNames(keys: string[]): string {
  return keys
    .map((k) => findCityByKey(k)?.name)
    .filter(Boolean)
    .join(', ');
}

function roomsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('הכל', 'add:rooms:any')
    .text('2+', 'add:rooms:2-')
    .text('3+', 'add:rooms:3-')
    .row()
    .text('3–4', 'add:rooms:3-4')
    .text('4+', 'add:rooms:4-')
    .text('5+', 'add:rooms:5-')
    .row()
    .text('אחר…', 'add:rooms:custom')
    .text('ביטול', 'add:cancel');
}

function priceKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('עד 5,000', 'add:price:5000')
    .text('עד 6,000', 'add:price:6000')
    .row()
    .text('עד 7,000', 'add:price:7000')
    .text('עד 8,000', 'add:price:8000')
    .row()
    .text('ללא הגבלה', 'add:price:any')
    .text('אחר…', 'add:price:custom')
    .row()
    .text('ביטול', 'add:cancel');
}

function applyRooms(state: WizardState, value: string): void {
  if (value === 'any' || value === 'custom') {
    state.minRooms = null;
    state.maxRooms = null;
    return;
  }
  const range = parseRange(value);
  state.minRooms = range?.min ?? null;
  state.maxRooms = range?.openEnded ? null : (range?.max ?? null);
}

function applyPrice(state: WizardState, value: string): void {
  if (value === 'any') {
    state.minPrice = null;
    state.maxPrice = null;
    return;
  }
  const max = Number(value);
  state.minPrice = null;
  state.maxPrice = Number.isFinite(max) && max > 0 ? max : null;
}

/**
 * Understands "3", "3-4" and the open-ended "3-" used by the "3+" buttons.
 */
export function parseRange(
  raw: string,
): { min: number; max: number; openEnded: boolean } | null {
  const text = raw.replace(/[^\d.\-–]/g, '').replace(/–/g, '-').trim();
  if (!text) return null;

  const openEnded = text.endsWith('-');
  const parts = text.split('-').filter((p) => p.length > 0);
  if (parts.length === 0) return null;

  const min = Number(parts[0]);
  if (!Number.isFinite(min) || min <= 0) return null;

  if (openEnded || parts.length === 1) {
    return { min, max: min, openEnded };
  }

  const max = Number(parts[1]);
  if (!Number.isFinite(max) || max < min) return null;
  return { min, max, openEnded: false };
}

/** What a pending save covers, and which search it was edited from. */
export interface SaveDraft {
  cityKeys: string[];
  minRooms: number | null;
  maxRooms: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  /** The search the wizard was opened on, if it was opened on one. */
  originId: number | null;
}

/** Which existing search a save should offer to replace, if any. */
export type SaveTarget =
  | { kind: 'duplicate'; search: SavedSearch }
  | { kind: 'same-bounds'; search: SavedSearch }
  | { kind: 'edited'; search: SavedSearch }
  | { kind: 'new' };

function sameCities(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((key) => b.includes(key));
}

/**
 * Decides what a save means: a duplicate, an edit of an existing search, or a
 * genuinely new one.
 *
 * Pure, and separate from the wizard, because the decision is the part that
 * got this wrong and the Telegram plumbing is the part that cannot be tested.
 *
 * Matching bounds still win - "Modi'in, 3–4, up to 6,500" and "Modi'in and
 * Rishon, 3–4, up to 6,500" are one intent typed twice. What is new here is
 * the fallback: /add opens prefilled from the last saved search, so it reads
 * as editing that search, but changing the bounds is exactly what narrowing
 * looks like and is exactly when the bounds lookup finds nothing. That
 * produced a second search while the first stayed live and unfiltered -
 * which is how picking three streets could still deliver the whole city.
 */
export function chooseSaveTarget(draft: SaveDraft, existing: SavedSearch[]): SaveTarget {
  const twin = existing.find(
    (s) =>
      s.minRooms === draft.minRooms &&
      s.maxRooms === draft.maxRooms &&
      s.minPrice === draft.minPrice &&
      s.maxPrice === draft.maxPrice,
  );
  if (twin) {
    return sameCities(twin.cityKeys, draft.cityKeys)
      ? { kind: 'duplicate', search: twin }
      : { kind: 'same-bounds', search: twin };
  }

  const origin = existing.find((s) => s.id === draft.originId);
  return origin ? { kind: 'edited', search: origin } : { kind: 'new' };
}

/** The chosen areas per city, escaped for the HTML-mode confirmation screen. */
export function describeAreas(areas: Record<string, string[]>, cityKeys: string[]): string {
  const lines = cityKeys
    .map((key) => ({ city: findCityByKey(key), chosen: areas[key] ?? [] }))
    .filter((entry) => entry.city !== undefined && entry.chosen.length > 0)
    .map((entry) => `📍 ${escapeHtml(entry.city!.name)}: ${entry.chosen.map(escapeHtml).join(', ')}`);

  return lines.length > 0 ? `\n${lines.join('\n')}` : '';
}
