// V3.4 Publish smoke test for Telegram_Message_Event__e
// Run via: sf apex run -o devhub --file scripts/apex/verify_publish.apex
// Pass criterion: System.debug prints "V3.4_RESULT=PASS"

Telegram_Message_Event__e ev = new Telegram_Message_Event__e(
    EventType__c = 'VerificationPing',
    Payload__c   = '{"test":true,"source":"verify_publish.apex","ts":"' + DateTime.now().formatGmt('yyyy-MM-dd\'T\'HH:mm:ss.SSS\'Z\'') + '"}'
);
Database.SaveResult sr = EventBus.publish(ev);
System.debug('V3.4_RESULT=' + (sr.isSuccess() ? 'PASS' : 'FAIL'));
if (sr.isSuccess()) {
    System.debug('V3.4_PUBLISHED_ID=' + sr.getId());
} else {
    for (Database.Error e : sr.getErrors()) {
        System.debug('V3.4_ERROR=' + e.getStatusCode() + ' :: ' + e.getMessage());
        if (e.getFields() != null) {
            System.debug('V3.4_ERROR_FIELDS=' + e.getFields());
        }
    }
}
