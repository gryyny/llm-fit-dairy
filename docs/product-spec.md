# Product requirements

## Purpose and boundary

A food diary in ChatGPT, used mainly on iPhone: a publicly listed plugin with a diary skill and an authenticated MCP data app, plus a website that displays the saved diary.

Chat performs all understanding, matching, estimates and calculations. Our service authenticates, authorizes, stores, retrieves and preserves data integrity. It can search records and group stored food links, but never decides equivalence or nutritional values. The only arithmetic outside chat is the website's display totals defined under [Website](#website).

Anyone with their own ChatGPT login installs the plugin from the ChatGPT plugin directory and starts logging without administrator help, copied credentials, identifiers, local files or Sites settings. A personal Site-hosted plugin cannot be shared, so distribution requires public listing; see [research.md](research.md#public-distribution-and-user-authentication-2026-10-19). Claude support is deferred; when added, it uses the same profiles.

The public release is free for adults aged 18 and over, available in all countries the host permits. The privacy page refers to the publisher on the ChatGPT plugin listing, and the support page provides the public contact.

## Onboarding

1. In ChatGPT (web or iPhone), the person installs the plugin from the directory and selects **Connect**.
2. Our website opens, the person signs in with Google or email/password and approves access on a consent screen. The screen names the signed-in person, states what ChatGPT can do and prominently discloses the stored data categories. Approval records explicit consent to that processing, with the policy version. The planned body-context fields and goal-input snapshots must be covered before collection; their addition requires updated consent.
3. ChatGPT returns to the conversation. The person's profile already exists and is selected automatically, so the first meal can be logged at once.

The same account opens the website, which shows that profile's diary.

## Profiles and connections

A **profile** is one person: their own Firebase sign-in and their diary. The first sign-in creates it, using the available display name or “Me”. Profiles are independent: no profile can see, list or change another, and nothing is created on someone's behalf. Profile-name changes are made in chat, with the website displaying the saved name.

A **connection** is one ChatGPT plugin connection. It starts with the profile of the person who connected and can work with several profiles.

- **Adding a profile:** in chat, the user can ask to add another person's profile. ChatGPT returns a one-time link valid for 30 minutes. That person opens it, signs in with their own Google or email/password account and approves the request, which names who asked. Only their own approval adds their profile; until then the connection cannot reach it. A connection holds at most 10 profiles.
- **Selection:** with one profile on the connection, every action uses it automatically. With several, every action names its profile: the speaker's own profile when they speak about themselves, otherwise the person they name. When unclear, chat asks. Confirmations name the profile used.
- **Each person's control:** on the website, a person sees only their own diary and the ChatGPT connections that can reach their profile, and can remove their profile from any of them. Nothing is shown about other profiles on the same connection. A connection ends when its last profile leaves or when the person who connected it deletes their data. Removal stops future access, not disclosure already made to a conversation.
- **Isolation:** every data action checks that the connection holds the named profile, or, on the website, that it is the signed-in person's own. Unknown and unreachable profiles fail identically. Personal records and catalogue-group assertions are profile-scoped. Reusable food facts have shared identities and immutable revisions, reached through each profile’s own library links. Only profiles already approved on a connection can supply discoverable user-food candidates; no public recipe browsing is added. Imported catalogue evidence stays unchanged.
- **Removal:** on the website, a person can delete their data: their profile, personal records and library links, and their place on every connection. Shared food facts remain while another library, recipe or diary uses them; unreferenced identities are removed. Deletion of personal records is permanent.

Google and email/password are permanent sign-in methods. The email/password form is always visible on signed-out diary, connect and join pages, with open sign-up and password reset through Firebase. No account allowlist or administrator approval is required. Identity follows the verified Firebase UID; we never merge different accounts by matching email or name. ChatGPT access still requires the person’s explicit approval.

## Stored data

| Data | Required content |
| --- | --- |
| Meals | Profile, diary date, meal identity, food entries, quantities/units, supplied energy/nutrient values, one source and a note per entry. |
| Usual foods/products | One shared identity with immutable brand/variant, preparation, provenance and nutrient-basis revisions. Each profile has its own stable link ID, chosen revision, name, recognition description, catalogue preferences and note. Missing older metadata remains “not recorded”. |
| Shared catalogue | Ciqual, BLS, USDA and Open Food Facts records, retaining source IDs, release/version, barcode, serving basis, values, units and nutrient definitions as supplied. |
| Targets | Saved values/ranges, normal-day and training-day variants, effective dates and the selected variant for each diary day; a day without a selection uses the normal-day variant. Optional agreed rationale and the body/weight input snapshot used by chat. |
| Weight | Dated measurements, units and source/note. |
| Recipes | Shared recipe identity and immutable ingredient/yield/nutrient revisions. Ingredients reference shared product revisions; recipe and ingredient names/notes stay on personal links. New retention requires ingredients and usable yield/servings; ambiguous legacy recipes remain separate. |
| Body context | Optional height with unit, supplied date of birth, age with its observation date, activity description and overall goal, stored separately from weight. |

A food entry has one source: **label**, **dataset record**, or **estimate**, plus a free-text note for assumptions, calculations, corrections or mixed origins. Dataset provenance identifies the record/version; label provenance retains values and serving basis. There are no per-nutrient source fields. Missing values remain distinct from zero.

**Consistency release (approved, 2026-10-21):** recipes and sourced snapshots carry optional `partial_nutrients`, naming numeric subtotals with missing contributions; entirely unknown nutrients remain omitted. Recipe writes reject totals presented as complete when an ingredient contribution is missing or partial. Logging a recipe carries its partial markers to the eaten snapshot without recalculating values. Edits preserve unspecified markers; clearing a numeric value also requires clearing its marker. Display sums include known subtotals and mark affected entries incomplete. Old snapshot values are never recalculated or annotated by migration.

Personal-food lookup accepts exact barcode/eligible GTIN text as well as names. An Unclassified filter finds old products without inferring missing metadata. A new as-sold GTIN that matches an unclassified legacy row requires reuse or an explicit versioned correction, not duplicate creation. Equivalent English/Ukrainian unit aliases compare equally for food identity without converting quantities or rewriting stored units. Routine chat confirmations stay brief; detailed summaries and coaching are requested actions.

Diary entries, usual products, recipes and targets support eight nutrients: energy (kcal) and protein, carbohydrate, sugars, fat, saturated fat, fibre and salt (g). Other label values may be described in the entry or product note. The catalogue keeps every nutrient its source publishes.

Chat supports reading, creating, correcting and deleting personal records. Logged meals retain their values when products, recipes or imports change. Targets are saved only when agreed by the user.

**Automatic usual foods (approved, 2026-10-22):** logging retains or reuses recognizable reusable foods, products and sufficiently specified recipes without a separate save request. One-off restaurant meals and insufficiently specified recipes remain only in the diary, with an explicit exception reason. Recognition preserves brand/variant and preparation; it does not establish nutrition accuracy from appearance. Different eaten amounts reuse the food, while past meals retain their saved snapshots.

**Food identity and writes (approved, 2026-10-22):** reuse a known personal product/recipe link first. Exact eligible as-sold GTINs and exact published catalogue-record keys resolve one common food identity across profiles. Identical facts reuse a revision; conflicting facts keep distinct immutable revisions. An existing profile link changes revision only through a versioned correction. Different preparations and unkeyed foods/recipes require lookup and explicit selection; names, photos and nutrient/ingredient hashes do not prove identity. Authorized cross-profile reuse creates a personal link to the selected shared revision, including recipe ingredient links, without copying notes or preferences. Each new/appended diary entry requires exactly one owned food ID, atomic new/link reference, or agreed diary-only exception. New recipe ingredients must have owned or atomic product references. The complete meal/link/definition write is atomic and replayable. Migration preserves personal IDs, notes and snapshots, merges only existing trusted keys, and leaves ambiguous legacy identities separate. Historical entries pin revisions and never recalculate after a template correction/deletion.

**Lookup:** search the selected profile’s library first, then foods already available through profiles approved on that ChatGPT connection. A translated-name or classification miss returns bounded, pageable fallback candidates, including unclassified legacy records. Candidates require inspection; a miss is not proof of absence and a similar name is not proof of equivalence. The website continues to list only its owner’s personal links.

**Body and goals:** optional height is a value with `cm` or `in`; age is an adult's whole years with an `as_of` date. As approved on 2026-10-21, `date_of_birth` is an optional ISO calendar date for an adult aged 18 or over. Never infer it from dated age or notes. Inferred sex and catch-all medical/preferences fields remain outside scope. Save activity and the overall goal as supplied text, not a computed multiplier or active nutrient target. Omitted changes preserve fields; explicit null clears the named field; stale versions conflict. Keep age dated without automatically advancing it or mining past notes. No body fields or goals are required to log food. Chat proposes targets with the profile, variant, effective date and core values, and saves them once agreed. Later body/weight changes do not recalculate goals. Saved rationale/input snapshots describe the target version they accompany; a replacement clears them unless deliberately supplied again.

**Provenance:** explicit value corrections retain actual evidence and untouched nutrients. User agreement alone does not turn an estimate into a label or dataset record. A separate “Confirmed by you” status/badge and per-nutrient confirmation lifecycle are deferred.

## Website

The website is iPhone-first and displays diary data read-only; diary records are created and corrected in chat. It also hosts sign-in, the ChatGPT consent and join screens, connection management, data deletion, and the public product, privacy, terms and support pages.

**Chat-only data entry (user-confirmed, 2026-10-20):** enter and change all saved diary and profile data in chat, including profile name, meals, usual foods, recipes, body details, weigh-ins and goals. Website search, filters, date navigation and viewing normal/training target variants remain available without changing records. Sign-in/sign-up, connection consent/revocation and account deletion stay on the website.

**Languages (user-requested, 2026-10-20; placement refined 2026-10-21):** begin with English and Ukrainian (`en` and `uk`). Localize the website's own navigation, nutrient labels, dates/numbers, states/errors, accessibility text, sign-in, consent, settings and public pages. Use the first supported browser language, falling back to English; the English / Українська selector in Settings overrides it and remembers the choice on that device. Do not repeat language controls in other screens, dialogs or public pages. Language is a website display preference, not saved diary/profile input. Switching it preserves the current view, filters and in-progress form state. Saved names, food/meal descriptions, notes, values and units retain their meaning and original content; chat follows the conversation's language independently.

| Area | Shows |
| --- | --- |
| Today / day | Selected day's meals and entries with amount, values, source and note; target variant and effective target; weight; display totals. |
| History | Logged days, newest first, with display energy totals and completeness; opens any day. |
| Foods | Usual basics, products and recipes, searchable/filterable, with recent use, identity/preparation, basis, values and source details. |
| Body | Optional dated body context, latest weight, current target variants/effective dates and paged history. Charts space measurements by date and distinguish unit changes. |
| Settings | Language, profile name shown in chat, ChatGPT connections that can reach this profile (remove), consent and privacy, delete my data, sign out. |

The website shows only the signed-in person's own profile; there is no switcher. A join page lets a person add their profile to a ChatGPT connection from a link. Every view has distinct loading, empty, error and signed-out states. Empty states say what to tell ChatGPT. Errors offer a retry or sign-in again.

**Install:** a person can add the website to the iPhone Home Screen or the Mac Dock and open it like an app, with its own name and icon, starting at Today. It needs a connection; there is no offline mode or install prompt.

**Display totals:** the website may add the stored values shown for a day or meal, per nutrient. It sums only stored values, converts nothing, derives no nutrient from another and keeps unknowns visible. If some entries lack a nutrient, the total is a lower bound with the number of entries missing it (for example "≥ 1,820 kcal, 2 entries without energy"). If no entry has it, the total is unknown. Comparisons with targets carry the same marking. Totals are rounded only for display and are never stored or returned to chat.

**Core progress (requested, 2026-10-20):** the day summary keeps the prominent calorie bar and groups compact Protein, Carbohydrate and Fat bars directly below it, using saved targets and visibly preserving incomplete/unknown totals. Other nutrient details remain available without crowding the core summary.

Progress uses the saved upper bound, otherwise exact value, otherwise minimum as its visual reference; ranges show both limits. A minimum alone never implies a maximum. Zero targets do not produce percentage division, and no target produces no invented percentage. An empty day may show “0 logged” and saved goals; an existing entry without values remains unknown. Refresh the visible records on return from chat without rendering responses for an old user, profile, date or query. Current targets must not disappear behind a fixed first page of later variants; histories remain pageable.

## Catalogue identity

Import all four datasets without semantic merging or live provider calls during diary use. Re-importing the same source record/version must not create a second copy.

Stream source archives and retain the required catalogue fields as-is. Source fidelity means preserving those fields and their meaning, not storing entire unparsed source payloads in the database. Verify complete record counts and rejected records for each selected release; samples alone do not establish completeness.

An exact GTIN match is the only automatic food-uniqueness rule: a code of 8, 12, 13 or 14 digits with a valid GS1 check digit, compared after left-padding with zeros to 14 digits. Restricted-circulation (store-internal) and invalid codes are kept as supplied but never group automatically, including when zero-padded. Preserve all matching source records and conflicting values. Store other “same food” links per profile when chat confirms them; only that profile's searches group by its links. Each confirmed link is kept; removing one removes only that assertion, and groups follow the remaining links and GTIN matches. Names, nutrients and preparation descriptions never trigger automatic equivalence. Correcting links preserves source records and logged meals.

## Acceptance criteria

- **Onboarding:** a new Google or email/password user installs the published plugin on iPhone, connects, consents and logs a meal in the same conversation without any other setup; the website then shows that meal.
- **People:** with one profile, actions need no profile choice. Asking to add a person returns a join link; only that person's own sign-in and approval adds their profile, after which actions name the right profile and ask when unclear.
- **Isolation:** a profile not on a connection cannot be read, written or selected through it, through the API or on another person's website, including with guessed identifiers or an expired or used join link; one profile's same-food links never change another's search. Removing a profile from a connection stops that connection's access to it while its other profiles and the website keep working.
- **Persistence:** log a meal, reopen in a fresh ChatGPT chat, and retrieve the same diary, date, values and provenance.
- **Corrections:** change only a portion or calorie value, or delete one entry; unrelated entries and values remain unchanged. Adding food after a daily summary remains possible.
- **Reuse:** save and retrieve a usual product or recipe in a fresh chat. Confirmed cross-profile reuse has one shared identity and separate personal links; later edits preserve other chosen revisions and previously logged meals. Concurrent creation/retries cannot duplicate trusted identities or links. Removing one profile/link must not break another recipe or diary.
- **Automatic retention:** log eligible basics/products/complete recipes without a separate save request, retrieve them in a fresh chat and reuse IDs for another portion. Keep restaurant meals and underspecified recipes diary-only, distinguish preparation/variant and preserve evidence. Key collisions, different concurrent request IDs and failures follow the atomic identity contract; unkeyed candidates are disambiguated in chat.
- **Body and chat-only entry:** save/read/clear optional dated context and rename the selected profile in chat with ownership, version and retry checks. No website saved-data edit form or rename endpoint remains after their joint cutover. Sign-in, consent and account/privacy controls still work.
- **Targets and weight:** retrieve saved target variants, effective dates, day selections and weight history without turning a conversational suggestion into a saved target.
- **Reliability:** retry after a lost response without duplicating a write, allow deliberate repeat meals, and surface conflicting edits instead of silently losing one.
- **Website:** on iPhone Safari, every area above shows correct data and its loading, empty and error states; display totals follow the unknown-value rule.
- **Usability and languages:** calories/core-macro bars preserve target bounds and unknown values. Date-spaced history and current targets remain correct beyond 50 records; returning from chat refreshes the relevant view. English/Ukrainian cover UI, state/accessibility text, consent and no-JavaScript public pages, with supported-browser default/device override, correct plurals/formatting and no loss of form/filter/view state or changes to stored content.
- **Install:** added to the iPhone Home Screen and installed on a Mac from Safari and Chrome, the website opens in its own window with its name and icon, and sign-in works there.
- **Catalogue:** retain source fidelity, GTIN grouping and chat-confirmed links, including correct groups after a link is removed; distinguish unlinked records and preserve conflicting source values.
- **Host workflow:** the skill loads and authenticated reads/writes work on iPhone through the published plugin. Report success only after a confirmed write.

Out of scope: other-app data integrations, server-side AI or nutrition engine, editing diary records on the website, profiles without their own sign-in, profiles seeing each other, data export and licensing. No diary backups for this release (confirmed 2026-10-20); losing the server can permanently lose all personal data. The privacy policy must say so.
