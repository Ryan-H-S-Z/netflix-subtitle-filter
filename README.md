# Netflix Subtitle Filter

**English** | [简体中文](./README.zh-CN.md)

[Repository](https://github.com/Ryan-H-S-Z/netflix-subtitle-filter) · [Report an issue](https://github.com/Ryan-H-S-Z/netflix-subtitle-filter/issues) · [Download releases](https://github.com/Ryan-H-S-Z/netflix-subtitle-filter/releases)

A Chrome Manifest V3 extension that works without a separate server. Once enabled, it filters title cards on Netflix Home, Movies, TV Shows, New & Popular, genre, My List, and search pages. Titles confirmed not to meet your subtitle requirements can either be hidden or kept with a red warning label. You can also load your own subtitle files on playback pages.

## Features

- Automatically filters existing Netflix title cards on Home, Movies, TV Shows, New & Popular, genre, My List, and search pages
- Supports both the newer Home card layout and the carousel layout used on Movies and TV Shows pages; movies are matched by Netflix title ID, while series are matched by show ID or exact show name
- Can be enabled or disabled globally; disabling it immediately restores all cards without deleting the subtitle catalog cache
- Saves rules once and automatically reapplies them after a refresh, category change, or future Netflix visit
- Supports Boolean language rules: languages within one condition group use OR, while separate condition groups use AND
- Supports combinations such as `(Traditional Chinese OR Simplified Chinese) AND English` and `(Traditional Chinese OR Simplified Chinese) AND Thai`
- Includes bilingual presets for Simplified Chinese + English and Traditional Chinese + English
- Includes a Chinese + Thai preset, which requires Thai plus either Chinese variant
- Defaults to English on a new installation; the interface, progress messages, and title-card labels can be switched between English, Simplified Chinese, and Traditional Chinese
- Always shows confirmed matching subtitle languages on title cards, including confirmed languages when other parts of a rule are still unknown
- When **Hide titles that do not meet the subtitle rule** is enabled, confirmed non-matches are hidden; when disabled, they remain visible with a red **Subtitle rule not met** label
- Can refresh only the subtitle catalogs used by the current rule approximately once a week; disabling automatic refresh stops time-based updates, while a manual refresh remains available
- Keeps titles visible when catalog data is incomplete or cannot be read, preventing unknown titles from being incorrectly treated as unsupported
- Provides common presets and supports English, Thai, Japanese, Korean, and many other European and Asian subtitle languages
- Imports local `.srt`, `.vtt`, `.ass`, and `.ssa` subtitle files on playback pages
- Supports UTF-8, GB18030, Big5, and UTF-16 LE subtitle encodings
- Lets you adjust subtitle timing, font size, vertical position, and dark background
- Supports Netflix player fullscreen; if the browser makes the video element itself fullscreen, the extension temporarily uses a native browser subtitle track
- Reads subtitle files locally in the browser and never uploads them to a server

## Installation

### Install from a GitHub release

1. Open the [latest release](https://github.com/Ryan-H-S-Z/netflix-subtitle-filter/releases/latest).
2. Under **Assets**, download the file named `netflix-subtitle-filter-vX.Y.Z.zip`, then extract it.
3. Open `chrome://extensions/` in Chrome.
4. Enable **Developer mode** in the upper-right corner.
5. Select **Load unpacked** and choose the extracted folder.

Chrome cannot install this ordinary ZIP directly, so it must be extracted first. Future versions can be downloaded from the same latest-release page.

### Install from the source folder

1. Open `chrome://extensions/` in Chrome.
2. Enable **Developer mode** in the upper-right corner.
3. Select **Load unpacked**.
4. Choose this project's `netflix-subtitle-filter` folder.
5. Refresh any Netflix tabs that were already open.

## Usage

Click the extension icon in the Chrome toolbar from any page:

1. Turn on **Automatic filtering**.
2. Choose a preset such as **Any Chinese**, or place interchangeable subtitle languages in the same condition group.
3. To require another type of subtitle as well, select **+ Add another required group**.
4. Choose how to handle confirmed non-matches with **Hide titles that do not meet the subtitle rule**: enable it to hide them, or disable it to keep them visible with a red label.
5. Select the red **Save and filter now** button.

The globe icon at the top of the popup opens the interface-language selector, so it remains recognizable even if you cannot read the current language. The Chinese + Thai preset means `(Traditional Chinese OR Simplified Chinese) AND Thai`; it does not mean that any one of the three languages is enough.

For example, place Traditional Chinese and Simplified Chinese in the first group and English in the second group to create `(Traditional Chinese OR Simplified Chinese) AND English`. Netflix displays catalog-loading progress in the lower-right corner. The first load also builds compact title-ID and show-name indexes that are stored locally for later visits.

The enabled state and filtering rules are stored in `chrome.storage.sync`, so you do not need to select **Save and filter now** every time. The extension starts automatically on supported Netflix pages and rechecks cards added through Netflix's single-page navigation and lazy loading. After installing a new extension version or reloading it from the Extensions page, refresh Netflix tabs that were already open once.

Title-ID and normalized show-name indexes are stored in `chrome.storage.local`. They are separated by region, Netflix profile, Netflix interface language, and subtitle language. Home, Movies, TV Shows, genre, My List, New & Popular, and search pages share the appropriate cache. When weekly automatic catalog refresh is disabled, a valid retained cache does not expire solely because time has passed. A catalog may be read again after **Clear all cache and reload**, after region, profile, interface-language, or selected-subtitle-language changes, or when cached data is missing, invalid, migrated, evicted by the extension, or removed by the browser.

When weekly refresh is enabled, a Chrome extension alarm writes an update marker approximately every seven days. The extension reloads only language caches used by the current rule and created before that marker; unselected languages are not downloaded. If Netflix is not open when the update becomes due, the refresh runs the next time you visit a browsing page. Chrome does not wake a sleeping computer for the alarm, so the actual time may be later.

The Netflix catalog responses used by this extension do not provide a reliable `updatedSince` value, collection version, or change cursor. Therefore, the extension cannot download only changed titles while reliably accounting for both additions and removals. To conserve resources, it refreshes selectively by language and time, but an expired language catalog still requires a complete ID check. If an update fails, the old cache is used only to confirm known matches; an old absence is never used to hide a title.

For an OR-only rule, place all languages in one condition group. For an AND-only rule, place one language in each separate group.

On a Netflix playback page, select **Import local subtitles** in the lower-right corner and choose a subtitle file. The text label collapses after five seconds, leaving a compact icon. It expands again when you move the pointer to that corner, hover over it, or focus it with the keyboard, and it stays expanded while the subtitle panel is open. If subtitles are out of sync, use the timing controls to move them earlier or later in 0.5-second steps.

The **Auto** encoding option distinguishes among UTF-8, GB18030, and Big5. If the text is still incorrect, choose an encoding manually; the current file is decoded again immediately, without selecting it a second time. To prevent unusual files from slowing the player, one subtitle file is limited to 16 MB and 50,000 cues.

On the rare pages where the video element itself enters fullscreen, the browser does not allow a normal overlay above it. The extension therefore places only the currently visible subtitle lines in a temporary native subtitle track and removes it immediately after exiting fullscreen. Native browser styling is used in this mode, so the extension's font-size, background, and position settings may temporarily have no effect.

## How filtering works and privacy

Regular Netflix browsing pages do not expose every card's subtitle list in the page. Using the Netflix session already present in the current tab, the extension reads title IDs from Netflix's official **Browse by Languages** catalog and compares them with the Netflix title IDs found on page cards. Requests are not sent to a third-party server. The extension does not save cookies, login tokens, or complete Netflix responses; `chrome.storage.local` contains compact title-ID and normalized show-name indexes plus the cache metadata needed to scope and validate them.

For movies, the ID in `/watch/ID` can be compared directly with the official subtitle catalog. A series playback ID may belong to one episode, so the extension does not use an episode ID to judge the entire series. It first tries to map the episode to its parent show. If that mapping is unavailable, it compares the show name displayed on the page with localized show names from the official subtitle catalog using normalized exact matching. Cards with missing, incomplete, or uncertain names remain visible instead of being guessed from a fuzzy match.

Netflix's catalog interface is not a public developer API and may temporarily stop working after a website update. The extension therefore fails open: absence from a language catalog counts as unsupported only when that catalog is confirmed complete. Titles remain visible if loading fails, their ID cannot be parsed, or the extension cannot safely identify the outer card element. The popup also retains a link to Netflix's official subtitle catalog for manual verification.

The extension hides only outer card elements already mounted by Netflix using CSS; it does not delete or rebuild Netflix's React content. This allows every card to be restored when filtering is disabled and reduces interference with carousel controls, hover previews, and single-page navigation. If a row contains only a few matching cards, Netflix's virtual carousel may not mount additional items to fill the row, so empty space can remain at the end even though excluded cards themselves are hidden.

## Regional availability

Netflix explains that subtitle availability can depend on location, profile language preferences, the specific title, and the device. Caches are separated by country code and a non-readable hash derived from the current profile and Netflix interface locale; the raw profile ID is not stored. This extension does not change your region, bypass licensing restrictions, or download Netflix video. It reads only the official subtitle catalog currently available to your account and displays local subtitle overlays.

TV-show filtering checks whether the complete show appears in the official language catalog; it does not verify every season or episode. A result therefore means that the show offers the selected subtitle language in the current region, not that every episode is guaranteed to have identical availability.

## Feedback and bug reports

Please use [GitHub Issues](https://github.com/Ryan-H-S-Z/netflix-subtitle-filter/issues) to report bugs, request features, or share compatibility feedback. When reporting a filtering problem, include the Chrome version, Netflix page type, extension version, selected rule, expected result, and actual result when possible. Screenshots are helpful, but never include Netflix cookies, account credentials, or login tokens.

## Development and testing

No npm dependencies are required. With Node.js installed, run:

```bash
npm test
npm run check
```

References:

- [Netflix: Why subtitles or audio aren't available in a specific language](https://help.netflix.com/en/node/101798)
- [Netflix: How to search and browse Netflix](https://help.netflix.com/en/node/47765)
- [Chrome: Manifest file format](https://developer.chrome.com/docs/extensions/mv3/manifest)
- [Chrome: Alarms API](https://developer.chrome.com/docs/extensions/reference/api/alarms)

## Disclaimer

This project is not affiliated with Netflix, Inc. Netflix is a trademark of its respective owner.
