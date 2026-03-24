import { ftch, LunaUnload, Tracer } from "@luna/core";
import { redux, observe, safeTimeout, MediaItem } from "@luna/lib";
import { settings, Settings } from "./Settings";
// Module for Romantization
import { convert as hangulToRoman } from "hangul-romanization";
import { pinyin } from "pinyin";


export const { trace } = Tracer("[LangRomanizer]");
export { Settings };

// clean up resources
export const unloads = new Set<LunaUnload>();

// #region Enum, Const, Let

// Regex 
const regexJp = (/\p{sc=Hiragana}|\p{sc=Katakana}/u);
const regexCn = (/\p{sc=Han}/u);
const regexKr = (/\p{sc=Hangul}/u);
const regexLat = (/\p{sc=Latin}/u);

enum lyricsStateEnum {
    original, romanized
}

enum scriptsEnum {
    Latin,
    LatinJ,
    LatinK,
    LatinC,
    LatinCJK,
    CJK,
    Cn,
    Jp,
    Kr,
}


// Plugin variables
let lyricsMedia: redux.Lyrics | undefined;
let romanizedLyrics: Map<string, string> = new Map();
let islyricsContainerLoaded = false;
let isNOWPLAYING = false;
let isLyricsProcessed = false;
let lyricsState = lyricsStateEnum.original;
let syncRetryTimeout: LunaUnload | undefined;
let lyricsDomSyncTimeout: LunaUnload | undefined;
let syncMedia = 0;
let currentTrackId: redux.ItemId | undefined;
let currentMediaType: redux.ContentType | undefined;
let lyricsDomObserver: MutationObserver | undefined;


// #region Helpers

/**
 * 
 * @param msg Message for the trace debug
*/
function _traceDebug(...msg: any[]): void {
    if (settings.showDebug) {
        if (msg.length == 1) trace.debug(msg[0]);
        else trace.debug(msg);
    }
}

function normalizeLyricsLine(text?: string | null): string {
    return text?.replace(/\s+/g, " ").trim() ?? "";
}

function getLyricsLineSpans(): HTMLSpanElement[] {
    const nowPlayingLines = Array.from(
        document.querySelectorAll('[data-test="now-playing-lyrics"] [data-test="lyrics-line"]')
    ) as HTMLSpanElement[];
    if (nowPlayingLines.length > 0) {
        return nowPlayingLines;
    }

    return Array.from(
        document.querySelector('[class^="_lyricsText"]')
            ?.querySelector("div")
            ?.querySelectorAll("span[class]") ?? []
    ) as HTMLSpanElement[];
}

function buildLyricsFromDom(): redux.Lyrics | undefined {
    const lines = getLyricsLineSpans()
        .map((span) => normalizeLyricsLine(span.dataset.langRomanizerOriginal ?? span.textContent))
        .filter((line) => line.length > 0 && line !== "...");

    if (lines.length === 0) return;

    const itemId = (currentTrackId ?? "dom-fallback") as redux.ItemId;
    const lyrics = {
        trackId: itemId,
        lyricsProvider: "dom-fallback",
        providerCommontrackId: itemId,
        providerLyricsId: itemId,
        lyrics: lines.join("\n"),
        subtitles: "",
        isRightToLeft: false,
    } as redux.Lyrics;

    _traceDebug("Lyrics extracted from DOM", {
        trackId: itemId,
        lyricLines: lines.length,
        preview: lines.slice(0, 3),
    });

    return lyrics;
}

function clearSyncRetry(): void {
    if (syncRetryTimeout) {
        syncRetryTimeout();
        syncRetryTimeout = undefined;
    }
}

function clearLyricsDomSync(): void {
    if (lyricsDomSyncTimeout) {
        lyricsDomSyncTimeout();
        lyricsDomSyncTimeout = undefined;
    }
}

function scheduleSyncRetry(mediaItem: MediaItem | undefined, attempt: number, delay: number, mediaVersion: number): void {
    clearSyncRetry();
    syncRetryTimeout = safeTimeout(unloads, () => {
        syncRetryTimeout = undefined;
        void syncLyricsToDom(mediaItem, attempt, mediaVersion);
    }, delay);
}

function refreshLyricsFromDom(force = false): boolean {
    if (!force && lyricsMedia?.lyricsProvider !== "dom-fallback") return false;

    const domLyrics = buildLyricsFromDom();
    if (!domLyrics) return false;

    const prevLyrics = lyricsMedia?.lyrics;
    if (force || prevLyrics !== domLyrics.lyrics) {
        lyricsMedia = domLyrics;
        isLyricsProcessed = false;
        romanizedLyrics.clear();
        _traceDebug("Updated DOM lyrics fallback", {
            lyricLines: domLyrics.lyrics.split("\n").length,
            preview: domLyrics.lyrics.split("\n").slice(0, 3),
        });
        return true;
    }

    return false;
}

function disconnectLyricsDomObserver(): void {
    lyricsDomObserver?.disconnect();
    lyricsDomObserver = undefined;
    clearLyricsDomSync();
}

function connectLyricsDomObserver(node: HTMLElement): void {
    const target = node.matches('[data-test="now-playing-lyrics"]')
        ? node
        : node.closest<HTMLElement>('[data-test="now-playing-lyrics"]') ?? node;

    disconnectLyricsDomObserver();

    lyricsDomObserver = new MutationObserver(() => {
        if (!isNOWPLAYING) return;
        if (lyricsMedia?.lyricsProvider !== "dom-fallback") return;

        clearLyricsDomSync();
        lyricsDomSyncTimeout = safeTimeout(unloads, () => {
            lyricsDomSyncTimeout = undefined;
            if (refreshLyricsFromDom()) {
                void syncLyricsToDom(undefined, 0, syncMedia);
            }
        }, 250);
    });
    lyricsDomObserver.observe(target, {
        childList: true,
        subtree: true,
        characterData: true,
    });
}

/**
 * 
 * @param text Text to check in what script is
 * @returns { scriptsEnum } Enum with the possibles combinations (probably, i think, idk)
 */
function checkScript(text: string): scriptsEnum {
    const hasJp = regexJp.test(text);
    const hasCn = regexCn.test(text);
    const hasKr = regexKr.test(text);
    const hasLat = regexLat.test(text);

    switch (true) {
        case !hasLat && hasCn && !hasJp && !hasKr:
            return scriptsEnum.Cn;
        case !hasLat && hasJp && !hasKr:
            return scriptsEnum.Jp;
        case !hasLat && hasKr && !hasJp && !hasCn:
            return scriptsEnum.Kr;
        case !hasLat && hasCn && hasKr && hasJp:
            return scriptsEnum.CJK;
        case hasLat && !hasCn && !hasJp && !hasKr:
            return scriptsEnum.Latin;
        case hasLat && hasCn && !hasJp && !hasKr:
            return scriptsEnum.LatinC;
        case hasLat && hasJp && !hasKr:
            return scriptsEnum.LatinJ;
        case hasLat && !hasCn && !hasJp && hasKr:
            return scriptsEnum.LatinK;
        case hasLat && (hasCn || hasJp || hasKr):
            return scriptsEnum.LatinCJK;
        case !hasJp && !hasCn && !hasKr:
        default:
            return scriptsEnum.Latin
    }
}

// #region Romanizer

/**
 * Batch the lyrics by the script so if the lyrics is japanese we can skip the need 
 * to call multiple times the Sudachi API 
 * 
 * @param {Map<number, string>} lyrics Map: IndexOrder and the lyrics line
 * @param script What script is gonna romanize, value from the scriptsEnum
 * @returns {Map<number, string[]>} Map with the IndexOrder and a string Array ['original', 'romaji']
 */
async function romanizer(lyrics: Map<number, string>, script: scriptsEnum): Promise<Map<number, string[]>> {
    let resultMap = new Map<number, string[]>();
    if (script == scriptsEnum.Jp) {
        const res = await ftch.json<{
            "results": any
        }>("https://sudachi.quimdabola.top/tokenize", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'X-Romaji-Style': settings.japaneseRomajiStyle,
                'X-Token-Mode': 'C'
            },
            body: JSON.stringify(Object.fromEntries(lyrics))
        });

        const results = res.results ?? Object.values(res.results ?? {});
        results.forEach((tokens: { 'key': string, 'dict': string[][] }) => {
            const lineIndex = parseInt(tokens.key, 10);
            const originalLine = lyrics.get(lineIndex) || '';
            const romanizedLine = tokens.dict
                .filter(token => token[1] !== ' ')
                .map(token => token[1] ?? token[0] ?? '')
                .join(' ');

            resultMap.set(lineIndex, [originalLine, romanizedLine]);
        });
    }
    else {
        for (const [index, line] of lyrics.entries()) {
            let romanizedLine = '';
            if (script === scriptsEnum.Kr || script === scriptsEnum.LatinK) {
                romanizedLine = hangulToRoman(line);
            } else if (script === scriptsEnum.Cn || script === scriptsEnum.LatinC) {
                romanizedLine = pinyin(line, {
                    style: pinyin.STYLE_TONE,
                    heteronym: false
                }).flat().join(' ');
            }
            resultMap.set(index, [line, romanizedLine]);
        }
    }
    _traceDebug("Romanizer Method", scriptsEnum[script], resultMap);
    return resultMap;
}



// #region Process Lyrics

/**
 * First this method checks if the lyrics does have any script to romanize, if not return null.
 * Next splits the lyrics and subtitle (this has the timestamp like this [MM:SS.miliseconds] LyricsText )
 * so for each line is gonna check the script of the text and save it to a map that is gonna save for each
 * script the lines with their order so later it can batch the call to {@link romanizer } method.
 * 
 * @param  {redux.Lyrics} lyrics object that has the lyrics
 */
async function processLyrics(lyrics: redux.Lyrics) {
    if (!lyrics || isLyricsProcessed) return null;

    const lyricsWithoutLatin = lyrics.lyrics.replace(/\p{Script=Latin}/gu, "");
    if (!lyricsWithoutLatin) {
        _traceDebug("Lyrics script using Latin without CJK, no need to Romantize.");
        return null;
    }
    const hasJapanese = regexJp.test(lyrics.lyrics);
    const lyricsScript = checkScript(lyrics.lyrics.replace(/[ \-\/.,!?;:'"(){}\[\]_+=<>@#$%^&*\\|~`]/g, ""));

    try {
        trace.log("Starting processing lyrics with script: ", scriptsEnum[lyricsScript]);
        const splitLyrics = lyrics.lyrics.split("\n");
        const splitedLyricsMap = new Map<scriptsEnum, Map<number, string>>();

        function updateNested(key1: scriptsEnum, id: number, text: string) {
            const lyricsIndexed = splitedLyricsMap.get(key1) ?? new Map();
            lyricsIndexed.set(id, text);
            splitedLyricsMap.set(key1, lyricsIndexed);
        }

        for (let index: number = 0; index < splitLyrics.length; index++) {
            const line = splitLyrics[index].trim();
            let lineScript = checkScript(line);
            if (hasJapanese
                && (lineScript === scriptsEnum.Cn
                    || lineScript === scriptsEnum.LatinJ)) {
                lineScript = scriptsEnum.Jp;
            }
            else { lineScript = checkScript(line.replace(/[ \-\/.,!?;:'"(){}\[\]_+=<>@#$%^&*\\|~`]/g, "")); }

            if (lineScript !== scriptsEnum.Latin) { updateNested(lineScript, index, line); }
        }

        const promises = Array.from(splitedLyricsMap.entries()).map(async ([key, value]) => {
            _traceDebug(value, scriptsEnum[key]);
            return romanizer(value, key);
        });

        const results = await Promise.all(promises);

        const lyricsRomanized = new Map(
            Array.from(results)
                .flatMap(r => [...r.entries()])
                .sort(([a], [b]) => a - b)
                .map(([_, [original, romanized]]) => [normalizeLyricsLine(original), romanized])
        );

        if (lyricsRomanized.size > 0) {
            _traceDebug("All lyrics romanized:", lyricsRomanized);
        }

        const newSubtitles = lyrics.subtitles
            ? lyrics.subtitles.split("\n").map(sub => {
                const timeMatch = sub.match(/^\[[\d:.]+\]\s*/);
                if (timeMatch) {
                    const time = timeMatch[0]
                    const lineSub = lyricsRomanized.get(normalizeLyricsLine(sub.substring(time.length)));
                    if (lineSub) {
                        return sub + " #-# " + lineSub;
                    }
                }
                return sub;
            }).join("\n")
            : "";
        const newLyrics = splitLyrics.map(lyr => {
            const lineLyrics = lyricsRomanized.get(normalizeLyricsLine(lyr))?.trim();
            if (lineLyrics) {
                return lyr + " #-# " + lineLyrics;
            }
            return lyr
        }).join("\n");
        _traceDebug("Lyrics processed", [newSubtitles, newLyrics]);
        romanizedLyrics = lyricsRomanized;
        isLyricsProcessed = true;
    } catch (error) {
        trace.msg.err("Error during lyrics romanization:", error);
        return null;
    }
};



// #region Button

/**
 * Applys the romanization text on the lyrics container
 * because the redux action wasn't capture it needs to modify manually
 * the lyrics DOM, for what I tested this way is more reliable. 
 */
const applyRomanization = function (): number {
    const lyricsSpans = getLyricsLineSpans();
    let appliedCount = 0;
    _traceDebug("Apply Romanization", {
        spansFound: lyricsSpans.length,
        romanizedLines: romanizedLyrics.size,
        lyricsState: lyricsStateEnum[lyricsState],
        toggleRomanize: settings.toggleRomanize,
    });

    lyricsSpans.forEach(span => {
        const currentState = span.dataset.langRomanizerState;
        const originalText = normalizeLyricsLine(span.dataset.langRomanizerOriginal ?? span.textContent);
        const cachedRomanized = span.dataset.langRomanizerRomanized;

        if (settings.toggleRomanize && currentState === "romanized" && cachedRomanized) {
            appliedCount++;
            return;
        }
        if (!settings.toggleRomanize && currentState === "original" && cachedRomanized) {
            appliedCount++;
            return;
        }

        if (!originalText || !romanizedLyrics.has(originalText)) return;

        const romanizedText = romanizedLyrics.get(originalText)!;
        _traceDebug(romanizedText);

        if (settings.toggleRomanize) {
            // Show romanized, hide original
            const hiddenOriginal = document.createElement('span');
            hiddenOriginal.style.display = 'none';
            hiddenOriginal.textContent = originalText;
            hiddenOriginal.dataset.langRomanizerHidden = 'original';

            span.innerHTML = '';  // Full reset
            span.appendChild(hiddenOriginal);
            span.appendChild(document.createTextNode(romanizedText));
            span.dataset.langRomanizerOriginal = originalText;
            span.dataset.langRomanizerRomanized = romanizedText;
            span.dataset.langRomanizerState = 'romanized';
            lyricsState = lyricsStateEnum.romanized
        } else {
            // Show original, hide romanized  
            const hiddenRomanized = document.createElement('span');
            hiddenRomanized.style.display = 'none';
            hiddenRomanized.textContent = romanizedText;
            hiddenRomanized.dataset.langRomanizerHidden = 'romanized';

            span.innerHTML = originalText;  // Reset to original
            span.appendChild(hiddenRomanized);
            span.dataset.langRomanizerOriginal = originalText;
            span.dataset.langRomanizerRomanized = romanizedText;
            span.dataset.langRomanizerState = 'original';
            lyricsState = lyricsStateEnum.original
        }
        appliedCount++;
    });

    _traceDebug("Apply Romanization Result", { appliedCount, spansFound: lyricsSpans.length });
    return appliedCount;
};

/**
 * Button action method, toggle between Original and Romantized lyrics
 */
const toggleLyricsRomanization = async function () {
    if (!lyricsMedia) {
        let mediaItem = await MediaItem.fromPlaybackContext();
        if (!mediaItem) return;
        await loadLyrics(mediaItem);
    }
    if (!lyricsMedia) return;

    if (romanizedLyrics.size === 0) {
        await processLyrics(lyricsMedia);
    }
    const lyricsSpans = getLyricsLineSpans();

    trace.msg.log("Switching lyrics to", lyricsStateEnum[lyricsState]);
    lyricsSpans.forEach(span => {
        const hiddenSpan = span.querySelector('span[style*="display: none"]') as HTMLSpanElement;
        if (!hiddenSpan) return;

        // Find visible text content
        const visibleTextNode = Array.from(span.childNodes)
            .find(node => node.nodeType === Node.TEXT_NODE) as Text;

        if (visibleTextNode && hiddenSpan.textContent) {
            lyricsState = lyricsState === lyricsStateEnum.original
                ? lyricsStateEnum.romanized : lyricsStateEnum.original
            // Swap: hidden - visible
            const temp = hiddenSpan.textContent;
            hiddenSpan.textContent = visibleTextNode.textContent?.trim() || '';
            visibleTextNode.textContent = temp;
            span.dataset.langRomanizerState = lyricsState === lyricsStateEnum.romanized ? 'romanized' : 'original';
        }
    });
}

async function syncLyricsToDom(mediaItem?: MediaItem, attempt = 0, mediaVersion = syncMedia): Promise<void> {
    if (mediaVersion !== syncMedia) return;
    if (!isNOWPLAYING || !settings.toggleRomanize) return;

    refreshLyricsFromDom();

    if (!lyricsMedia) {
        const loaded = await loadLyrics(mediaItem);
        if (!loaded) {
            if (attempt < 6) {
                _traceDebug("Lyrics not available yet, retrying load", { attempt: attempt + 1 });
                scheduleSyncRetry(mediaItem, attempt + 1, 800, mediaVersion);
            }
            return;
        }
    }

    if (!lyricsMedia) return;

    if (romanizedLyrics.size === 0) {
        _traceDebug("Lyrics container ready but no romanized data - processing now");
        await processLyrics(lyricsMedia);
        if (romanizedLyrics.size === 0) {
            _traceDebug("No romanizable lyrics found for current track");
            return;
        }
    }

    const appliedCount = applyRomanization();
    if (appliedCount > 0) {
        clearSyncRetry();
        return;
    }
    if (attempt < 6) {
        _traceDebug("No lyrics were applied to DOM yet, retrying", { attempt: attempt + 1 });
        scheduleSyncRetry(mediaItem, attempt + 1, 800, mediaVersion);
    }
}

// Creates a button to toggle romanization of lyrics and places it next to the fullscreen button
// thanks to meowarex literally copied from their plugin xd
const createRomanizeButton = () => {
    safeTimeout(unloads, () => {
        // Check if the button already exists
        if (document.querySelector('#romanize-button')) return;

        // Support both older and newer Tidal button test IDs.
        const headerButton = document.querySelector(
            '[data-test^="request-fullscreen"], [data-test^="toggle-lyrics"]'
        );
        // Not found, retry after a delay
        if (!headerButton || !headerButton.parentElement) {
            safeTimeout(unloads, () => createRomanizeButton(), 1250);
            return;
        }
        const headerButtonSpan = headerButton.querySelector("span");
        if (!headerButtonSpan || !headerButtonSpan.parentElement) {
            safeTimeout(unloads, () => createRomanizeButton(), 1250);
            return;
        }
        const buttonContainer = headerButton.parentElement;
        const spanClass = headerButtonSpan.className;

        // Create the button element
        const romanizeButton = document.createElement("button");
        const romanizeSpan = document.createElement("span");
        romanizeButton.id = 'romanize-button';
        romanizeButton.className = 'romanize-button' + " " + headerButton.className;
        romanizeSpan.textContent = 'Romanize Lyrics';
        if (spanClass) {
            romanizeSpan.className = spanClass;
            romanizeSpan.setAttribute('data-save-color', 'textDefault');
        }

        romanizeButton.onclick = toggleLyricsRomanization;

        // Insert after the fullscreen button
        romanizeButton.appendChild(romanizeSpan);
        buttonContainer.insertBefore(romanizeButton, headerButton.nextSibling);

    }, 500);
};



// #region Listeners

/**
 * This observer checks for the CSS class that starts with "_lyricsText"
 * @returns { void } void
 */
function lyricsContainerObserver(): void {
    //const lyricsText = document.querySelector('[class^="_lyricsText"]');
    //if (lyricsText) return;
    observe<HTMLElement>(unloads, '[class^="_lyricsText"], [data-test="now-playing-lyrics"]', (node) => {
        if (node) {
            _traceDebug("Lyrics Text container found!");
            _traceDebug({
                "isNOWPLAYING": isNOWPLAYING, "romanizedLyrics": romanizedLyrics.size,
                "toggleRomanize": settings.toggleRomanize, "lyricsState": lyricsState
            });
            islyricsContainerLoaded = true;
            connectLyricsDomObserver(node);
            safeTimeout(unloads, () => {
                void syncLyricsToDom(undefined, 0, syncMedia);
            }, 500);
        } else if (!node) {
            islyricsContainerLoaded = false;
            disconnectLyricsDomObserver();
        } else {
            _traceDebug("Lyrics container not loaded");
        }
    });
}

// Entered the view where's the queue, suggested tracks, lyrics, credits.
redux.intercept("view/ENTERED_NOWPLAYING", unloads, () => {
    createRomanizeButton();
    isNOWPLAYING = true;
});

redux.intercept("view/EXIT_NOWPLAYING", unloads, () => {
    isNOWPLAYING = false;
    disconnectLyricsDomObserver();
});

/**
 * Load the lyrics using the MediaItem, seems more reliable than intercepting
 * the "content/LOAD_ITEM_LYRICS_SUCCESS" and even works when other plugins
 * that modifies the lyrics with the {@link redux.actions} like the lrclib
 * plugin from @vMohammad24 
 * 
 * @param {MediaItem} MediaItem object that contains the Lyrics interface
 * @returns void
 */
async function loadLyrics(mediaItem?: MediaItem): Promise<boolean> {
    if (!mediaItem) {
        mediaItem = await MediaItem.fromPlaybackContext();
        _traceDebug("MediaItem.fromPlaybackContext()", mediaItem
            ? {
                id: mediaItem.id,
                title: mediaItem.tidalItem?.title,
                contentType: mediaItem.contentType,
            }
            : undefined);
    }

    if (!mediaItem) {
        lyricsMedia = undefined;
        currentTrackId = undefined;
        currentMediaType = undefined;
        return false;
    }
    currentTrackId = mediaItem.id;
    currentMediaType = mediaItem.contentType;

    _traceDebug("loadLyrics mediaItem", {
        id: mediaItem.id,
        title: mediaItem.tidalItem?.title,
        contentType: mediaItem.contentType,
    });

    const lyrics = await mediaItem.lyrics();
    _traceDebug("mediaItem.lyrics()", lyrics
        ? {
            trackId: lyrics.trackId,
            provider: lyrics.lyricsProvider,
            hasLyrics: !!lyrics.lyrics,
            hasSubtitles: !!lyrics.subtitles,
            lyricLines: lyrics.lyrics?.split("\n").length ?? 0,
        }
        : undefined);
    if (!lyrics || !lyrics.lyrics) {
        const domLyrics = buildLyricsFromDom();
        if (domLyrics) {
            lyricsMedia = domLyrics;
            _traceDebug("Using DOM lyrics fallback", {
                trackId: domLyrics.trackId,
                provider: domLyrics.lyricsProvider,
                lyricLines: domLyrics.lyrics.split("\n").length,
                currentMediaType,
            });
            return true;
        }
        lyricsMedia = undefined;
        return false;
    }
    lyricsMedia = lyrics;
    _traceDebug("Lyrics Loaded", {
        provider: lyrics.lyricsProvider,
        hasSubtitles: !!lyrics.subtitles,
        lyricLines: lyrics.lyrics.split("\n").length,
    });
    return true;
}

redux.intercept("content/LOAD_ITEM_LYRICS", unloads, (payload) => {
    _traceDebug("content/LOAD_ITEM_LYRICS", payload);
});

redux.intercept("content/LOAD_ITEM_LYRICS_FAIL", unloads, (payload) => {
    _traceDebug("content/LOAD_ITEM_LYRICS_FAIL", payload);
});

redux.intercept("content/LOAD_ITEM_LYRICS_SUCCESS", unloads, (lyrics) => {
    _traceDebug("content/LOAD_ITEM_LYRICS_SUCCESS", {
        trackId: lyrics.trackId,
        provider: lyrics.lyricsProvider,
        hasLyrics: !!lyrics.lyrics,
        hasSubtitles: !!lyrics.subtitles,
        lyricLines: lyrics.lyrics?.split("\n").length ?? 0,
        currentTrackId,
    });

    if (currentTrackId !== undefined && lyrics.trackId !== currentTrackId && currentMediaType !== "video") return;

    lyricsMedia = lyrics;
    isLyricsProcessed = false;
    romanizedLyrics.clear();

    if (islyricsContainerLoaded) {
        safeTimeout(unloads, () => {
            void syncLyricsToDom(undefined, 0, syncMedia);
        }, 250);
    }
});

MediaItem.onMediaTransition(unloads, async (mediaItem) => {
    syncMedia++;
    clearSyncRetry();
    clearLyricsDomSync();
    isLyricsProcessed = false;
    lyricsMedia = undefined;
    lyricsState = lyricsStateEnum.original;
    currentTrackId = mediaItem.id;
    currentMediaType = mediaItem.contentType;
    romanizedLyrics.clear();
    await loadLyrics(mediaItem);
    if (islyricsContainerLoaded) {
        safeTimeout(unloads, () => {
            void syncLyricsToDom(mediaItem, 0, syncMedia);
        }, 250);
    }
});

unloads.add(() => {
    clearSyncRetry();
    disconnectLyricsDomObserver();
    const romanizeButton = document.getElementById('romanize-button');
    if (romanizeButton && romanizeButton.parentElement) {
        romanizeButton.parentElement.removeChild(romanizeButton);
    }

});

loadLyrics();
lyricsContainerObserver();

