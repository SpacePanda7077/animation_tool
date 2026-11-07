import { EventBus } from "../../game/EventBus";

export default function Tab() {
    const handle_add_rect = () => {
        EventBus.emit("add_rect");
    };
    const handle_add_bone = () => {
        EventBus.emit("add_bone");
    };

    return (
        <>
            <div className="absolute top-0 left-0 h-full ml-2 flex justify-center items-center ">
                <div className="bg-[#2e2c2c] w-full p-3 h-[99%] rounded-lg flex flex-col border-2 border-[#878080] gap-5">
                    <p onClick={handle_add_rect} className="cursor-pointer">
                        square
                    </p>
                    <p onClick={handle_add_bone} className="cursor-pointer">
                        bone
                    </p>
                </div>
            </div>
        </>
    );
}
