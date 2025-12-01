import { ReactiveStore } from "@luna/core";
import { LunaSettings, LunaSwitchSetting, LunaSelectSetting, LunaSelectItem } from "@luna/ui";
import React from "react";

export const settings = await ReactiveStore.getPluginStorage("LangRomanizer", {
    toggleRomanize: true,
    showDebug: false,
    japaneseRomajiStyle: "hepburn",
});

export const jpStyles = ["hepburn", "passport", "nippon"]

export const Settings = () => {
    const [toggleRomanize, setToggleRomanize] = React.useState<boolean>(settings.toggleRomanize);
    const [showDebug, setEnableDebug] = React.useState<boolean>(settings.showDebug);
    const [japaneseRomajiStyle, setJpRomajiStyle] = React.useState<string>(settings.japaneseRomajiStyle);

    return (
        <LunaSettings>
            <LunaSwitchSetting
                title="Toggle Romanization"
                desc="Enable or disable the romanization of lyrics as default state."
                // @ts-expect-error
                checked={toggleRomanize}
                // @ts-expect-error
                onChange={(_, checked: boolean) => {
                    setToggleRomanize((settings.toggleRomanize = checked));
                }}
            />
            <LunaSwitchSetting
                title="Show Debug"
                desc="Show plugin additional log information in the console. (CTRL + SHIFT + I)"
                // @ts-expect-error
                checked={showDebug}
                // @ts-expect-error
                onChange={(_, checked: boolean) => {
                    setEnableDebug((settings.showDebug = checked));
                }}
            />
            <LunaSelectSetting
                title="Set Japanese Romaji Style"
                desc="Choose between Romanization system hepburn (default), nippon, passport"
                value={japaneseRomajiStyle}
                onChange={(event: any) => {
                    const { value } = event.target;
                    setJpRomajiStyle((settings.japaneseRomajiStyle = value));
                }}>
                {jpStyles.map((style) => (
                    <LunaSelectItem key={style} value={style}>
                        {style.charAt(0).toUpperCase() + style.slice(1)}
                    </LunaSelectItem>
                ))}
            </LunaSelectSetting>
        </LunaSettings>
    );
}