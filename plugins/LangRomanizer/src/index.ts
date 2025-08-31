import { LunaUnload, Tracer } from "@luna/core";
import { redux } from "@luna/lib";
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
await kuroshiro.init(new KuromojiAnalyzer({ dictPath: 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/' }));


// Process Lyrics and insert them into the redux.Lyrics object
async function processLyrics(lyrics: redux.Lyrics) {
    if (!lyrics) return null;

    try {
        const splitLyrics = lyrics.lyrics.split('\n');
        const splitSubtitles = lyrics.subtitles.split('\n');
        let romanizedLyrics = { lyrics: 'lyricshidden\n', subtitles: '[00:00.00] lyricshidden\n' };

        for (let i = 0; i < Math.min(splitLyrics.length, splitSubtitles.length); i++) {
            const subtitleLine = splitSubtitles[i].trim();
            const timestampMatch = subtitleLine.match(/^\[[\d:.]+\]\s/);

            if (timestampMatch) {
                const timestamp = timestampMatch[0];
                const lineText = subtitleLine.substring(timestamp.length).trim();
                let lineProcessed = "";
                if (lineText.match(/\p{sc=Hiragana}|\p{sc=Katakana}/u)) {
                    lineProcessed = await kuroshiro.convert(lineText.replace(/\s/g, ""), { to: "romaji", mode: "spaced" });
                    trace.log(timestamp, ' - ', lineText, " - ", lineProcessed)
                }
                else if (lineText.match(/\p{sc=Hangul}/u)) {
                    lineProcessed = hangulToRoman(lineText);
                }
                else if (lineText.match(/\p{sc=Han}/u)) {
                    lineProcessed = pinyin(lineText, { style: pinyin.STYLE_NORMAL, heteronym: false }).flat().join(' ');   
                }
                // Append romanized line to lyrics and subtitles
                romanizedLyrics.lyrics += lineProcessed + '\n';
                romanizedLyrics.subtitles += timestamp + lineProcessed + '\n';
                //trace.log(lineProcessed)
            }
        }
        if (romanizedLyrics) {
            lyrics.lyrics += "\n" + romanizedLyrics.lyrics;
            lyrics.subtitles += "\n" + romanizedLyrics.subtitles;
            await redux.actions["content/LOAD_ITEM_LYRICS_FAIL"]({ itemId: lyrics.trackId });
            await redux.actions["content/LOAD_ITEM_LYRICS_SUCCESS"](lyrics);
            //trace.log(lyrics.lyrics);
            //trace.log(lyrics.subtitles);
        }
        /*
        const container = document.querySelector('[class^="_lyricsText"]')?.querySelector("div")?.querySelectorAll("span");
        if (container){
            trace.log(container[container.length - 1].innerHTML);
            container[container.length - 1].innerHTML = "test";
        }
        */
        trace.msg.log("Lyrics processed successfully.");
    } catch (error) {
        trace.msg.err("Error processing lyrics:", error);
        return null;
    }
};

const lyricsRomanization = async function (): Promise<void> {
    try {
        trace.msg.log("Lyrics found, processing...");
        //await processLyrics(originalLyrics);

    } catch (error) {
        trace.msg.err("Error during lyrics romanization:", error);
        return;
    }
};

// Creates a button to toggle romanization of lyrics and places it next to the fullscreen button
// thanks to meowarex literally copied from their plugin xd
const createRomanizeButton = () => {
    setTimeout(() => {
        // Check if the button already exists
        if (document.querySelector('#romanize-button')) return;

        // Search for the fullscreen button
        const fullscreenButton = document.querySelector('[data-test^="request-fullscreen"]');
        // Not found, retry after a delay
        if (!fullscreenButton || !fullscreenButton.parentElement) {
            setTimeout(() => createRomanizeButton(), 1250);
            return;
        }
        const fullcreenSpan = fullscreenButton.querySelector("span");
        if (!fullcreenSpan || !fullcreenSpan.parentElement) {
            setTimeout(() => createRomanizeButton(), 1250);
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
        if (spanClass){
            romanizeSpan.className = spanClass;
            romanizeSpan.setAttribute('data-save-color', 'textDefault');
        }

        romanizeButton.onclick = lyricsRomanization;

        // Insert after the fullscreen button
        romanizeButton.appendChild(romanizeSpan);
        buttonContainer.insertBefore(romanizeButton, fullscreenButton.nextSibling);

    }, 500);
};

redux.intercept("view/ENTERED_NOWPLAYING", unloads, () => {
    createRomanizeButton();
});

redux.intercept("content/LOAD_ITEM_LYRICS_SUCCESS", unloads, (payload) => {
    processLyrics(payload);
    if (settings.toggleRomanize) {
        lyricsRomanization();
    }
});

unloads.add(() => {
    const romanizeButton = document.getElementById('#romanize-button');
    if (romanizeButton && romanizeButton.parentElement) {
        romanizeButton.parentElement.removeChild(romanizeButton);
    }

});


