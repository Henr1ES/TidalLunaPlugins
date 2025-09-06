import { LunaUnload, Tracer } from "@luna/core";
import { redux, observe, safeTimeout, MediaItem } from "@luna/lib";
import { settings, Settings } from "./Settings";
// Module for Romantization
import { convert as hangulToRoman } from "hangul-romanization";
import { pinyin } from "pinyin";
import Kuroshiro from "kuroshiro";
import KuromojiAnalyzer from "kuroshiro-analyzer-kuromoji";

export const { trace } = Tracer("[LangRomanizer]");
export { Settings };

// clean up resources
export const unloads = new Set<LunaUnload>();

// Init Japanese morphological analyzer
const kuroshiro = new Kuroshiro();
let kuroAnalyzerLoaded: Promise<boolean> | null = null;

function setUpKuroshiro() {
    if (!kuroAnalyzerLoaded) {
        kuroAnalyzerLoaded = (async () => {
            try {
                trace.msg.log("Please wait... initializing Japanese morphological analyzer...");
                await kuroshiro.init(
                    new KuromojiAnalyzer({ dictPath: "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/" })
                );
                trace.msg.log("Japanese analyzer initialized correctly.");
                return true;
            } catch (err) {
                trace.msg.err("Failed to initialize analyzer.");
                // reset so you can retry later
                kuroAnalyzerLoaded = null;
                throw err;
            }
        })();
    }
    return kuroAnalyzerLoaded;
}


// Regex 
const regexJp = (/\p{sc=Hiragana}|\p{sc=Katakana}/u);
const regexCh = (/\p{sc=Han}/u);
const regexKr = (/\p{sc=Hangul}/u);
const regexLat = (/\p{sc=Latin}/u);


enum lyricsStateEnum {
    original, romanized
}

enum scriptsEnum {
    Latin,
    LatinCJK,
    CJK,
    Ch,
    Jp,
    Kr,
}

// Plugin variables
let islyricsProcessed = false;
let islyricsContainerLoaded = false;
let isNOWPLAYING = false;
let lyricsState = lyricsStateEnum.original;

/**
 * 
 * @param msg Message for the trace debug
*/
function _traceDebug(...msg: any[]): void {
    if (settings.showDebug) {
        trace.debug(msg);
    }
}


/**
 * 
 * @param text Text to check in what script is
 * @returns { scriptsEnum } scriptsEnum{ Latin, LatinCJK, CJK, Ch, Jp, Kr }
 */
function checkScript(text: string): scriptsEnum {
    const hasJp = regexJp.test(text);
    const hasCh = regexCh.test(text);
    const hasKr = regexKr.test(text);
    const hasLat = regexLat.test(text);

    switch (true) {
        case !hasLat && hasCh && !hasJp && !hasKr:
            return scriptsEnum.Ch;
        case !hasLat && hasJp && !hasKr:
            return scriptsEnum.Jp;
        case !hasLat && hasKr && !hasJp && !hasCh:
            return scriptsEnum.Kr;
        case hasLat && !hasCh && !hasJp && !hasKr:
            return scriptsEnum.Latin;
        case !hasLat && hasCh && hasKr && hasJp:
            return scriptsEnum.CJK;
        case hasLat && (hasCh || hasJp || hasKr):
            return scriptsEnum.LatinCJK;
        case !hasJp && !hasCh && !hasKr:
        default:
            return scriptsEnum.Latin
    }
}

/**
 * Spliting the characters by language
 * @param lyricsLine 
 * @returns { Promise<string> }
 */
async function tokenize(lyricsLine: string): Promise<string> {
    const chars = [...lyricsLine];
    let firstChar = chars.shift();
    if (!firstChar) return "";
    let prevType = checkScript(firstChar);
    let hasJapanese = regexJp.test(lyricsLine);

    const splitScript: Array<{ type: scriptsEnum, value: string }> = [{
        type: hasJapanese && prevType === scriptsEnum.Ch ? scriptsEnum.Jp : prevType,
        value: firstChar
    }]

    chars.forEach((char) => {
        let currentType = checkScript(char);
        if (hasJapanese && currentType == scriptsEnum.Ch) { currentType = scriptsEnum.Jp; }

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

    _traceDebug("hasJapanese", hasJapanese, "Tokenize", splitScript.map(value => ({
        type: scriptsEnum[value.type],
        value: value.value
    })));

    const romanizedLine: string[] = [];
    for (const part of splitScript) {
        // Only romanize if the type is Ch, Ja, or Kr
        if ([scriptsEnum.Ch, scriptsEnum.Jp, scriptsEnum.Kr].includes(part.type)) {
            const romanized = await romanizer(part.value, part.type);
            romanizedLine.push(romanized);
        } else {
            romanizedLine.push(part.value);
        }
    }
    return romanizedLine.join(' ');
}


/**
 * 
 * @param text Text to romanize
 * @param script What script is gonna romanize, value from the scriptsEnum
 * @returns Text romanized
 */
async function romanizer(text: string, script: scriptsEnum): Promise<string> {
    switch (script) {
        case scriptsEnum.Jp:
            return await kuroshiro.convert(text.replace(/\s/g, ""), { to: "romaji", mode: "spaced" });
        case scriptsEnum.Kr:
            return hangulToRoman(text);
        case scriptsEnum.Ch:
            return pinyin(text, { style: pinyin.STYLE_TONE, heteronym: false }).flat().join(' ');
    }
    return "";
}


/**
 * First this method checks if the lyrics does have any script to romanize, if not return null.
 * Next splits the lyrics and subtitle (this has the timestamp like this [MM:SS.miliseconds] LyricsText )
 * so for each line is gonna check the script of the text to call {@link romanizer } method to 
 * the romantized text to the specify script.
 * When all the lyrics text is processed append both the original and romanticied lyrics into the 
 * {@link redux.Lyrics.lyrics} and {@link redux.Lyrics.subtitles}
 * 
 * @param  {redux.Lyrics} lyrics object provided from the redux intercept method
 * @returns {null} Null
 */
async function processLyrics(lyrics: redux.Lyrics) {
    if (!lyrics) return null;

    const lyricsScript = checkScript(lyrics.lyrics);
    if (scriptsEnum.Latin === lyricsScript) {
        _traceDebug("Lyrics script using Latin without CJK, no need to Romantize.");
        return;
    }

    if (!kuroAnalyzerLoaded) {
        _traceDebug("Kuroshiro analyzer still not loaded, trying to reload...")
        // Await again because in slow CPU sometimes it doesn't load if the user opens the NOWPLAYING view
        // when the analyzer didn't init the lyrics is empty / didn't process.
        await setUpKuroshiro();
    }

    try {
        _traceDebug("Lyrics found: ", { ...lyrics });
        trace.log("Starting processing lyrics with script: ", scriptsEnum[lyricsScript]);
        const splitLyrics = lyrics.lyrics.split("\n");
        const lyricsMap = new Map<string, string>();

        for (let i = 0; i < splitLyrics.length; i++) {
            const line = splitLyrics[i].trim();
            const lineScript = checkScript(line);
            if (lineScript === scriptsEnum.Latin) { continue; }

            let lineProcessed;
            switch (lineScript) {
                case scriptsEnum.Ch:
                    lineProcessed = await romanizer(line, scriptsEnum.Ch);
                case scriptsEnum.Jp:
                    lineProcessed = await romanizer(line, scriptsEnum.Jp);
                case scriptsEnum.Kr:
                    lineProcessed = await romanizer(line, scriptsEnum.Kr);
                case scriptsEnum.LatinCJK:
                case scriptsEnum.CJK:
                default:
                    lineProcessed = await tokenize(line);
            }
            lineProcessed = lineProcessed
                // Remove multiple whitespace and leave only one
                .replace(/\s+/g, " ")
                // Remove space before ','
                .replace(/\s+([,!.?;:()])/g, "$1")
                // Ensure one whitespace after punctuation mark
                .replace(/([,!.?;:)])(?=\S)/g, "$1 ")
                .trim();
            trace.log(line, " - ", lineProcessed);
            lyricsMap.set(line, lineProcessed);
            splitLyrics[i] += " #-# " + lineProcessed;
        }

        const subtitles = lyrics.subtitles.split("\n").map(sub => {
            const timeMatch = sub.match(/^\[[\d:.]+\]\s*/);
            if (timeMatch) {
                const time = timeMatch[0];
                const lineSub = lyricsMap.get(sub.substring(time.length).trim());
                if (lineSub) {
                    return sub + " #-# " + lineSub;
                }
            }
            return sub;
        }).join("\n");
        _traceDebug("Lyrics processed", [subtitles, splitLyrics.join("\n")]);

        lyrics.lyrics = splitLyrics.join("\n");
        lyrics.subtitles = subtitles;
        await redux.actions["content/LOAD_ITEM_LYRICS_FAIL"]({ itemId: lyrics.trackId });
        await redux.actions["content/LOAD_ITEM_LYRICS_SUCCESS"](lyrics);
        trace.log("Finished successfully processing lyrics.");

        islyricsProcessed = true;
        if (settings.toggleRomanize && islyricsContainerLoaded) {
            await toggleLyricsRomanization();
        }
    } catch (error) {
        islyricsProcessed = false;
        trace.msg.err("Error during lyrics romanization:", error);
        return null;
    }
};

const toggleLyricsRomanization = async function (): Promise<void> {
    if (!islyricsProcessed) {
        trace.msg.log("Lyrics doesn't contain any script to romanize.");
        return;
    }
    const lyricsSpans = document.querySelector('[class^="_lyricsText"]')
        ?.querySelector("div")
        ?.querySelectorAll("span[class]") as NodeListOf<HTMLSpanElement>;
    if (!lyricsSpans) {
        trace.msg.err("Lyrics not found, please select the lyrics menu.")
        return;
    }

    trace.msg.log("Switching Lyrics Original / Romanization....")
    lyricsSpans.forEach(value => {
        const hiddenSpan = value?.querySelector("span");
        const spanText = value.innerText.split(" #-# ");
        _traceDebug(value.innerHTML)
        if (hiddenSpan) {
            _traceDebug("Hidden Span", hiddenSpan);
            const textNode = Array.from(value.childNodes)
                .find(node => node.nodeType === Node.TEXT_NODE) as Text | undefined;
            if (textNode) {
                const temp = hiddenSpan.textContent;
                hiddenSpan.textContent = textNode.textContent?.trim() || "";
                textNode.textContent = temp || "";
            }
        } else if (spanText.length == 2) {
            _traceDebug("Lyrics Span", spanText);
            const childspan = document.createElement("span");

            if (settings.toggleRomanize) {
                childspan.style.display = "none";
                childspan.innerText = spanText[0];
                value.innerText = spanText[1];
                lyricsState = lyricsStateEnum.romanized;
            } else {
                childspan.style.display = "none";
                childspan.innerText = spanText[1];
                value.innerText = spanText[0];
                lyricsState = lyricsStateEnum.original;
            }
            value.appendChild(childspan);
        }
    })
};

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

/**
 * This observer checks for the CSS class that starts with "_lyricsText"
 * @returns { void } void
 */
function lyricsContainerObserver(): void {
    const lyricsText = document.querySelector('[class^="_lyricsText"]');
    if (lyricsText) return;
    observe<HTMLElement>(unloads, '[class^="_lyricsText"]', (node) => {
        if (node) {
            _traceDebug("Lyrics Text container found!");
            islyricsContainerLoaded = true;
            safeTimeout(unloads, () => {
                if (isNOWPLAYING 
                    && islyricsContainerLoaded 
                    && islyricsProcessed 
                    && settings.toggleRomanize 
                    && lyricsState === lyricsStateEnum.original) {
                    toggleLyricsRomanization();
                }
            }, 500);
        } else if (!node) {
            islyricsContainerLoaded = false;
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

redux.intercept("content/LOAD_ITEM_LYRICS_SUCCESS", unloads, (payload) => {
    islyricsProcessed = false;
    _traceDebug("Redux lyrics success intercepted");
    processLyrics(payload);
});

unloads.add(() => {
    const romanizeButton = document.getElementById('#romanize-button');
    if (romanizeButton && romanizeButton.parentElement) {
        romanizeButton.parentElement.removeChild(romanizeButton);
    }

});

lyricsContainerObserver();
setUpKuroshiro();