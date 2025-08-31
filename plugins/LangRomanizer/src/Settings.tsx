import { ReactiveStore } from "@luna/core";
import { LunaSettings, LunaSwitchSetting, LunaNumberSetting } from "@luna/ui";
import React from "react";

export const settings = await ReactiveStore.getPluginStorage("LangRomanizer", {
    toggleRomanize: true,
});

export const Settings = () => {
    const [toggleRomanize, setToggleRomanize] = React.useState(settings.toggleRomanize);

    return (
        <LunaSettings>
            <LunaSwitchSetting
                title="Toggle Romanization"
                desc="Enable or disable the romanization of lyrics as default state."
                checked={toggleRomanize}
                onChange={(_, checked: boolean) => {
                    setToggleRomanize((settings.toggleRomanize = checked));
                }}
            />
        </LunaSettings>
    );
}