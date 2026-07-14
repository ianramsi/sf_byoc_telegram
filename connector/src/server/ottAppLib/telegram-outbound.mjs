/**
 * ============================================================================
 * TELEGRAM OUTBOUND MODULE
 * ============================================================================
 *
 * Sends outbound messages (agent replies) from Salesforce to Telegram users
 * via the Telegram Bot API.
 *
 * FLOW (Step 7b — outbound leg):
 * 1. Agent replies in Salesforce Service Console
 * 2. Salesforce publishes Telegram_Message_Event__e platform event
 * 3. Demo connector receives it via Pub/Sub API (subscribeToSfInteractionEvent)
 * 4. The StaticContentMessage handler calls sendTelegramMessage() here
 * 5. Telegram Bot API delivers the message to the user's chat
 *
 * The chat_id is captured on each inbound webhook message and cached in
 * settingsCache under "telegramChatId" (MVP: single active conversation).
 *
 * ============================================================================
 */

import axios from 'axios';
import { logger } from '../util.mjs';

const { TELEGRAM_BOT_TOKEN } = process.env;

const TELEGRAM_API_BASE = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

/**
 * Sends a text message to a Telegram chat via the Bot API.
 *
 * @param {string|number} chatId - Telegram chat ID (captured from the inbound webhook)
 * @param {string} text - Message text to deliver
 * @returns {Promise<Object>} - Telegram API response body, or error object { ok: false, error }
 */
export async function sendTelegramMessage(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) {
    logger.error('[TELEGRAM-OUT] TELEGRAM_BOT_TOKEN is not set — cannot send message');
    return { ok: false, error: 'TELEGRAM_BOT_TOKEN not configured' };
  }
  if (!chatId) {
    logger.error('[TELEGRAM-OUT] No chat_id available — cannot send message. An inbound message must arrive first to establish the chat.');
    return { ok: false, error: 'No chat_id available' };
  }
  if (!text) {
    logger.warn('[TELEGRAM-OUT] Empty message text — skipping send');
    return { ok: false, error: 'Empty message text' };
  }

  try {
    logger.info(`[TELEGRAM-OUT] Sending message to chat ${chatId}: "${text}"`);
    const response = await axios.post(`${TELEGRAM_API_BASE}/sendMessage`, {
      chat_id: chatId,
      text: text
    });
    logger.info(`[TELEGRAM-OUT] Message delivered, message_id: ${response.data?.result?.message_id}`);
    return response.data;
  } catch (error) {
    const errorData = error.response?.data || { message: error.message };
    logger.error('[TELEGRAM-OUT] Failed to send message to Telegram: ', errorData);
    return { ok: false, error: errorData };
  }
}
