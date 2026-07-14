/*
 * Copyright (c) 2021, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

/**
 * Constants for the messaging system 
 * This is a list of messagingconstants used in server layer
 * Keep in sync with the src/common/messagingConstants.js used in client layer
 * @module messagingConstants
 */

const EVENT_TYPE ={
  INTERACTION: 'Interaction',
  ROUTING_REQUESTED: 'RoutingRequested'
};

const EVENT_PAYLOAD_ENTRY_TYPE = {
  MESSAGE: 'Message',
  PROGRESS_INDICATOR: 'ProgressIndicator',
  TYPING_STARTED_INDICATOR: 'TypingStartedIndicator',
  TYPING_STOPPED_INDICATOR: 'TypingStoppedIndicator',
  MESSAGE_DELIVERY_FAILED: 'MessageDeliveryFailed',
  DELIVERY_ACKNOWLEDGEMENT: 'DeliveryAcknowledgement',
  READ_ACKNOWLEDGEMENT: 'ReadAcknowledgement',
  ROUTING_WORK_RESULT: 'RoutingWorkResult',
  PARTICIPANT_CHANGED: 'ParticipantChanged',
  ROUTING_RESULT: 'RoutingResult',
  ROUTING_REQUESTED: 'RoutingRequested'
};

const EVENT_PAYLOAD_MESSAGE_TYPE = {
  CHOICES_MESSAGE: 'ChoicesMessage',
  FORM_MESSAGE: 'FormMessage',
  STATIC_CONTENT_MESSAGE: 'StaticContentMessage'
};

export default {
  EVENT_TYPE,
  EVENT_PAYLOAD_ENTRY_TYPE,
  EVENT_PAYLOAD_MESSAGE_TYPE
};