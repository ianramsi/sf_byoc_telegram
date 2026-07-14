import { workflow, node, trigger, sticky, ifElse, switchCase, expr } from '@n8n/workflow-sdk';

// ============================================================================
// Session end handling:
// - Manual: user types /done or /menu in an active chat -> reset to 'new'.
// - Automatic: connector detects MessagingSession.Status = 'Ended' via CDC
//   (MessagingSessionChangeEvent) and POSTs { chatId } here so the state row
//   resets even if the agent ends the chat instead of the user.
// Both paths share the reset secret already used for connector auth
// (CONNECTOR_SECRET), just in the opposite direction.
// ============================================================================

// ============================================================================
// Salesforce access:
// - Case lookup: direct REST (JWT bearer via native JWT node + token fetch).
// - Escalation / escalated messages: delegated to the Docker connector's
//   /api/escalate endpoint on the VPS. n8n's HTTP node CANNOT send multipart
//   form-data with a custom boundary (it rewrites the boundary, so the header
//   and body never match and Salesforce returns a bare 400) — the connector
//   already sends the Interaction Service call correctly via FormData, and
//   routing through it also repopulates its telegramChatId cache so agent
//   replies flow back to Telegram.
// ============================================================================
// ⚠️ Replace all placeholders below with your own values before deploying.
//    Better: move CONNECTOR_SECRET into an n8n httpHeaderAuth credential
//    instead of a literal in the workflow (see README tech-debt list).
const SF_CONSUMER_KEY = '<YOUR_CONNECTED_APP_CONSUMER_KEY>';
const SF_SUBJECT = '<integration-user@yourcompany.com.sandboxname>';
const SF_AUDIENCE = 'https://test.salesforce.com'; // https://login.salesforce.com for prod
const SF_AUTH_ENDPOINT = 'https://test.salesforce.com/services/oauth2/token';
const CONNECTOR_ESCALATE_URL = 'https://<your-connector-domain>/api/escalate';
const CONNECTOR_SECRET = '<RANDOM_64_HEX_SHARED_SECRET>'; // must match N8N_CONNECTOR_SECRET in connector .env

// ============================================================================
// TRIGGER
// ============================================================================
const telegramTrigger = trigger({
  type: 'n8n-nodes-base.telegramTrigger',
  version: 1.2,
  config: {
    name: 'Telegram Trigger',
    parameters: { updates: ['message', 'callback_query'] },
    credentials: { telegramApi: { __credentialName: 'Lori_V01_bot' } },
    position: [0, 300]
  },
  output: [{
    message: {
      message_id: 5010,
      chat: { id: 123456789 },
      from: { id: 123456789, username: 'exampleuser', first_name: 'Example' },
      text: 'hello',
      date: 1720687075
    },
    callback_query: {
      id: 'cbq_1',
      data: 'talk_to_agent',
      message: { message_id: 5011, chat: { id: 123456789 } }
    }
  }]
});

// ============================================================================
// ROUTE: message vs callback_query
// ============================================================================
const routeUpdateType = switchCase({
  version: 3.4,
  config: {
    name: 'Route Update Type',
    parameters: {
      mode: 'rules',
      rules: {
        values: [
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
              combinator: 'and',
              conditions: [{
                leftValue: expr('{{ $json.callback_query?.id }}'),
                rightValue: '',
                operator: { type: 'string', operation: 'notEquals' }
              }]
            },
            renameOutput: true,
            outputKey: 'Callback'
          },
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
              combinator: 'and',
              conditions: [{
                leftValue: expr('{{ $json.message?.message_id }}'),
                rightValue: '',
                operator: { type: 'string', operation: 'notEquals' }
              }]
            },
            renameOutput: true,
            outputKey: 'Message'
          }
        ]
      },
      looseTypeValidation: true,
      options: { fallbackOutput: 'none', looseTypeValidation: true }
    },
    position: [220, 300]
  }
});

// ============================================================================
// MESSAGE BRANCH: manual session-end command (/done or /menu)
// Checked before state lookup so it works regardless of current state
// (escalated, awaiting_ticket, or new).
// ============================================================================
const resetCommandCheck = ifElse({
  version: 2.3,
  config: {
    name: 'Is Reset Command?',
    parameters: {
      conditions: {
        options: { caseSensitive: false, leftValue: '', typeValidation: 'loose' },
        combinator: 'or',
        conditions: [
          {
            leftValue: expr('{{ $json.message.text.trim() }}'),
            rightValue: '/done',
            operator: { type: 'string', operation: 'equals' }
          },
          {
            leftValue: expr('{{ $json.message.text.trim() }}'),
            rightValue: '/menu',
            operator: { type: 'string', operation: 'equals' }
          }
        ]
      }
    },
    position: [440, 300]
  }
});

const resetStateManual = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Reset State (Manual)',
    parameters: {
      resource: 'row',
      operation: 'upsert',
      dataTableId: { __rl: true, mode: 'name', value: 'byoc_telegram_chat_state' },
      matchType: 'anyCondition',
      filters: {
        conditions: [{
          keyName: 'chat_id',
          condition: 'eq',
          keyValue: expr('{{ $("Telegram Trigger").item.json.message.chat.id }}')
        }]
      },
      columns: {
        mappingMode: 'defineBelow',
        value: { chat_id: expr('{{ $("Telegram Trigger").item.json.message.chat.id }}'), state: 'new' },
        matchingColumns: [],
        schema: []
      }
    },
    position: [660, 250]
  }
});

// ============================================================================
// MESSAGE BRANCH: look up chat state
// ============================================================================
const getChatState = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Get Chat State',
    parameters: {
      resource: 'row',
      operation: 'get',
      dataTableId: { __rl: true, mode: 'name', value: 'byoc_telegram_chat_state' },
      filters: {
        conditions: [{
          keyName: 'chat_id',
          condition: 'eq',
          keyValue: expr('{{ $json.message.chat.id }}')
        }]
      },
      returnAll: false,
      limit: 1
    },
    // A brand-new chat_id has no matching row, so this node would otherwise
    // output 0 items and silently halt the rest of the branch.
    alwaysOutputData: true,
    position: [440, 150]
  },
  output: [{ chat_id: 123456789, state: 'new', updatedAt: '2026-07-12T00:00:00.000Z' }]
});

const normalizeChatState = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Chat State',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "return [{ json: { state: ($input.all()[0] && $input.all()[0].json.state) || 'new' } }];"
    },
    position: [550, 150]
  },
  output: [{ state: 'new' }]
});

const chatStateCheck = ifElse({
  version: 2.3,
  config: {
    name: 'Is Escalated?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        combinator: 'and',
        conditions: [{
          leftValue: expr('{{ $json.state }}'),
          rightValue: 'escalated',
          operator: { type: 'string', operation: 'equals' }
        }]
      }
    },
    position: [660, 150]
  }
});

const awaitingTicketCheck = ifElse({
  version: 2.3,
  config: {
    name: 'Awaiting Ticket Number?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        combinator: 'and',
        conditions: [{
          leftValue: expr('{{ $json.state }}'),
          rightValue: 'awaiting_ticket',
          operator: { type: 'string', operation: 'equals' }
        }]
      }
    },
    position: [880, 50]
  }
});

// ============================================================================
// SEND MAIN MENU (fresh / unrecognized message)
// ============================================================================
const sendMenu = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Send Menu',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $("Telegram Trigger").item.json.message.chat.id }}'),
      text: 'How can we help you today?',
      replyMarkup: 'inlineKeyboard',
      inlineKeyboard: {
        rows: [
          { row: { buttons: [{ text: 'Check ticket status', additionalFields: { callback_data: 'check_ticket' } }] } },
          { row: { buttons: [{ text: 'Talk to an agent', additionalFields: { callback_data: 'talk_to_agent' } }] } }
        ]
      }
    },
    credentials: { telegramApi: { __credentialName: 'Lori_V01_bot' } },
    position: [1100, 300]
  },
  output: [{ ok: true, result: { message_id: 1 } }]
});

// ============================================================================
// TICKET NUMBER PROVIDED (state == awaiting_ticket, user typed a number)
// ============================================================================
const signJwtForLookup = node({
  type: 'n8n-nodes-base.jwt',
  version: 1,
  config: {
    name: 'Sign JWT (Lookup)',
    parameters: {
      operation: 'sign',
      useJson: true,
      claimsJson: expr('{{ { iss: "' + SF_CONSUMER_KEY + '", sub: "' + SF_SUBJECT + '", aud: "' + SF_AUDIENCE + '", exp: Math.floor(Date.now() / 1000) + 180 } }}'),
      options: { algorithm: 'RS256' }
    },
    credentials: { jwtAuth: { __credentialName: 'SF_JWT_Signing' } },
    position: [1020, 0]
  },
  output: [{ token: 'signed.jwt.token' }]
});

const getSalesforceTokenForLookup = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Get Salesforce Token (Lookup)',
    parameters: {
      method: 'POST',
      url: SF_AUTH_ENDPOINT,
      sendBody: true,
      contentType: 'form-urlencoded',
      specifyBody: 'keypair',
      bodyParameters: {
        parameters: [
          { name: 'grant_type', value: 'urn:ietf:params:oauth:grant-type:jwt-bearer' },
          { name: 'assertion', value: expr('{{ $json.token }}') }
        ]
      }
    },
    position: [1100, 0]
  },
  output: [{ access_token: 'token', instance_url: 'https://example.salesforce.com' }]
});

const lookupCase = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Query Case',
    parameters: {
      method: 'GET',
      url: expr('{{ $json.instance_url }}/services/data/v63.0/query'),
      sendQuery: true,
      specifyQuery: 'keypair',
      queryParameters: {
        parameters: [{
          name: 'q',
          value: expr("{{ 'SELECT Id, CaseNumber, Status, Subject FROM Case WHERE CaseNumber = \\'' + $('Telegram Trigger').item.json.message.text.trim() + '\\'' }}")
        }]
      },
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [{ name: 'Authorization', value: expr('{{ "Bearer " + $json.access_token }}') }]
      }
    },
    position: [1320, 0]
  },
  output: [{ totalSize: 1, records: [{ CaseNumber: '00001741', Status: 'New', Subject: 'Sample issue' }] }]
});

const caseFoundCheck = ifElse({
  version: 2.3,
  config: {
    name: 'Case Found?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        combinator: 'and',
        conditions: [{
          leftValue: expr('{{ $json.totalSize }}'),
          rightValue: 0,
          operator: { type: 'number', operation: 'gt' }
        }]
      }
    },
    position: [1540, 0]
  }
});

const sendCaseFound = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Send Case Status',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $("Telegram Trigger").item.json.message.chat.id }}'),
      text: expr('{{ "Case " + $json.records[0].CaseNumber + ": " + $json.records[0].Status + "\\nSubject: " + $json.records[0].Subject }}')
    },
    credentials: { telegramApi: { __credentialName: 'Lori_V01_bot' } },
    position: [1760, -80]
  },
  output: [{ ok: true }]
});

const sendCaseNotFound = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Send Case Not Found',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $("Telegram Trigger").item.json.message.chat.id }}'),
      text: expr('{{ "Sorry, no ticket found with number " + $("Telegram Trigger").item.json.message.text.trim() + ". Please check the number and try again, or type /menu to see options." }}')
    },
    credentials: { telegramApi: { __credentialName: 'Lori_V01_bot' } },
    position: [1760, 80]
  },
  output: [{ ok: true }]
});

const clearStateAfterFound = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Clear State After Found',
    parameters: {
      resource: 'row',
      operation: 'upsert',
      dataTableId: { __rl: true, mode: 'name', value: 'byoc_telegram_chat_state' },
      matchType: 'anyCondition',
      filters: {
        conditions: [{
          keyName: 'chat_id',
          condition: 'eq',
          keyValue: expr('{{ $("Telegram Trigger").item.json.message.chat.id }}')
        }]
      },
      columns: { mappingMode: 'defineBelow', value: { chat_id: expr('{{ $("Telegram Trigger").item.json.message.chat.id }}'), state: 'new' }, matchingColumns: [], schema: [] }
    },
    position: [1980, -80]
  }
});

const clearStateAfterNotFound = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Clear State After Not Found',
    parameters: {
      resource: 'row',
      operation: 'upsert',
      dataTableId: { __rl: true, mode: 'name', value: 'byoc_telegram_chat_state' },
      matchType: 'anyCondition',
      filters: {
        conditions: [{
          keyName: 'chat_id',
          condition: 'eq',
          keyValue: expr('{{ $("Telegram Trigger").item.json.message.chat.id }}')
        }]
      },
      columns: { mappingMode: 'defineBelow', value: { chat_id: expr('{{ $("Telegram Trigger").item.json.message.chat.id }}'), state: 'new' }, matchingColumns: [], schema: [] }
    },
    position: [1980, 80]
  }
});

// ============================================================================
// ESCALATED USER: forward free-text message via the connector
// ============================================================================
const forwardEscalatedMessage = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Forward Message to Salesforce',
    parameters: {
      method: 'POST',
      url: CONNECTOR_ESCALATE_URL,
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [
          { name: 'X-Connector-Secret', value: CONNECTOR_SECRET }
        ]
      },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ { chatId: $("Telegram Trigger").item.json.message.chat.id, text: $("Telegram Trigger").item.json.message.text } }}')
    },
    position: [880, 150]
  },
  output: [{ conversationIdentifier: 'abc', success: true }]
});

// ============================================================================
// CALLBACK BRANCH: answer the query first (required by Telegram)
// ============================================================================
const answerCallback = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Answer Callback Query',
    parameters: {
      resource: 'callback',
      operation: 'answerQuery',
      queryId: expr('{{ $json.callback_query.id }}')
    },
    credentials: { telegramApi: { __credentialName: 'Lori_V01_bot' } },
    position: [440, 500]
  },
  output: [{ ok: true }]
});

const routeCallbackData = switchCase({
  version: 3.4,
  config: {
    name: 'Route Callback Data',
    parameters: {
      mode: 'rules',
      rules: {
        values: [
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              combinator: 'and',
              conditions: [{
                leftValue: expr('{{ $("Telegram Trigger").item.json.callback_query.data }}'),
                rightValue: 'check_ticket',
                operator: { type: 'string', operation: 'equals' }
              }]
            },
            renameOutput: true,
            outputKey: 'CheckTicket'
          },
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              combinator: 'and',
              conditions: [{
                leftValue: expr('{{ $("Telegram Trigger").item.json.callback_query.data }}'),
                rightValue: 'talk_to_agent',
                operator: { type: 'string', operation: 'equals' }
              }]
            },
            renameOutput: true,
            outputKey: 'TalkToAgent'
          }
        ]
      },
      options: { fallbackOutput: 'none' }
    },
    position: [660, 500]
  }
});

const setAwaitingTicketState = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Set Awaiting Ticket State',
    parameters: {
      resource: 'row',
      operation: 'upsert',
      dataTableId: { __rl: true, mode: 'name', value: 'byoc_telegram_chat_state' },
      matchType: 'anyCondition',
      filters: {
        conditions: [{
          keyName: 'chat_id',
          condition: 'eq',
          keyValue: expr('{{ $("Telegram Trigger").item.json.callback_query.message.chat.id }}')
        }]
      },
      columns: { mappingMode: 'defineBelow', value: { chat_id: expr('{{ $("Telegram Trigger").item.json.callback_query.message.chat.id }}'), state: 'awaiting_ticket' }, matchingColumns: [], schema: [] }
    },
    position: [880, 420]
  }
});

const promptForTicketNumber = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Prompt For Ticket Number',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $("Telegram Trigger").item.json.callback_query.message.chat.id }}'),
      text: 'Please type your ticket number (e.g. 00001234).',
      replyMarkup: 'forceReply',
      forceReply: { force_reply: true, selective: false }
    },
    credentials: { telegramApi: { __credentialName: 'Lori_V01_bot' } },
    position: [1100, 420]
  },
  output: [{ ok: true }]
});

// ============================================================================
// ESCALATION: delegate the Interaction Service call to the connector
// ============================================================================
const escalateToAgent = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Escalate To Agent',
    parameters: {
      method: 'POST',
      url: CONNECTOR_ESCALATE_URL,
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [
          { name: 'X-Connector-Secret', value: CONNECTOR_SECRET }
        ]
      },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ { chatId: $("Telegram Trigger").item.json.callback_query.message.chat.id, text: "Customer requested to speak with an agent." } }}')
    },
    position: [880, 600]
  },
  output: [{ conversationIdentifier: 'abc', success: true }]
});

const setEscalatedState = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Set Escalated State',
    parameters: {
      resource: 'row',
      operation: 'upsert',
      dataTableId: { __rl: true, mode: 'name', value: 'byoc_telegram_chat_state' },
      matchType: 'anyCondition',
      filters: {
        conditions: [{
          keyName: 'chat_id',
          condition: 'eq',
          keyValue: expr('{{ $("Telegram Trigger").item.json.callback_query.message.chat.id }}')
        }]
      },
      columns: { mappingMode: 'defineBelow', value: { chat_id: expr('{{ $("Telegram Trigger").item.json.callback_query.message.chat.id }}'), state: 'escalated' }, matchingColumns: [], schema: [] }
    },
    position: [1100, 600]
  }
});

const confirmEscalation = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Confirm Escalation',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $("Telegram Trigger").item.json.callback_query.message.chat.id }}'),
      text: "You're now connected to an agent. Send your message and someone will respond shortly."
    },
    credentials: { telegramApi: { __credentialName: 'Lori_V01_bot' } },
    position: [1320, 600]
  },
  output: [{ ok: true }]
});

// ============================================================================
// SESSION-END WEBHOOK: connector calls this when it detects the agent ended
// the chat (MessagingSession.Status -> 'Ended' via CDC). Resets state to
// 'new' so the next free-text message shows the menu instead of forwarding
// to the (now closed) Salesforce session.
// ============================================================================
const resetWebhookTrigger = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Reset Chat State Webhook',
    parameters: { httpMethod: 'POST', path: 'byoc-telegram-reset', responseMode: 'onReceived' },
    position: [0, 850]
  },
  output: [{ headers: { 'x-connector-secret': CONNECTOR_SECRET }, body: { chatId: 123456789 } }]
});

const verifyResetSecret = ifElse({
  version: 2.3,
  config: {
    name: 'Verify Reset Secret',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        combinator: 'and',
        conditions: [{
          leftValue: expr('{{ $json.headers["x-connector-secret"] }}'),
          rightValue: CONNECTOR_SECRET,
          operator: { type: 'string', operation: 'equals' }
        }]
      }
    },
    position: [220, 850]
  }
});

const resetStateFromSf = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Reset State (Agent Ended)',
    parameters: {
      resource: 'row',
      operation: 'upsert',
      dataTableId: { __rl: true, mode: 'name', value: 'byoc_telegram_chat_state' },
      matchType: 'anyCondition',
      filters: {
        conditions: [{ keyName: 'chat_id', condition: 'eq', keyValue: expr('{{ $json.body.chatId }}') }]
      },
      columns: {
        mappingMode: 'defineBelow',
        value: { chat_id: expr('{{ $json.body.chatId }}'), state: 'new' },
        matchingColumns: [],
        schema: []
      }
    },
    position: [440, 850]
  }
});

// ============================================================================
// COMPOSE WORKFLOW
// ============================================================================
export default workflow('qxT2bl6eYKU2N1XY', 'BYOC-Telegram')
  .add(telegramTrigger)
  .to(routeUpdateType
    .onCase(0, answerCallback
      .to(routeCallbackData
        .onCase(0, setAwaitingTicketState.to(promptForTicketNumber))
        .onCase(1, escalateToAgent
          .to(setEscalatedState)
          .to(confirmEscalation))))
    .onCase(1, resetCommandCheck
      .onTrue(resetStateManual.to(sendMenu))
      .onFalse(getChatState
        .to(normalizeChatState
        .to(chatStateCheck
          .onTrue(forwardEscalatedMessage)
          .onFalse(awaitingTicketCheck
            .onTrue(signJwtForLookup
              .to(getSalesforceTokenForLookup)
              .to(lookupCase)
              .to(caseFoundCheck
                .onTrue(sendCaseFound.to(clearStateAfterFound))
                .onFalse(sendCaseNotFound.to(clearStateAfterNotFound))))
            .onFalse(sendMenu)))))))
  .add(resetWebhookTrigger)
  .to(verifyResetSecret.onTrue(resetStateFromSf));
