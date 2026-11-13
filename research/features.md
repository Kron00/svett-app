# Feature inventory: Hevy and Strava

Source: 53 Hevy and 55 Strava screenshots from Julian's iPhone, taken 2026-11-13,
in `research/screenshots/`. Each item cites the screenshot it came from. Items
marked *(inferred)* were partly visible or only named in a menu, and the screen
behind them wasn't opened. The screenshots show one account's screens, not
roadmaps or rules. Where a line describes what a feature *does* beyond what's on
screen, treat it as unverified.

Reviewed by GPT‑6.1 Sol (high) against all 97 screenshots on 2026-11-13. Its
corrections are applied below.

---

## Hevy (strength training)

**Navigation:** three tabs: Home, Workout, Profile.

### Workout logging
- Start an empty workout, or start one from a saved routine. (002)
- The live logger shows a running duration, total volume, a set count and a
  front/back muscle diagram for the session, with Add Exercise, Settings,
  Discard Workout and Finish. (011, 014)
- Per exercise: a rest timer for that exercise (OFF on Cat-Cow, 3 min on
  another exercise, and the account default is 2:30), a note, and a set table
  with columns SET, PREVIOUS (earlier values as hints; the rule is set in
  "Previous Workout Values"), REPS/weight, and a ✓ to complete each set.
  Add Set. (012, 014, 051)
- The exercise menu offers reorder exercises, replace exercise, add to superset,
  and remove exercise. (015) The reorder and replace flows weren't opened
  *(inferred)*.
- Supersets: choose which exercise to pair with, and paired exercises get a
  purple "Superset" label in the logger. (050, 051)
- Weighted sets show earlier weight and reps in PREVIOUS (e.g. 135 lbs × 8),
  with LBS/REPS entry. (049)
- **Plate calculator:** the target weight is drawn as plates on a bar. You can
  set which plates you own (45, 35, 25, 10, 5, 2.5) and the bar type
  (Standard 45 lb, Short 33 lb…), under Manage equipment. (049)
- Set types are Warm Up (W), Normal (numbered), Failure (F) and Drop (D), with
  "?" help for each, plus Remove Set. (016)
- The rest timer picker scrolls from off to 5s, 10s and longer, with its own
  settings button. (017)
- A clock-shaped control sits beside Finish; its exact function wasn't
  opened. The logger can be minimized with the chevron. (011)

### Workout settings
(012, 013)
- Wearable heart-rate sensor
- Sounds
- Default rest timer (2 min 30 s)
- Previous workout values, which controls how the hints fill in
- Warm-up calculator (on/off) and warm-up set scheme
- Keep the phone awake during a workout
- Plate calculator: a calculator button appears when you enter a barbell weight
- RPE tracking: log RPE per set
- Warm-up calculator: adds percentage-based warm-up sets from an exercise's
  ⋮ menu. It has a warm-up method, plate rounding (5 lb) and dumbbell rounding
  (2 lb). (035)
- Smart superset scrolling: after a set, it jumps to the next exercise in the
  superset
- Inline timer: a stopwatch for duration-based exercises

### Routines and programs
- My Routines list, with folders (the folder+ icon), a ··· menu per routine,
  and an exercise preview on each card. (002)
- Create a routine: a title plus Add exercise. (006)
- Routine menu: share, duplicate, edit, delete. Create a folder. (045, 046)
- Explore has a separate Routines section with categories (e.g. "At home")
  below the programs and Trainer. (003)
- Explore programs: filters for level (Beginner, Medium, Advanced), goal (Gain
  Muscle, Strength, Lose Weight) and equipment (Gym, Dumbbells, None). There
  are 26 programs. (003, 004)
- Program detail: description, level, equipment, goal, number of routines,
  "Created by Hevy", Save Program, a share button, and each routine's exercises
  with set and rep ranges. (005)
- **Trainer:** "Program based on your needs and goals". It generates a
  personalized program from your goal, equipment and other inputs. (003)
  The intro screen's labels name training goal, target muscle, cardio
  preference, training split, experience level and program variety. The actual
  questions and the generated program weren't captured. It promises progressive
  overload (the weights go up as you improve), trainer tips, progress reports
  and "science-backed" programming. There's an FAQ and Get Started. (047)

### Exercise library
- Search, filters for All Equipment and All Muscles, recent exercises, an
  illustration thumbnail for each, the primary muscle, a "Custom" tag for
  exercises the user created, and an info (i) button. Create (custom
  exercise). (007)
- Exercise detail has three tabs:
  - **Summary:** an anatomical illustration with the target muscle
    highlighted, primary muscle, a progress chart with a time range (Year) and
    metric toggles (Most Reps (Set) / Session Reps), and Personal Records
    (Best Set) with a "?" help button. Add exercise straight from the detail
    page. (008)
  - **History:** a scrollable list of past sessions of this exercise with
    their sets. (009)
  - **How to:** pinned exercise notes that show every time you log it, with
    Add Note. (010)
  - Share and ··· menus. (008)

### Finished workouts
- Workout detail: user, date and time, title, time, reps, sets and calories,
  like, comment and share, **muscle split** (% by muscle group), and the logged
  exercises with their sets. Edit Workout. (042)
- Menu: Save as Routine, Copy Workout, Edit Workout, Delete Workout. (043)
- **Share card:** duration, reps, sets, a muscle radar chart, a choice of
  backgrounds and "@username". It goes to Stories or Snapchat, or you can copy
  the text, download it or send it. Several templates, swiped between. (044)
- Exercises dashboard: create, search and filter your exercises. (041)

### Progress and analytics
- The profile has a weekly bar chart with Duration, Volume and Reps toggles and
  a range picker (Last 3 months). (018)
- Dashboard shortcuts: Statistics, Exercises, Measures, Calendar. (018)
- **Statistics:** a 7-day body graph (a heat map of trained muscles, front and
  back) with a day strip. Advanced statistics cover: (019)
  - set count per muscle group
  - muscle distribution as a radar-style chart comparing this period with the
    last
  - muscle distribution as a weekly body heat map
  - main exercises
  - These four entries are menu items; only set count was opened *(inferred)*.
- **Set count per muscle:** a multi-line chart with a date range (Last 30 days)
  and grouping (Week), and checkboxes per muscle with set totals (Shoulders,
  Chest, Biceps, Triceps, Upper Back, Lats, Quads, Hamstrings, Forearms and
  more). Totals can be fractional (Upper Back 36.5), so sets are split across
  muscles by some rule Hevy doesn't show. It has share and ? buttons. (020)
- **Measurements:** a body-weight chart over a selectable range, a dated weight
  history, and + to add a value. (021) It's weight only on this screen; other
  measurements are *(inferred)* from the "+".
- **Calendar:** a month view with each workout's muscle groups labeled
  ("Chest (8) + Tri…"), a week streak counter (13-week streak), a rest-day
  count, share, and display filters, plus a Month view selector. (022)
- Monthly report: there's a setting for a notification when it's ready. The
  report itself wasn't captured. (026)
- Personal records appear on feed cards ("Records 4"). (001)

### Social
- Home feed: workout cards with the user, time, title, caption, duration,
  volume, records, average bpm, a photo carousel, and like, comment and share
  buttons. (001)
- Suggested athletes, Invite a friend, and search and notifications icons on
  Home. Home and Workout titles have dropdown chevrons; the options behind them
  weren't opened. (001, 002)
- Profile: workouts, followers and following counts, bio, edit, share,
  settings, and the workout history list. (018)
- Privacy: private profile (follow requests must be approved), hide suggested
  users, and default visibility for new workouts (Everyone, or a per-workout
  override). (024)
- Push notifications for the rest timer, follows, the monthly report, likes on
  workouts and on comments, comments on workouts, comment replies, and
  @mentions. There's also an opt-in for Hevy emails. (026)
- Notifications inbox: "<friend> liked your workout …", grouped by
  week. (048)

### Integrations and data
- **Strava:** "your workouts will be displayed on your Strava feed". (025)
  Strava's OAuth screen asks to let Hevy see private activity data, including
  **full routes even when an activity is Only You, its map is hidden or a
  privacy zone applies, and hidden fields like start time and heart rate**. It
  also asks to upload activities and read the public profile. A note says
  "Your activities will not contain heart rate data". (039) So a connected app
  can see more than your followers can. How a Hevy workout actually looks in
  Strava wasn't captured.
- **ChatGPT:** "Hevy Plugin for ChatGPT" creates personalized workout plans,
  analyzes your training, and **saves routines directly to your Hevy
  account**. (025) It's a real ChatGPT app ("Install plugin") by Hevy Studios
  S.L., with example prompts such as "@Hevy Build me a well-rounded workout
  plan", "@Hevy Build me the perfect next workout based on my recent
  sessions" and "@Hevy Graph my Barbell Squat progress over the last 6
  months". (038) It's listed in ChatGPT's own plugin directory as "Hevy · Gym
  workout plans and in…", with + to add. On this account neither ChatGPT nor
  Strava is connected to Hevy. (052, 053)
- **Wearable sensor:** one heart-rate sensor at a time. (025)
- **Apple Health:** writes workouts to Health, and reads and updates body
  measurements, heart rate and calories. Permissions are managed in iOS
  Settings. (028, 040)
- **Export:** workouts and measurements as CSV. Exports can't be imported back
  into Hevy. (032)
- **Import:** a one-time import of a CSV from the Strong app only, which can be
  reverted. (033)

### Account and preferences
- Profile: picture, name, bio, link, and private sex and birthday. (030)
- Cancel Subscription is on the subscription page. (034)
- Account: change username, email or password, and delete the account. (029)
- Units: kg/lbs, km/miles, cm/in. (027)
- Language: about 14 options. Theme: OS, Dark or Light. (036, 037)
- **Pricing (Hevy Pro), as offered to this account:** monthly (renews Nov 20,
  2026; the monthly price isn't shown), $23.99 a year, or $74.99 lifetime. Pro adds unlimited routines, unlimited
  graph history, unlimited custom exercises and advanced measurements. So the
  free tier limits routines, chart history and custom exercises. (034)

---

## Strava (cardio, GPS and social)

**Navigation:** five tabs: Home, Maps, Workout (record), Groups, You.

### Recording and activities
- The recorder shows elapsed time, time of day, Paused, Resume and Finish, and
  can be minimized. (016) The sport picker and GPS map view weren't captured.
- Activities synced from other devices (here a Fitbit "Afternoon Row") open an
  edit sheet with title, description, tags, photo/video, **audience**
  (Everyone, Followers, Only You), **hidden details** (calories, start time) and
  Advanced Edit. A tip says "Activities with titles get 3.5x more
  kudos". (001)
- Activity detail: route map with a ▶ play button (the playback itself wasn't
  opened), bookmark, a ··· menu,
  athlete, date and location, and stats. Subscriber-only stats are behind an
  upsell. (011, 012)
- Activity page: "With someone who didn't record? Add Others", the recording
  device, and a ··· menu with Add Media, Edit Activity, Refresh and Delete
  Activity. (048, 049)
- **Athlete Intelligence (paid):** an AI-written summary of each activity, e.g.
  "Excellent run with your fastest pace in over 2 weeks. You pushed into the
  anaerobic zone…". It sits behind "Get smarter insights for faster progress",
  along with Workout Analysis (per-lap pace) and Heart Rate Zones. (048, 050)
- **Share images:** several templates (transparent stat overlays and route
  outlines, marked NEW) shared to Instagram Story or Snapchat, copied, saved or
  linked. (012)

### Home feed
- Top bar: + (create), search, messages, notifications. A "Your streak" strip
  shows the week's days and has a Share button. (047)
- Cards show the athlete, date, the device that recorded it ("Fitbit Air",
  "Apple Watch SE 3"), sport and location, then stats (distance, elevation,
  time, achievements), highlights such as "<friend>'s 3rd fastest 2 miles!", and
  kudos, comment and share. (047)
- Only the first screen was captured because the feed wouldn't scroll through
  iPhone Mirroring. There's a setting for feed ordering. (023)

### Maps, routes and segments
- Route discovery on a map. Filters: sport, length, elevation, surface (with
  % paved), difficulty. Saved items, search, layers, 3D, and locate me.
  (003, 005)
- Map modes: **Routes** (recommendations from community data), **Segments**,
  and **Map only** (heat maps and points of interest). (004)
- Suggested routes tagged "Made for you", showing difficulty, distance,
  elevation and estimated time. (003)
- **Create Route**, a route builder. (005) The builder itself wasn't opened.
- The heat maps and route features are behind a paywall ("Explore anywhere
  with confidence", Start a free trial). (003)
- **Segments:** Starred, KOMs/CRs, Local Legends and Top 10 lists, plus
  Explore Segments. (018)

### Groups
- **Challenges:** sport filters (Run, Ride, Swim, Walk, Hike…), sponsored
  challenges (e.g. iFIT "Log 200 mins. Win a free coaching session"), and
  **group challenges**, custom ones made with friends, which need a
  subscription. "What's New". (008)
- **Clubs:** Create a Club, a featured club (The Strava Club, 7.3M athletes),
  popular clubs nearby with Join buttons. (007)
- **Events:** local club events with date, sport, location and member counts,
  and a Races list (e.g. Carlsbad Marathon, 1,227 "Runna athletes racing").
  (006)
- A messages icon and group settings on Groups; what the icon opens wasn't
  captured. (006)

### Profile ("You")
- Name, activity count, followers and following, Edit profile, Share profile,
  search, settings, and + to create something *(inferred: a post or manual
  activity)*. (009)
- **Progress tab:** sport filter (All Sports, Row…), this week's distance and
  time, a 12-week chart, and a weekly streak with a monthly calendar of
  dots. (009)
- **Activities tab:** search and filter your activities (filters: All,
  Distance, Time, Elevation, Dates, Activity Tags), and the activity
  list. Searches for "Hevy" and "Strength" found nothing on this account. (051,
  052) Each card shows its source ("Fitbit Air", "Strava App"), sport, time and
  location, with kudos, comment and share buttons, and nudges such as "Nicely
  done! Keep moving by joining a challenge". (010)
- **More tab:** Statistics, Segments, Gear, Challenges, and a Trophy Case with
  badges. (013)
- **Statistics:** per sport (ride, run, swim): weekly averages (count, time,
  distance), year-to-date totals (count, time, distance, elevation), all-time
  totals, and best efforts (longest ride…). (017)
- **Search:** find friends and clubs, with suggested athletes. (019)

### Notifications
- "Your activity is ready", missing health data, streak alerts ("logging an
  activity once a week keeps it alive"), and "N years ago today"
  memories. (002)

### Integrations, data and AI
- **Connect a new device:** upload directly from a GPS device. (015)
- **Connect an app or device:** "Upload directly to Strava with almost any
  fitness app or device". (014)
- **AI Assistants:** "Connect to the AI assistant you use for personalized
  conversations on your activities and training". (014, 015)
- **Health** (Apple Health) is connected. It auto-uploads Health workouts even
  when Strava isn't running, can optionally send activities back to Health,
  notifies you of new importable workouts, and lists the last 90 days of
  Health workouts with an Import button on each. (015, 022) Tapping a
  workout's row text imports it straight away, with no preview or
  confirmation. A checkmark replaces Import. (055)
- **AI Assistants is paid.** Both entry points (Settings, and Apps and
  devices) go straight to the subscription offer ("Try the very best of
  Strava. First month's on us."). No list of supported assistants or
  permissions appears before the paywall. (053, 054)
- Partner integrations, weather, Siri & Shortcuts, and a separate **Health
  Data** page (not opened). (023)
- **Rewards partner:** link a partner account for benefits. (015)

### Privacy and safety
Strava's privacy model is far more detailed than Hevy's. (024–040)
- **Where you appear:**
  - **Profile page:** Everyone or Followers. Followers means you approve
    followers, but some profile information stays publicly searchable. (025)
  - **Activities:** Everyone, Followers or Only You. This is the default, and
    each activity can override it. Followers-only activities drop off segment
    and challenge leaderboards and may not count toward some challenges. Only
    You activities can still show challenge progress to followers. (026)
  - **Group activities:** Strava automatically detects athletes who recorded
    together. Everyone, Followers (people who follow you *and* people you
    follow) or No One. (027)
  - **Flybys:** show athletes who crossed your path, with minute-by-minute
    playback. Everyone or No One, and only Everyone activities qualify. (028)
  - **Local Legends:** Everyone or No One. Opting back in counts only future
    activities. (029)
  - **Mentions:** Everyone, Followers or No One. (030)
  - **Who can message you:** Following, Mutuals or No One. No One stops others
    from starting a chat, but you can still start one. (031)
- **Map visibility:** hide start and end points near an address or everywhere,
  or hide maps completely. (032)
- **Muscle map visibility:** a hide toggle, so Strava activities can carry a
  muscle map. (033)
- **Hidden details:** per-field defaults for weight lifted, start time,
  pace/speed, calories, power and heart rate, each overridable per activity.
  Strava has a weight-lifted field, but no screenshot shows a set-and-rep
  logger. (034)
- Privacy defaults apply only to *future* activities. Older ones are changed
  one at a time or with the bulk edit of past activities. (033, 034, 038)
- **Product improvements:** sharing your data to help "build smarter AI
  features", and it powers Metro, the Global Heatmap and points of interest.
  It's on for this account; whether that's the default isn't shown. Turning it
  off may remove experimental features. (036)
- **Public photos on routes:** shared only if your profile and activity are
  public. Hidden-address areas are excluded, Strava tries to exclude faces and
  gear, and photos are removed when deleted or made private. (037)
- Blocked accounts. A "Do not share my personal information" ad opt-out.
  Auto-join for segment challenges that match your saved routes. (035, 039,
  040)
- **Beacon:** live location sharing with up to three safety contacts. It has a
  mobile on/off toggle and Add Safety Contacts. Automatic sending from an
  Apple Watch or other apps depends on your country and area code. (041)

### Preferences
- Appearance, units (imperial), temperature, default highlight image (map or
  photo), video autoplay, default maps, **feed ordering**, training zones,
  email notifications. (023, 042)
- **Gear:** track mileage and use of shoes and bikes. (043)
- Trophy case: milestone badges for the 1st, 3rd, 5th, 10th, 20th and 30th
  activities. (044, 045)

### Account and monetization
- The subscription upsell is everywhere: map features, stats, group challenges,
  and a bundle "Strava + Runna, up to 60% off, 30-day trial". (003, 008, 011,
  014)
- The subscription unlocks routes, segment leaderboards and advanced training
  analysis. The first month is free, with a reminder 2 days before billing;
  cancel at least 24 hours before you're charged. No Strava price is shown in
  any screenshot. (020)
- **Training Plans** come from Runna ("by Strava"), synced with Strava: Race
  (most popular; a plan for your next race), 5k improvement, and Start
  running. (014, 021)
- Restore Purchases, Change Email, Phone Number. (014)

---

## What this means for svett

These are judgments, not facts read off a screen. Each one says what backs it
up and what's still open.

1. **Strava is adding strength features.** It has muscle maps and a "weight
   lifted" field (033, 034). How deep its strength logging goes is unknown, and
   so is how fast it's moving. Capture a Strava strength activity before
   assuming a window is closing.
2. **"Your data, usable by ChatGPT" isn't new by itself.** Hevy ships a ChatGPT
   app that saves routines to your account and graphs progress (038). Strava
   has an "AI Assistants" connection (014, 015), and it's **paid**: both entry
   points go straight to the subscription offer (053, 054). Strava also sells
   its own AI activity summaries, called "Athlete Intelligence" (050). Still
   unknown: which assistants Strava supports and what they can read or write.
   Hevy's ChatGPT app costs nothing extra, but each user signs in with their
   own ChatGPT account and uses their own plan. svett should work the same way:
   the user brings their own assistant account, so svett pays no model costs.
   What sets svett apart is that it covers all of a user's health data in one
   connection, with read and write access, and isn't paywalled. Strava charges
   for AI, and Hevy's covers only lifting. The opening svett can try for is one assistant connection across
   all of a user's health data, read and write, for any assistant. It also
   needs clear scopes. Hevy's link to Strava shows how a connected app can see
   more than the user's own privacy settings show followers (039). svett
   should keep assistant access and social visibility separate and visible to
   the user.
3. **Data portability is weak on both sides.**
   - Hevy exports CSV that can't be re-imported, and imports once, only from
     Strong (032, 033).
   - Strava pulls Health workouts in automatically, and can optionally send
     them back (022).
   - No export from Strava was captured.
   - Strava's Health import fires on a single tap with no preview or undo
     (055). That's a bad pattern for a product built on owning your data.

   Duplicates, edits, deletions and backfills across sources are the real
   product problem, and none of it was captured.
4. **A combined feed is the bet, but it's unproven.** Hevy says it posts
   workouts to your Strava feed (025). No screenshot shows what survives:
   sets, reps, muscle data or heart rate. Julian's accounts aren't connected,
   and searching his Strava found no strength activities (Strava 051, 052; Hevy 052).
   The test means connecting Hevy to Strava and posting one workout, which
   would be visible publicly.
5. **Shared basics to build once:** a feed with likes, comments and share
   cards; follow; audience per post; streaks; personal records; Apple Health;
   notifications; units. Heart-rate sensors and a calendar were only seen in
   Hevy, and the two apps' privacy models aren't equivalent.
6. **Hevy's depth is in the logger:** set types, supersets, warm-up and plate
   calculators, RPE, previous-value hints, rest timers, muscle heat maps, and
   per-exercise history and records. What actually makes lifters switch needs
   user evidence. It may be fast entry and importing routines and history more
   than matching every calculator.
7. **Strava's depth is in GPS and community:** routes, heat maps, segments and
   leaderboards, clubs, events, challenges, the trophy case. Importing GPS
   activities before recording them is a proposal, not a finding. Imports still
   need reliable sync and useful analysis.
8. **Privacy has to be detailed from day one.** Hevy has a private profile,
   hidden suggestions and a default workout audience with per-workout override
   (024). Strava adds per-field hiding, map privacy zones, defaults that apply
   only going forward, and leaderboard and challenge side effects (025–040).
   svett also needs assistant access scopes and private defaults for body
   measurements.
9. **Pricing:** this account was offered Hevy Pro at $23.99 a year or $74.99
   lifetime; the monthly price isn't shown (034). There's no Strava price, only
   a free first month and a Runna bundle at "up to 60% off" (014, 020).
10. **Patterns worth copying:** the Trainer program generator (quality
    untested), a monthly report, "N years ago" memories, share images. Don't
    copy Hevy's one-time import. For data ownership, svett needs repeatable
    imports with deduplication and rollback.

## Still not captured
Three capture passes couldn't reach these:
- **Hevy:** the warm-up calculator inside the logger, RPE entry (the setting is
  off, and was left that way), the monthly or yearly report, and the long-press
  menu on a routine.
- **Strava:** the full activity page below the paid insights (splits, laps,
  segments, comments), training log, goals, route builder, sport picker, data
  download/export, Health Data, Feed Ordering and Units settings, and more than
  the first screen of the Home feed. Push notification settings opened blank.

Long Strava screens wouldn't scroll through iPhone Mirroring, so the agents
couldn't get past the first screen. These are quickest to grab by hand on the
phone.

The review flagged these as most important for product decisions:
- **Strength across apps:** the same Hevy workout in both apps, compared
  field by field (exercises, sets, heart rate, muscle map).
- **Assistant access:** for both apps, the authorization scopes, what the
  assistant actually reads and writes, whether it asks before changing
  anything, and how to revoke it.
- **Sync and data ownership:** duplicate imports, edited or deleted source
  workouts, failed permissions, and what an export actually contains.
- **Strava Home feed:** feed ordering, mixed sports, comments, follow
  requests, messaging.
- **Hevy save flow:** saving a workout (title, audience, media), the active
  rest countdown, duration-based exercises, and recovering an interrupted
  workout.
- **Authoring:** custom exercise fields, set targets in a routine, and
  replacing an exercise.
- **Health beyond workouts:** measurement types and how to enter them, and
  Strava's Health Data page.
- **Coaching and pricing:** Trainer's real output, the handoff to Runna, the
  exact free-tier limits, and actual prices.
