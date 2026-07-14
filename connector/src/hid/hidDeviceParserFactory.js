import {PlantronicsHIDDeviceParser} from "./plantronicsHIDDeviceParser";
import {JabraHIDDeviceParser} from "./jabraHIDDeviceParser";

export function getHIDParser(device) {
    switch(device.productName) {
        case "Plantronics Blackwire 5220 Series":
            return new PlantronicsHIDDeviceParser();
        case "Jabra EVOLVE LINK MS":
            return new JabraHIDDeviceParser();
        // Add more device types here
        default:
            throw new Error("Unsupported HID device");
    }
}
