import { ReactiveStore } from "@luna/core";
import { LunaSettings, LunaSwitchSetting, LunaNumberSetting } from "@luna/ui";
import React from "react";

export const settings = await ReactiveStore.getPluginStorage("LangRomanizer", {
    toggleRomanize: true,
    showDebug: true,
});

export const Settings = () => {
    const [toggleRomanize, setToggleRomanize] = React.useState(settings.toggleRomanize);
    const [showDebug, setEnableDebug] = React.useState(settings.showDebug);

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
        </LunaSettings>
    );
}