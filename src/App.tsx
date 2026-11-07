import { useRef } from "react";
import { IRefPhaserGame, PhaserGame } from "./PhaserGame";
import "./App.css";
import Tab from "./components/tab/Tab";
import Inspector from "./components/tab/Inspector";

function App() {
    //  References to the PhaserGame component (game and scene are exposed)
    const phaserRef = useRef<IRefPhaserGame | null>(null);
    return (
        <div id="app">
            <PhaserGame ref={phaserRef} />
            <div>
                <Tab />
                <Inspector />
            </div>
        </div>
    );
}

export default App;
