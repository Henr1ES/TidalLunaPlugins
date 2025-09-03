import { LunaUnload, Tracer } from "@luna/core";
import { redux, observe, safeTimeout, safeInterval } from "@luna/lib";
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
let kuroAnalyzerLoaded: Promise<void> | null = null;

function setUpKuroshiro() {
    if (!kuroAnalyzerLoaded) {
        kuroAnalyzerLoaded = (async () => {
            try {
                trace.msg.log("Please wait a couple seconds... Initializing Japanese morphological analyzer...");
                await kuroshiro.init(
                    new KuromojiAnalyzer({ dictPath: "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/" })
                );
                trace.msg.log("Japanese analyzer initialized correctly.");
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

// Plugin variables
let lyricsLoaded = false;

enum scriptsEnum {
    Latin,
    LatinCJK,
    CJK,
    Ch,
    Jp,
    Kr,
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

    if (settings.showDebug) {
        trace.debug("hasJapanese:", hasJapanese, "Tokenize: ", splitScript.map(value => ({
            type: scriptsEnum[value.type],
            value: value.value
        })));
    }
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
            return pinyin(text, { style: pinyin.STYLE_NORMAL, heteronym: false }).flat().join(' ');
    }
    return "";
}


/**
 * 
 * @param lyricsLine String object that has the lyrics text
 * @returns 
 */
async function processLine(lyricsLine: string): Promise<string> {
    if (lyricsLine != null) {
        switch (checkScript(lyricsLine)) {
            case scriptsEnum.LatinCJK:
            case scriptsEnum.CJK:
                return await tokenize(lyricsLine);
            case scriptsEnum.Ch:
                return await romanizer(lyricsLine, scriptsEnum.Ch);
            case scriptsEnum.Jp:
                return await romanizer(lyricsLine, scriptsEnum.Jp);
            case scriptsEnum.Kr:
                return await romanizer(lyricsLine, scriptsEnum.Jp);
            case scriptsEnum.Latin:
            default:
                return lyricsLine;
        }
    }
    return "";
}


/**
 * First this method checks if the lyrics does have any script to romanize, if not return null.
 * Next splits the lyrics and subtitle (this has the timestamp like this [MM:SS.miliseconds] LyricsText )
 * so for each line is gonna call the method {@link processLine}, this method is gonna return us
 * the romantized text.
 * When all the lyrics text is processed append both the original and romanticied lyrics into the 
 * {@link redux.Lyrics.lyrics} and {@link redux.Lyrics.subtitles}
 * 
 * @param  {redux.Lyrics} lyrics object provided from the redux intercept method
 * @returns {null} Null
 */
async function processLyrics(lyrics: redux.Lyrics) {
    if (!lyrics) return null;
    const lyricsScript = checkScript(lyrics.lyrics);
    if (![scriptsEnum.CJK, scriptsEnum.LatinCJK].includes(lyricsScript)) return null;
    if (settings.showDebug) {
        trace.debug("Lyrics found processing lyrics: ", lyrics);
    }
    try {
        trace.log("Starting processing lyrics with script: ", scriptsEnum[lyricsScript]);
        const splitLyrics = lyrics.lyrics.split('\n');
        const splitSubtitles = lyrics.subtitles.split('\n');
        let romanizedLyrics = { lyrics: '', subtitles: '' };
        let last_timestamp = ""
        for (let i = 0; i < Math.min(splitLyrics.length, splitSubtitles.length); i++) {
            const subtitleLine = splitSubtitles[i].trim();
            const timestampMatch = subtitleLine.match(/^\[[\d:.]+\]\s/);

            if (timestampMatch) {
                const timestamp = timestampMatch[0];
                const lineText = subtitleLine.substring(timestamp.length).replace(/\s/g, "");
                let lineProcessed = await processLine(lineText);
                trace.log(timestamp, ' - ', lineText, " - ", lineProcessed)
                // Append romanized line to lyrics and subtitles
                romanizedLyrics.lyrics += lineProcessed + '\n';
                romanizedLyrics.subtitles += timestamp + lineProcessed + '\n';
                last_timestamp = timestamp
            }
        }
        romanizedLyrics.lyrics += "lyricshidden\n";
        romanizedLyrics.subtitles += last_timestamp + "lyricshidden\n";
        if (romanizedLyrics) {
            lyrics.lyrics = romanizedLyrics.lyrics + "\n" + lyrics.lyrics;
            lyrics.subtitles = romanizedLyrics.subtitles + "\n" + lyrics.subtitles;
            await redux.actions["content/LOAD_ITEM_LYRICS_FAIL"]({ itemId: lyrics.trackId });
            await redux.actions["content/LOAD_ITEM_LYRICS_SUCCESS"](lyrics);
            //trace.log(lyrics.lyrics);
            //trace.log(lyrics.subtitles);
        }
        trace.log("Finished successfully processing lyrics.");
        if (settings.toggleRomanize) {
            await toggleLyricsRomanization();
        }
    } catch (error) {
        trace.msg.err("Error during lyrics romanization:", error);
        return null;
    }
};

// TODO BUG FIX:
// change the way on the lyrics is saved because now only the romanized lyrics has the data-current updating correctly
// and when toggling between both lyrics the original doesn't update
const toggleLyricsRomanization = async function (): Promise<void> {
    const lyricsSpans = document.querySelector('[class^="_lyricsText"]')?.querySelector("div")?.querySelectorAll("span");
    let lyricsHiddenSpanFound = false
    if (lyricsSpans) {
        trace.msg.log("Switching Lyrics Original / Romanization....")
        lyricsSpans.forEach(value => {
            switch (true) {
                // This will execute the first time after processing lyrics an all span nodes
                // If autoRomanize is True the lyrics romanticized before the lyricsHiddenSpan will be shown
                // and all after will be hidden
                case !value.hasAttribute("style"):
                    value.style.display = settings.toggleRomanize && !lyricsHiddenSpanFound ? "block" : "none";
                    // Check for the span with "lyricshidden" so it can know when the original lyrics starts
                    break;
                case value.hasAttribute("style"):
                    switch (value.style.display) {
                        case "block":
                            value.style.display = "none"
                            break;
                        case "none":
                            value.style.display = "block"
                            break;
                    }
                    break;
            }
            if (value.innerText == "lyricshidden") {
                lyricsHiddenSpanFound = true;
                value.style.display = "none";
            }
        })
    }

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
    observe<HTMLElement>(unloads, '[class^="_lyricsText"]', () => {
        if (!lyricsLoaded && settings.toggleRomanize) {
            lyricsLoaded = true;
            toggleLyricsRomanization();
        }
    });
}

// Entered the view where's the queue, suggested tracks, lyrics, credits.
redux.intercept("view/ENTERED_NOWPLAYING", unloads, () => {
    lyricsContainerObserver();
    createRomanizeButton();
});

redux.intercept("content/LOAD_ITEM_LYRICS_SUCCESS", unloads, async (payload) => {
    try {
        // Await again because I think in slow CPU sometimes it doesn't load if the user opens the NOWPLAYING view
        // when the analyzer didn't init the lyrics is empty / didn't process.
        await setUpKuroshiro();
        processLyrics(payload);
    } catch (err) {
        trace.msg.err("Couldn't load the Kuroshiro Analyzer. Try restarting Tidal Client.");
    }
});

redux.intercept("content/LOAD_ITEM_LYRICS", unloads, (payload) => {
    //trace.log(payload);
});

unloads.add(() => {
    const romanizeButton = document.getElementById('#romanize-button');
    if (romanizeButton && romanizeButton.parentElement) {
        romanizeButton.parentElement.removeChild(romanizeButton);
    }

});

setUpKuroshiro();