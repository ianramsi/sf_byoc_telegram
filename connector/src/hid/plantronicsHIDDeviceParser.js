import {HIDParser} from "./hidDeviceParser";
import {Constants, publishEvent} from '@salesforce/scv-connector-base';

let buffer = [];
let muteToggleSignal = false;
let activeCall = null;
let callInfo = null;
export class PlantronicsHIDDeviceParser extends HIDParser {
    async parseInputReport(event, sdk) {
        const {data} = event;

        //An integer received from the Plantronics HID device
        const action = data.getUint8(0);
        const activeCalls = await sdk.getActiveCalls();

        if (activeCalls.activeCalls.length !== 0) {
            activeCall = activeCalls.activeCalls[0];
            callInfo = activeCall.callInfo;
            //set this to send signal to salesforce that the source of action is HID
            callInfo.isHIDCall = true;

            /**
             * Mute/unmute - Action signal toggles between 1,0 and 3,2
             * accept/hangup - Action signal toggles between 2 and 0
             * Since 1,0 contains 0 and 3,2 contains 2, it will collide with accept/hangup signal of 0 or 2.
             * Hence, maintaining buffer and muteToggleSignal to differentiate 0 or 2 coming from mute/unmute(1,0 or 3,2)
             * and not accept/hangup
             */
            if (action === 1 || action === 3) {
                //set buffer and muteToggleSignal to club it with the second signal 0 or 2 that will come
                muteToggleSignal = true;
                buffer = [action];
            } else if (action === 2 || action === 0) {
                //mute action for signal 1,0 or 3,2 emitted through the device, here buffer was set when 1 or 3 received
                if (muteToggleSignal && buffer.length === 1) {
                    await this.performAction("muteToggle", sdk);
                    //reset buffer and muteToggleSignal if mute/unmute signal
                    buffer = [];
                    muteToggleSignal = false;
                } else {
                    //answer or hangup call action for signal 2 or 0 emitted through the device
                    await this.performAction("acceptOrHangupCall", sdk);
                }
            }
        }
    }

    //process action based on the action number received from HID device
    async performAction(action, sdk) {
        switch (action) {
            case "muteToggle": //1,0 or 3,2
                if(callInfo.isMuted) {
                    const payload = await sdk.unmute(activeCall);
                    sdk.log("unmute call triggered using HID: ", activeCall);
                    publishEvent({eventType: Constants.VOICE_EVENT_TYPE.MUTE_TOGGLE, payload});
                } else {
                    const payload = await sdk.mute(activeCall);
                    sdk.log("mute call triggered using HID: ", activeCall);
                    publishEvent({eventType: Constants.VOICE_EVENT_TYPE.MUTE_TOGGLE, payload});
                }
                break;
            case "acceptOrHangupCall": //2 or 0
                if (activeCall.state === Constants.CALL_STATE.RINGING && activeCall.callType === "inbound") {
                    sdk.log("answer call triggered using HID: ", activeCall);
                    sdk.connectCall(callInfo);
                } else {
                    sdk.log("hangup call triggered using HID: ", activeCall);
                    sdk.hangup(Constants.HANGUP_REASON.PHONE_CALL_ENDED);
                }
        }
    }
}