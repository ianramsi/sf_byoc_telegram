import {HIDParser} from "./hidDeviceParser";
import {Constants, publishEvent} from '@salesforce/scv-connector-base';

let acceptHangupCalbuffer = [1, 0, 1, 0];
let buffer = [];
let activeCall = null;
let callInfo = null;
export class JabraHIDDeviceParser extends HIDParser {
    async parseInputReport(event, sdk) {
        const {data} = event;

        //An integer received from the Jabra HID device
        const action = data.getUint8(0);
        const activeCalls = await sdk.getActiveCalls();

        if (activeCalls.activeCalls.length !== 0) {
            activeCall = activeCalls.activeCalls[0];
            callInfo = activeCall.callInfo;
            //set this to send signal to salesforce that the source of action is HID
            callInfo.isHIDCall = true;
            buffer.push(action);
            if (this.compareAcceptHangupCalbuffer(buffer)) {
                buffer = [];
                await this.performAction("acceptOrHangupCall", sdk);
            }
        }
    }

    //process action based on the action number received from HID device
    async performAction(action, sdk) {
        switch (action) {
            case "acceptOrHangupCall": //1,0,1,0
                if (activeCall.state === Constants.CALL_STATE.RINGING && activeCall.callType === "inbound") {
                    sdk.log("answer call triggered using HID: ", activeCall);
                    sdk.connectCall(callInfo);
                } else {
                    sdk.log("hangup call triggered using HID: ", activeCall);
                    sdk.hangup(Constants.HANGUP_REASON.PHONE_CALL_ENDED);
                }
                break;
        }
    }

    //Check if valid input signal [1,0,1,0] received from Jabra HID device
    compareAcceptHangupCalbuffer(buffer) {
        if (buffer.length === 4) {
            return buffer.every((val, index) => val === acceptHangupCalbuffer[index]);
        }
        return false;
    }
}