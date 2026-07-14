/**
 * ============================================================================
 * TELEGRAM WEBHOOK MODULE
 * ============================================================================
 *
 * This module handles incoming webhook requests from the Telegram Bot API.
 * It acts as a bridge between Telegram and the Salesforce BYOC messaging system.
 *
 * FLOW:
 * 1. Telegram user sends message to bot (@Lori_V01_bot)
 * 2. Telegram Bot API sends webhook to /api/telegram/webhook endpoint
 * 3. This module parses the Telegram payload
 * 4. Transforms it to demo connector format
 * 5. Returns success/error response to Telegram
 *
 * The payload is then ready to be sent to Salesforce via:
 * - sendSFInboundMessageInteraction() API call
 * - Platform event publishing
 * - Message routing through BYOC Flow
 *
 * ============================================================================
 */

import { logger } from '../util.mjs';
import { v4 as uuidv4 } from 'uuid';
import { sendSFInboundMessageInteraction } from './sfdc-byoc-interaction-api.mjs';

// Load Telegram configuration from environment variables
const {
  TELEGRAM_BOT_TOKEN,              // Bot token for verifying requests and sending messages
  TELEGRAM_WEBHOOK_SECRET,         // Shared secret Telegram echoes back in X-Telegram-Bot-Api-Secret-Token
  CHANNEL_ADDRESS_IDENTIFIER,      // Salesforce channel ID (Telegram BYOC MessagingChannel)
  END_USER_CLIENT_IDENTIFIER       // Default identifier for test users
} = process.env;

/**
 * FUNCTION: validateTelegramWebhook
 *
 * PURPOSE:
 * - Validates that webhook requests actually come from Telegram (not spoofed)
 * - Telegram includes a signature header: X-Telegram-Bot-API-Secret-Header
 *
 * SECURITY:
 * - For production: Uncomment the crypto validation code
 * - For MVP (localhost): We skip validation since requests are local
 *
 * PARAMETERS:
 * @param {Object} req - Express request object containing headers and body
 *
 * RETURNS:
 * @returns {boolean} - true if valid, false if invalid
 *
 * EXAMPLE SIGNATURE VALIDATION (for production):
 * The X-Telegram-Bot-API-Secret-Header is SHA256(BOT_TOKEN + request_body)
 * We recreate this hash and compare to ensure authenticity.
 */
export function validateTelegramWebhook(req) {
  // Telegram sends back the secret_token registered via setWebhook in the
  // X-Telegram-Bot-Api-Secret-Token header on every webhook call. Anyone who
  // discovers the public webhook URL but doesn't know the secret is rejected.
  if (!TELEGRAM_WEBHOOK_SECRET) {
    // Fail open only if no secret is configured, but make it loud — this
    // means the webhook accepts unauthenticated requests.
    logger.warn('⚠️ TELEGRAM_WEBHOOK_SECRET not set — webhook is accepting UNAUTHENTICATED requests!');
    return true;
  }

  const received = req.headers['x-telegram-bot-api-secret-token'];
  if (received !== TELEGRAM_WEBHOOK_SECRET) {
    logger.warn('Telegram webhook rejected: missing or invalid X-Telegram-Bot-Api-Secret-Token header');
    return false;
  }

  return true;
}

/**
 * FUNCTION: parseTelegramMessage
 *
 * PURPOSE:
 * - Extracts relevant fields from raw Telegram webhook payload
 * - Validates required fields are present
 * - Converts Telegram message format to a standardized internal format
 *
 * TELEGRAM PAYLOAD STRUCTURE:
 * {
 *   "update_id": 123456789,
 *   "message": {
 *     "message_id": 1,
 *     "date": 1720687075,           // Unix timestamp
 *     "chat": { "id": 987654321 },
 *     "from": {
 *       "id": 987654321,
 *       "is_bot": false,
 *       "first_name": "John",
 *       "username": "johndoe"
 *     },
 *     "text": "Hello bot!"
 *   }
 * }
 *
 * PARAMETERS:
 * @param {Object} telegramMessage - Raw webhook payload from Telegram Bot API
 *
 * RETURNS:
 * @returns {Object|null} - Parsed message object, or null if invalid
 *
 * PARSED MESSAGE STRUCTURE:
 * {
 *   interactionType: 'EntryInteraction',      // Type for Salesforce API
 *   entryType: 'Message',                      // Subtype (vs TypingIndicator)
 *   messageText: "Hello bot!",                 // The actual message content
 *   externalMessageId: "telegram_987654321_1", // Unique ID for deduplication
 *   externalUserId: "987654321",               // Telegram user ID
 *   externalUsername: "johndoe",               // Telegram username
 *   telegramChatId: 987654321,                 // Telegram chat ID
 *   telegramMessageId: 1,                      // Telegram message ID
 *   timestamp: "2024-07-11T08:37:55.000Z"      // ISO 8601 timestamp
 * }
 */
export function parseTelegramMessage(telegramMessage) {
  try {
    // STEP 1: Validate webhook structure
    // Telegram always sends { update_id, message } structure
    if (!telegramMessage || !telegramMessage.message) {
      logger.warn('Invalid Telegram payload structure: missing "message" field');
      return null;
    }

    const message = telegramMessage.message;

    // STEP 2: Extract message fields
    // For MVP, we only handle text messages (not photos, files, etc.)
    if (!message.text) {
      logger.warn('Telegram message has no text content (might be photo, file, etc.)');
      return null;
    }

    // Extract user information
    // If username is not set, create a fallback identifier
    const telegramUserId = message.from.id.toString();
    const telegramUsername = message.from.username || `telegram_${telegramUserId}`;

    // Extract message metadata
    const messageText = message.text;
    const messageId = message.message_id;
    const chatId = message.chat.id;

    logger.info(
      `[TELEGRAM] Message from @${telegramUsername} (ID: ${telegramUserId}): "${messageText}"`
    );

    // STEP 3: Create internal message format
    // This format is used throughout the demo connector system
    const demoConnectorMessage = {
      // === INTERACTION TYPE (for Salesforce API) ===
      interactionType: 'EntryInteraction',    // Type of message interaction
      entryType: 'Message',                    // Subtype: Message, TypingIndicator, etc.

      // === SALESFORCE CHANNEL IDENTIFIERS ===
      channelAddressIdentifier: CHANNEL_ADDRESS_IDENTIFIER,      // Which channel (Telegram)
      endUserClientIdentifier: END_USER_CLIENT_IDENTIFIER,       // Which user/client

      // === MESSAGE CONTENT ===
      messageText: messageText,                // The actual text message

      // === UNIQUE IDENTIFIERS (for deduplication) ===
      // Format: telegram_<chatId>_<messageId>
      // Example: telegram_987654321_1
      // Used to prevent duplicate message processing if webhook is retried
      externalMessageId: `telegram_${chatId}_${messageId}`,
      externalUserId: telegramUserId,          // External system user ID
      externalUsername: telegramUsername,      // External system username

      // === TIMESTAMP ===
      // Convert Unix timestamp (seconds) to ISO 8601 string
      // Salesforce expects ISO 8601 format for all timestamps
      timestamp: new Date(message.date * 1000).toISOString(),

      // === TELEGRAM-SPECIFIC METADATA ===
      // Preserved for logging and troubleshooting
      telegramChatId: chatId,                  // Telegram chat ID (needed for replies)
      telegramMessageId: messageId,            // Telegram message ID
      telegramUserId: telegramUserId           // Telegram user ID
    };

    logger.info('[TELEGRAM] Message parsed successfully and transformed to internal format');
    logger.info(JSON.stringify(demoConnectorMessage, null, 2));

    return demoConnectorMessage;
  } catch (error) {
    logger.error('[TELEGRAM] Error parsing message:', error);
    return null;
  }
}

/**
 * FUNCTION: convertToSendMessageFormat
 *
 * PURPOSE:
 * - Converts the parsed internal message format to the format expected by
 *   the /api/sendmessage endpoint
 * - This is the format that gets passed to handleSendmessage() for
 *   Salesforce platform event publishing
 *
 * PARAMETERS:
 * @param {Object} parsedMessage - Output from parseTelegramMessage()
 *
 * RETURNS:
 * @returns {Object} - Request body ready for /api/sendmessage endpoint
 *
 * OUTPUT FORMAT:
 * {
 *   interactionType: 'EntryInteraction',
 *   entryType: 'Message',
 *   body: {
 *     messageText: "...",
 *     externalMessageId: "...",
 *     metadata: { ... }
 *   }
 * }
 *
 * NOTE: This format matches what the demo connector web UI sends when
 * an agent types a message. This ensures Telegram messages are handled
 * the same way as UI-originated messages.
 */
export function convertToSendMessageFormat(parsedMessage) {
  return {
    // === INTERACTION METADATA ===
    // These fields are required by the Salesforce BYOC APIs
    interactionType: parsedMessage.interactionType,   // 'EntryInteraction' for messages
    entryType: parsedMessage.entryType,               // 'Message' or 'TypingStartedIndicator'

    // === MESSAGE BODY ===
    // All message-specific data goes in the body
    body: {
      messageText: parsedMessage.messageText,

      // === DEDUPLICATION ID ===
      // Salesforce uses this to prevent processing the same message twice
      // If Telegram webhook is retried, same ID ensures idempotency
      externalMessageId: parsedMessage.externalMessageId,

      // === USER IDENTIFIERS ===
      // Helps Salesforce match the message to a conversation/customer
      externalUserId: parsedMessage.externalUserId,
      externalUsername: parsedMessage.externalUsername,

      // === CHANNEL CONFIGURATION ===
      // Links this message to the Telegram channel configuration
      channelAddressIdentifier: parsedMessage.channelAddressIdentifier,
      endUserClientIdentifier: parsedMessage.endUserClientIdentifier,

      // === TIMESTAMP ===
      timestamp: parsedMessage.timestamp,

      // === CUSTOM METADATA ===
      // Can be used by Salesforce Flow to route differently based on source
      metadata: {
        source: 'telegram',                          // Message came from Telegram
        telegramChatId: parsedMessage.telegramChatId,
        telegramMessageId: parsedMessage.telegramMessageId,
        telegramUserId: parsedMessage.telegramUserId
      }
    }
  };
}

/**
 * FUNCTION: handleTelegramWebhook
 *
 * PURPOSE:
 * - Main handler for incoming Telegram webhook requests
 * - Orchestrates the entire flow: validate → parse → convert → respond
 *
 * WEBHOOK FLOW:
 * 1. Telegram user sends message to @Lori_V01_bot
 * 2. Telegram Bot API calls: POST /api/telegram/webhook
 * 3. This function processes the request
 * 4. Returns 200 OK immediately (don't keep Telegram waiting)
 * 5. Background: send to Salesforce via platform event
 *
 * PARAMETERS:
 * @param {Object} req - Express request object
 *        - req.body = Telegram webhook payload
 *        - req.headers = Telegram signature headers
 * @param {Object} settingsCache - Node cache with app configuration
 *        (Currently unused, but available for future enhancements)
 *
 * RETURNS:
 * @returns {Object} Response object with structure:
 *        {
 *          success: boolean,
 *          data: { message, messageId, userId, payload },
 *          error?: string
 *        }
 *
 * HTTP RESPONSE:
 * - 200 OK: Message accepted and queued
 * - 400/500: Error processing message
 *
 * IMPORTANT NOTES:
 * - Always return immediately (Telegram times out after 30 seconds)
 * - Actual Salesforce API calls happen asynchronously
 * - Logging is critical for debugging Telegram webhook issues
 */
export async function handleTelegramWebhook(req, settingsCache) {
  // === LOG SEPARATOR ===
  // Makes logs easier to read when monitoring multiple messages
  logger.info('='.repeat(80));
  logger.info('📱 TELEGRAM WEBHOOK RECEIVED');
  logger.info('='.repeat(80));

  try {
    // STEP 1: VALIDATE WEBHOOK
    // Ensures the request comes from Telegram, not an attacker
    if (!validateTelegramWebhook(req)) {
      logger.error('❌ Telegram webhook signature validation FAILED');
      return { success: false, error: 'Invalid signature' };
    }

    // STEP 2: PARSE TELEGRAM MESSAGE
    // Extracts fields from raw Telegram payload
    const parsedMessage = parseTelegramMessage(req.body);
    if (!parsedMessage) {
      logger.error('❌ Failed to parse Telegram message (invalid structure)');
      return { success: false, error: 'Invalid message format' };
    }

    // STEP 3: CONVERT TO SENDMESSAGE FORMAT
    // Transforms to format expected by /api/sendmessage endpoint
    const sendMessagePayload = convertToSendMessageFormat(parsedMessage);
    logger.info('✅ Converted to /api/sendmessage format:');
    logger.info(JSON.stringify(sendMessagePayload, null, 2));

    // Cache the Telegram chat id so the outbound leg (agent reply → Telegram)
    // knows where to deliver replies. MVP: single active conversation.
    settingsCache.set("telegramChatId", parsedMessage.telegramChatId);

    // STEP 4: PUBLISH TO SALESFORCE
    // sendSFInboundMessageInteraction() reads a flat req.body.message string
    // (not the nested sendMessagePayload shape built above), plus req.file
    // for attachments (none here).
    const fakeReq = {
      body: {
        message: parsedMessage.messageText
      },
      file: undefined
    };

    const orgId = settingsCache.get("orgId");
    const authorizationContext = settingsCache.get("authorizationContext");
    const channelAddressIdentifier = settingsCache.get("channelAddressIdentifier");
    const endUserClientIdentifier = settingsCache.get("endUserClientIdentifier");

    logger.info('[TELEGRAM] Publishing to Salesforce via sendSFInboundMessageInteraction()...');
    const sfResponse = await sendSFInboundMessageInteraction(
      orgId,
      authorizationContext,
      channelAddressIdentifier,
      endUserClientIdentifier,
      fakeReq
    );
    logger.info('[TELEGRAM] Salesforce publish response:', sfResponse);

    // === LOG SEPARATOR ===
    logger.info('='.repeat(80));
    logger.info('✅ TELEGRAM MESSAGE PROCESSING COMPLETE');
    logger.info('Message published to Salesforce');
    logger.info('='.repeat(80));

    // STEP 5: RETURN SUCCESS RESPONSE
    return {
      success: true,
      data: {
        message: 'Telegram message received and published to Salesforce',
        messageId: parsedMessage.externalMessageId,
        userId: parsedMessage.externalUserId,
        payload: sendMessagePayload,
        sfResponse
      }
    };
  } catch (error) {
    // STEP 5: ERROR HANDLING
    // Log the error but still return 200 so Telegram doesn't retry infinitely
    logger.error('❌ Unexpected error handling Telegram webhook:', error);
    return { success: false, error: 'Failed to process Telegram webhook' };
  }
}
