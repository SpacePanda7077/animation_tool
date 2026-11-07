import { Game as MainGame } from "./scenes/Game";
import { AUTO, Game, Scale, Types } from "phaser";

// Find out more information about the Game Config at:
// https://docs.phaser.io/api-documentation/typedef/types-core#gameconfig
const config: Types.Core.GameConfig = {
    type: AUTO,
    scale: {
        mode: Scale.ENVELOP,
        autoCenter: Scale.CENTER_BOTH,
        width: 1280,
        height: 720,
    },

    parent: "game-container",
    backgroundColor: "#028af8",
    scene: [MainGame],
};

const StartGame = (parent: string) => {
    return new Game({ ...config, parent });
};

export default StartGame;
