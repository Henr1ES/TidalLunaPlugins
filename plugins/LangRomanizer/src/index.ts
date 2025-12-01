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
let lyricsMedia: redux.Lyrics;
let romanizedLyrics: Map<string, string>;
let islyricsContainerLoaded = false;
let isNOWPLAYING = false;
let isLyricsProcessed = false;
let lyricsState = lyricsStateEnum.original;


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

// #region Tokenizer

/**
 * Spliting the characters by language
 * @param lyricsLine 
 * @returns { Promise<string> }
 */
/* # TODO check if its needed tokenizer for songs with JP + Kr or CN + kr
async function tokenizer(lyricsLine: string): Promise<string> {
    const chars = [...lyricsLine];
    let firstChar = chars.shift();
    if (!firstChar) return "";
    let prevType = checkScript(firstChar);

    const splitScript: Array<{ type: scriptsEnum, value: string }> = [{
        type: hasJapanese && prevType === scriptsEnum.Cn ? scriptsEnum.Jp : prevType,
        value: firstChar
    }]

    chars.forEach((char) => {
        let currentType = checkScript(char);
        if (hasJapanese && currentType == scriptsEnum.Cn) { currentType = scriptsEnum.Jp; }

        const sameType = currentType === prevType;
        prevType = currentType;
        let newValue = char;
        if (sameType && splitScript.length > 0) {
            // Merge with previous value
            const last = splitScript.pop();
            if (last) {
                newValue = last.value + newValue;
            }
        }
        splitScript.push({ type: currentType, value: newValue })
    });

    _traceDebug("hasJapanese", hasJapanese, "Tokenizer", splitScript.map(value => ({
        type: scriptsEnum[value.type],
        value: value.value
    })));

    const romanizedLine: string[] = [];
    for (const part of splitScript) {
        // Only romanize if the type is Cn, Ja, or Kr
        if ([scriptsEnum.Cn, scriptsEnum.Jp, scriptsEnum.Kr].includes(part.type)) {
            const romanized = await romanizer(part.value, part.type);
            romanizedLine.push(romanized);
        } else {
            romanizedLine.push(part.value);
        }
    }
    return romanizedLine.join(' ');
}
*/

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
                .map(([_, [original, romanized]]) => [original, romanized])
        );

        if (lyricsRomanized.size > 0) {
            _traceDebug("All lyrics romanized:", lyricsRomanized);
        }

        const newSubtitles = lyrics.subtitles.split("\n").map(sub => {
            const timeMatch = sub.match(/^\[[\d:.]+\]\s*/);
            if (timeMatch) {
                const time = timeMatch[0]
                const lineSub = lyricsRomanized.get(sub.substring(time.length).trim());
                if (lineSub) {
                    return sub + " #-# " + lineSub;
                }
            }
            return sub;
        }).join("\n");
        const newLyrics = splitLyrics.map(lyr => {
            const lineLyrics = lyricsRomanized.get(lyr)?.trim();
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
const applyRomanization = async function () {
    const lyricsSpans = document.querySelector('[class^="_lyricsText"]')
        ?.querySelector("div")
        ?.querySelectorAll("span[class]") as NodeListOf<HTMLSpanElement>;
    _traceDebug("Apply Romanization", lyricsSpans);

    lyricsSpans.forEach(span => {
        _traceDebug(span);
        const originalText = span.textContent?.trim();
        if (!originalText || !romanizedLyrics.has(originalText)) return;

        const romanizedText = romanizedLyrics.get(originalText)!;
        _traceDebug(romanizedText);

        if (settings.toggleRomanize) {
            // Show romanized, hide original
            const hiddenOriginal = document.createElement('span');
            hiddenOriginal.style.display = 'none';
            hiddenOriginal.textContent = originalText;

            span.innerHTML = '';  // Full reset
            span.appendChild(hiddenOriginal);
            span.appendChild(document.createTextNode(romanizedText));
            lyricsState = lyricsStateEnum.romanized
        } else {
            // Show original, hide romanized  
            const hiddenRomanized = document.createElement('span');
            hiddenRomanized.style.display = 'none';
            hiddenRomanized.textContent = romanizedText;

            span.innerHTML = originalText;  // Reset to original
            span.appendChild(hiddenRomanized);
            lyricsState = lyricsStateEnum.original
        }
    });

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

    if (romanizedLyrics.size === 0) {
        await processLyrics(lyricsMedia);
    }
    const lyricsSpans = document.querySelector('[class^="_lyricsText"]')
        ?.querySelector("div")
        ?.querySelectorAll("span[class]") as NodeListOf<HTMLSpanElement>;

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
        }
    });
}

// Creates a button to toggle romanization of lyrics and places it next to the fullscreen button
// thanks to meowarex literally copied from their plugin xd
const createRomanizeButton = () => {
    safeTimeout(unloads, () => {
        // Check if the button already exists
        if (document.querySelector('#romanize-button')) return;

        // Search for the fullscreen button
        const fullscreenButton = document.querySelector('[data-test^="request-fullscreen"]');
        // Not found, retry after a delay
        if (!fullscreenButton || !fullscreenButton.parentElement) {
            safeTimeout(unloads, () => createRomanizeButton(), 1250);
            return;
        }
        const fullcreenSpan = fullscreenButton.querySelector("span");
        if (!fullcreenSpan || !fullcreenSpan.parentElement) {
            safeTimeout(unloads, () => createRomanizeButton(), 1250);
            return;
        }
        const buttonContainer = fullscreenButton.parentElement;
        const spanClass = fullcreenSpan.className;

        // Create the button element
        const romanizeButton = document.createElement("button");
        const romanizeSpan = document.createElement("span");
        romanizeButton.id = 'romanize-button';
        romanizeButton.className = 'romanize-button' + " " + fullscreenButton.className;
        romanizeSpan.textContent = 'Romanize Lyrics';
        if (spanClass) {
            romanizeSpan.className = spanClass;
            romanizeSpan.setAttribute('data-save-color', 'textDefault');
        }

        romanizeButton.onclick = toggleLyricsRomanization;

        // Insert after the fullscreen button
        romanizeButton.appendChild(romanizeSpan);
        buttonContainer.insertBefore(romanizeButton, fullscreenButton.nextSibling);

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
    observe<HTMLElement>(unloads, '[class^="_lyricsText"]', (node) => {
        if (node) {
            _traceDebug("Lyrics Text container found!");
            _traceDebug({
                "isNOWPLAYING": isNOWPLAYING, "romanizedLyrics": romanizedLyrics.size,
                "toggleRomanize": settings.toggleRomanize, "lyricsState": lyricsState
            });
            islyricsContainerLoaded = true;
            safeTimeout(unloads, () => {
                if (isNOWPLAYING
                    && romanizedLyrics.size > 0
                    && settings.toggleRomanize
                    && lyricsState === lyricsStateEnum.original) {
                    applyRomanization();
                } else if (lyricsMedia && isNOWPLAYING && settings.toggleRomanize) {
                    _traceDebug("Lyrics container ready but no romanized data - processing now");
                    processLyrics(lyricsMedia).then(() => {
                        safeTimeout(unloads, () => applyRomanization(), 150);
                    });
                }
            }, 500);
        } else if (!node) {
            islyricsContainerLoaded = false;
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
async function loadLyrics(mediaItem?: MediaItem) {
    if (!mediaItem) {
        romanizedLyrics = new Map<string, string>();
        mediaItem = await MediaItem.fromPlaybackContext();
    }
    if (!mediaItem) return;

    const lyrics = await mediaItem.lyrics();
    if (!lyrics || !lyrics.subtitles) {
        return;
    }
    lyricsMedia = lyrics;
    _traceDebug("Lyrics Loaded", lyrics)
}

MediaItem.onMediaTransition(unloads, async (mediaItem) => {
    isLyricsProcessed = false;
    romanizedLyrics.clear();
    await loadLyrics(mediaItem);
    if (islyricsContainerLoaded) {
        safeTimeout(unloads, () => {
            if (isNOWPLAYING
                && romanizedLyrics.size > 0
                && settings.toggleRomanize
                && lyricsState === lyricsStateEnum.original) {
                applyRomanization();
            } else if (lyricsMedia && isNOWPLAYING && settings.toggleRomanize) {
                _traceDebug("Lyrics container ready but no romanized data - processing now");
                processLyrics(lyricsMedia).then(() => {
                    safeTimeout(unloads, () => applyRomanization(), 150);
                });
            }
        }, 250);
    }
});

unloads.add(() => {
    const romanizeButton = document.getElementById('#romanize-button');
    if (romanizeButton && romanizeButton.parentElement) {
        romanizeButton.parentElement.removeChild(romanizeButton);
    }

});

loadLyrics();
lyricsContainerObserver();

