# Salesforce BYOC Telegram Channel — Complete Replication Guide

A Telegram support bot integrated with **Salesforce Service Cloud** via **Bring Your Own Channel (BYOC) for Messaging**, with a self-service menu, case lookup, and live agent handoff — including automatic session-end handling in both directions.

This README consolidates all project documentation into a single, start-to-finish replication guide. Salesforce's official BYOC documentation is incomplete; several steps below (notably the `CustomMsgChannel` record and the 15-character `OrgId` header) are documented nowhere else and were discovered by trial and error.

**Verified working journeys** (all tested end-to-end):

| # | Journey |
|---|---------|
| 1 | Fresh chat → inline menu ("Check ticket status" / "Talk to an agent") |
| 2 | Ticket lookup: menu → type case number → status + subject returned → state reset |
| 3 | Escalation: menu → MessagingSession created → routed via Omni-Channel → agent accepts |
| 4 | Two-way chat: user free text → agent console; agent reply → Telegram |
| 5 | Agent ends chat → user notified in Telegram → state reset → menu on next message |
| 6 | User ends chat manually with `/done` or `/menu` → state reset → menu |

---

## Table of contents

1. [Architecture](#1-architecture)
2. [Repository layout](#2-repository-layout)
3. [Prerequisites](#3-prerequisites)
4. [Salesforce setup](#4-salesforce-setup)
5. [Telegram bot setup](#5-telegram-bot-setup)
6. [Connector: local run + ngrok (development phase)](#6-connector-local-run--ngrok-development-phase)
7. [Docker, VPS & webhook (production hosting)](#7-docker-vps--webhook-production-hosting)
8. [n8n setup (bot UX layer)](#8-n8n-setup-bot-ux-layer)
9. [End-to-end testing](#9-end-to-end-testing)
10. [Troubleshooting](#10-troubleshooting)
11. [Gotchas — read before touching anything](#11-gotchas--read-before-touching-anything)
12. [Tech debt & production-readiness gaps](#12-tech-debt--production-readiness-gaps)
13. [Sandbox → production promotion checklist](#13-sandbox--production-promotion-checklist)

---

## 1. Architecture

### Final architecture (n8n-fronted)

```
Telegram user ──▶ bot webhook
                     │
                     ▼
        n8n workflow "BYOC-Telegram"  (self-hosted n8n)
          ├─ menu / routing / chat state (Data Table byoc_telegram_chat_state)
          ├─ Case lookup: n8n → Salesforce REST directly (JWT bearer flow)
          ├─ Escalation & escalated messages: n8n → connector /api/escalate
          └─ Reset webhook /webhook/byoc-telegram-reset (called by connector)
                     │                                        ▲
                     ▼                                        │
        Docker connector (VPS, Docker Compose + Caddy TLS)    │
          ├─ /api/escalate → Interaction Service (multipart)  │
          ├─ Pub/Sub: /event/Telegram_Message_Event__e        │
          │    └─ agent replies → Telegram Bot API            │
          └─ Pub/Sub: /data/MessagingSessionChangeEvent (CDC) │
               └─ Status='Ended' → notify user + reset ───────┘
                     │
                     ▼
        Salesforce (sandbox first, then prod)
          ConversationChannelDefinition / CustomMsgChannel
          Omni-Channel routing → Service Console agent
```

- **Inbound** (Telegram → agent): Telegram webhook → n8n (menu/state) → connector `/api/escalate` → **Interaction Service REST API** (on the `*.salesforce-scrt.com` host) → MessagingSession/ConversationEntry → Omni-Channel → agent.
- **Outbound** (agent → Telegram): agent reply → Salesforce publishes the **custom platform event** → connector receives it via **Pub/Sub API (gRPC)** → connector calls Telegram `sendMessage`.
- **Session end**: connector subscribes to **Change Data Capture** on MessagingSession; on `Status='Ended'` it notifies the user and POSTs to n8n's reset webhook so the menu state resets.

### Division of labor (do NOT "simplify" these away)

- **n8n owns the bot UX** (menu, state machine, case lookup). Case lookup is ordinary REST JSON, which n8n handles fine.
- **The connector owns every Interaction Service call.** n8n's HTTP node **cannot** send multipart/form-data with a custom boundary — it rewrites the boundary, so header ≠ body and Salesforce returns a bare `400 Bad Request`. No payload change can ever fix this; delegate to the connector.
- **The connector owns both Pub/Sub legs** (agent replies out, session-end detection in) because only it holds the gRPC Pub/Sub client.
- Routing escalations through the connector also re-populates its `telegramChatId` cache, which the outbound (agent-reply) leg depends on.

### State machine (n8n Data Table `byoc_telegram_chat_state`)

```
new ──(Check ticket status)──▶ awaiting_ticket ──(lookup done)──▶ new
new ──(Talk to an agent)────▶ escalated ──(agent End Chat via CDC, or user /done | /menu)──▶ new
```

---

## 2. Repository layout

```
├── README.md                ← this guide
├── .gitignore               ← blocks .env, *.key, *.crt, *.pem from ever being committed
├── salesforce/              ← SFDX project: all Salesforce metadata to deploy
│   ├── sfdx-project.json
│   ├── manifest/byoc_ccd.xml            (one-shot deploy manifest for the CCD)
│   ├── scripts/apex/verify_publish.apex (platform-event publish smoke test)
│   └── force-app/main/default/
│       ├── objects/Telegram_Message_Event__e/         (platform event + 2 fields)
│       ├── conversationChannelDefinitions/            (the BYOC CCD)
│       ├── externalClientApps/                        (ECA shell — OAuth config is UI-only)
│       ├── flows/ + flowDefinitions/                  (Omni-Channel routing flow "BYOC")
│       ├── queues/ + queueRoutingConfigs/             (Omni-Channel queue + routing config)
│       ├── permissionsets/                            (SCRT2 perm set additions)
│       └── platformEventChannelMembers/               (CDC enablement for MessagingSession)
├── connector/               ← Node.js middleware (based on salesforce-misc/byo-demo-connector)
│   ├── Dockerfile, docker-compose.yml, Caddyfile
│   ├── .env.example         ← copy to .env and fill in (never commit .env)
│   └── src/server/          ← the part that actually runs
│       ├── server.mjs, ottAppServer.mjs               (Express server, /api/escalate, Pub/Sub handlers)
│       └── ottAppLib/
│           ├── telegram-webhook.mjs                   (inbound webhook handler — idle in final arch)
│           ├── telegram-outbound.mjs                  (Telegram sendMessage wrapper)
│           ├── sfdc-auth.mjs                          (JWT bearer flow)
│           ├── sfdc-byoc-interaction-api.mjs          (Interaction Service multipart calls)
│           └── sfdc-pub-sub-api.mjs                   (gRPC Pub/Sub client)
└── n8n/
    └── byoc-telegram-workflow.js   ← n8n Workflow SDK source (menu, state, lookup, escalation)
```

> **Secrets policy:** everything environment-specific lives in `connector/.env` (from `.env.example`) or in n8n credentials. The placeholders `<LIKE_THIS>` throughout this guide and the source must be replaced with your own values. Never commit real keys, tokens, or the `.env` file.

---

## 3. Prerequisites

- Salesforce org (**sandbox first**) with **Digital Engagement / Messaging** licenses and Omni-Channel enabled. BYOC consumes Digital Engagement conversation entitlements.
- Salesforce CLI (`sf`) authenticated to the org.
- Node.js 18+ (verified on v22) and npm.
- A Telegram account (to create the bot via @BotFather).
- **Development phase:** an ngrok account (free tier works) or any public HTTPS tunnel.
- **Production phase:** a VPS (verified on Ubuntu 24.04 + Docker) and a domain/subdomain you control (for a DNS A record).
- A self-hosted **n8n** instance (verified on v2.16.1), publicly reachable over HTTPS (needed for the Telegram Trigger webhook).

---

## 4. Salesforce setup

Work in this order. Every step was verified against a real sandbox.

### 4.1 Custom platform event (outbound event channel)

Salesforce publishes this event whenever an agent sends a message; the connector subscribes to it.

Deploy `salesforce/force-app/main/default/objects/Telegram_Message_Event__e/` (or create in Setup → Platform Events → New):

- `EventType__c` — Text(250) — becomes the CCD's "event type field"
- `Payload__c` — Long Text Area(32768) — becomes the CCD's "payload field"; all message content is JSON inside it. **No binary/base64 media inline** — attachments go via Interaction Service attachment upload, referenced by ID.

```bash
sf project deploy start -m "CustomObject:Telegram_Message_Event__e" -o <org>
```

Names are your choice, but they must match the CCD (4.4) exactly.

### 4.2 OAuth app with JWT Bearer auth (server-to-server)

The connector and n8n authenticate via the **OAuth 2.0 JWT Bearer flow** — no interactive login.

> **Spring '26 note:** new classic Connected Apps may be blocked; Salesforce steers toward **External Client Apps (ECA)**. This project used an ECA named `BYOC`. The steps are equivalent.

1. Generate a self-signed cert + private key (keep `server.key` secret, never commit it):
   ```bash
   openssl req -x509 -sha256 -nodes -days 365 -newkey rsa:2048 -keyout server.key -out server.crt
   ```
2. Setup → App Manager → **New External Client App** (or Connected App):
   - Enable OAuth Settings; callback URL can be `https://login.salesforce.com/services/oauth2/callback` (unused by the JWT flow).
   - **Use digital signatures** → upload `server.crt`.
   - OAuth scopes: `api`, `refresh_token, offline_access`, and any listed Interaction API / messaging scopes.
   - Save and note the **Consumer Key** (shown once for ECAs — capture it immediately).
3. Manage → Edit Policies → Permitted Users: **Admin approved users are pre-authorized**; assign the integration user's profile/permission set.
4. Test the flow before proceeding: mint a JWT (`iss` = consumer key, `sub` = integration username, `aud` = `https://test.salesforce.com` for sandbox / `https://login.salesforce.com` for prod, `exp` = now+300s), sign RS256 with `server.key`, POST to `https://test.salesforce.com/services/oauth2/token` with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`. Expect HTTP 200 + `access_token`.

> The CCD (next steps) must use `ConnectedAppType = Customer` (self-implementation path). Do **NOT** include `ConversationVendorInfo` / `ConversationVendorInfoId` — those are for the AppExchange/partner path and will break a self-implementation.

### 4.3 Integration user permissions

The JWT user needs, via permission set:

- **API Enabled**
- Object **Create + Read** on the platform event (`Telegram_Message_Event__e`). Platform events do **not** enforce field-level security — object-level Create is sufficient (field permissions are a harmless no-op).
- Access to Messaging objects (MessagingSession, MessagingEndUser, …).
- **Case Read** (`Id, CaseNumber, Status, Subject`) — needed by n8n's case-lookup branch.
- Pre-authorization on the OAuth app from 4.2.

The org's `sfdcInternalInt__sfdc_scrt2` permission set (SCRT2) must exist — it does automatically when the BYOC/Messaging SKU is provisioned. `salesforce/force-app/main/default/permissionsets/` contains this project's additions to it.

Smoke-test event publishing:
```bash
sf apex run -o <org> --file salesforce/scripts/apex/verify_publish.apex
```

### 4.4 ConversationChannelDefinition (CCD) — deploy via Metadata API

The core BYOC object. It is **metadata**. Working definition in `salesforce/force-app/main/default/conversationChannelDefinitions/BYOC_ChannelDefinition1.ConversationChannelDefinition-meta.xml` — key fields:

```xml
<connectedAppType>Customer</connectedAppType>
<consentOwner>Salesforce</consentOwner>
<customPlatformEvent>Telegram_Message_Event__e</customPlatformEvent>
<customEventTypeField>Telegram_Message_Event__e.EventType__c</customEventTypeField>
<customEventPayloadField>Telegram_Message_Event__e.Payload__c</customEventPayloadField>
<developerName>BYOC_ChannelDefinition1</developerName>
<masterLabel>Telegram BYOC Channel Definition</masterLabel>
<routingOwner>Salesforce</routingOwner>
```

Deploy (a manifest is required — the type is not auto-inferred from the file path):
```bash
sf project deploy start --manifest salesforce/manifest/byoc_ccd.xml -o <org>
```

Verify:
```bash
sf data query -o <org> -q "SELECT Id, DeveloperName, CustomPlatformEvent FROM ConversationChannelDefinition"
```

> ⚠️ **Gotcha:** the file extension must be capital-C `.ConversationChannelDefinition-meta.xml`. The lowercase form produces `Could not infer a metadata type`.
>
> ⚠️ **Gotcha:** the CCD `developerName` is the value you must later use as `SF_AUTHORIZATION_CONTEXT` in the connector `.env` **and** as the `AuthorizationContext` HTTP header on every Interaction Service call. Not the label, not "telegram".
>
> Naming convention: `{OAuthAppName}_ChannelDefinition1` (matches the official sample).

### 4.5 Omni-Channel plumbing (queue, routing config, flow)

Deploy from `salesforce/force-app/main/default/` (or create in Setup):

| Component | This project's example |
|---|---|
| Queue | `LKS_Omni_Channel` (`queues/`) — agents must be members |
| Queue Routing Config | `queueRoutingConfigs/` |
| Omni-Channel Flow | Flow `BYOC` (`flows/` + `flowDefinitions/`) — routes incoming MessagingSessions to the queue |
| Presence Status | create in Setup and assign to agents |

Notes from this build:
- The flow's `serviceChannelId` initially points at the standard `sfdc_livemessage` service channel — after the BYOC channel is created (4.6), verify it targets the BYOC service channel and re-deploy if not.
- Avoid hardcoded queue IDs in the flow (`queueLabel` resolves it) — hardcoded IDs break on org refresh/migration.
- Sandbox usernames carry a suffix (`user@company.com.sandboxname`) — queue-member metadata must use the sandbox-shaped username.

### 4.6 MessagingChannel (Setup UI — cannot be deployed)

1. Setup → Quick Find → **Messaging Settings** → **New Channel**.
2. The channel-type screen shows one tile per CCD in the org — select yours (e.g. "Telegram BYOC Channel Definition"). *If the tile is missing, the OAuth app's config is incomplete (scopes, cert upload, pre-authorization) — fix that first, don't force it.*
3. Name the channel (e.g. `Telegram`) → Save.
4. Channel detail → **Omni-Channel Routing** → Edit → Routing Type = `Omni-Flow` → select flow `BYOC` → Save.
5. **Activate** the channel.
6. From the detail page capture two values for later:
   - **`ChannelAddressIdentifier`** (a UUID) → goes in connector `.env` and is the `to` address of every inbound interaction.
   - The org's **SCRT URL** (`https://<mydomain>.sandbox.my.salesforce-scrt.com`) → `SF_SCRT_INSTANCE_URL`.

### 4.7 CustomMsgChannel record — ⚠️ the undocumented step

Even after the wizard, the org may have **zero** `CustomMsgChannel` records — and without one, behavior is inconsistent. Check:

```bash
sf data query -o <org> -q "SELECT Id, ChannelDefinitionId, MessagingChannelId FROM CustomMsgChannel"
```

If empty, create it **as a data record via CLI**. Despite what some AI-generated guides claim, `CustomMsgChannel` is a **regular createable SObject — NOT a Metadata API type**. There is no `.customMsgChannel-meta.xml`, no `customMsgChannels/` metadata folder, and no Setup button for it:

```bash
# get the two IDs
sf data query -o <org> -q "SELECT Id FROM MessagingChannel WHERE MasterLabel='Telegram'"
sf data query -o <org> -q "SELECT Id FROM ConversationChannelDefinition WHERE DeveloperName='BYOC_ChannelDefinition1'"

# create the record
sf data create record -o <org> --sobject CustomMsgChannel \
  --values "MessagingChannelId='<0Mj...>' ChannelDefinitionId='<11v...>'"
```

### 4.8 Change Data Capture on MessagingSession (session-end detection)

Setup → **Change Data Capture** → add **Messaging Session** to the selected entities. (Mirrored as metadata in `salesforce/force-app/main/default/platformEventChannelMembers/`.)

The connector subscribes to `/data/MessagingSessionChangeEvent` and reacts to `Status='Ended'` — this is what makes "agent clicks End Chat → user gets notified → menu resets" work.

### 4.9 Record the values you'll need everywhere

| Item | Where used |
|---|---|
| **15-character** Org ID (first 15 chars of the 18-char ID) | `SF_ORG_ID`, `OrgId` header |
| CCD DeveloperName (`BYOC_ChannelDefinition1`) | `SF_AUTHORIZATION_CONTEXT`, `AuthorizationContext` header |
| `ChannelAddressIdentifier` UUID | `CHANNEL_ADDRESS_IDENTIFIER`, interaction `to` field |
| Consumer Key | connector `.env`, n8n workflow |
| Integration username | `SF_SUBJECT`, n8n JWT claims |
| Instance URL + SCRT URL | `SF_INSTANCE_URL`, `SF_SCRT_INSTANCE_URL` |

---

## 5. Telegram bot setup

1. In Telegram, talk to **@BotFather** → `/newbot` → choose a display name and a username (must end in `bot`).
2. Save the **bot token** (format `1234567890:AAAA...`). It goes in the connector `.env` (`TELEGRAM_BOT_TOKEN`) and in an n8n credential. Treat it as a secret.
3. Generate a random webhook secret for later:
   ```bash
   openssl rand -hex 32   # → TELEGRAM_WEBHOOK_SECRET
   ```
4. The webhook itself is registered later (section 7.4 — it points at **n8n** in the final architecture, at the connector/ngrok during the development phase).

Telegram constraints to design around: bots **cannot initiate conversations** (inbound-first only — no outbound campaign pattern); rate limits ~30 msg/sec globally and ~1 msg/sec per chat.

---

## 6. Connector: local run + ngrok (development phase)

Use this phase to validate the Salesforce org setup end-to-end **before** introducing Docker/VPS/n8n. It isolates org/provisioning faults from middleware faults.

### 6.1 Install

The connector is based on Salesforce's [`salesforce-misc/byo-demo-connector`](https://github.com/salesforce-misc/byo-demo-connector) demo app with Telegram-specific modifications already applied in `connector/src/` (see 6.3).

```bash
cd connector
npm install
```

### 6.2 Configure `.env`

```bash
cp .env.example .env   # then fill in every value
```

The three gotchas that cost hours (all annotated in `.env.example`):

1. **`SF_AUTHORIZATION_CONTEXT`** must equal the CCD DeveloperName exactly.
2. The variable is **`SF_ORG_ID`** — the code never reads `ORG_ID`. If misnamed, Pub/Sub fails with gRPC `PERMISSION_DENIED ... org core/prod/undefined`.
3. `SF_ORG_ID` must be the **15-character** org ID. The 18-char form makes the Interaction Service reject every call with `{"message":"Enter a valid header.","code":10016}`.

Start the server side only (the webpack client UI isn't needed for Telegram):

```bash
node --experimental-modules ./src/server/server.mjs
```

Healthy startup: access token obtained → CCD queried successfully by DeveloperName → `Subscribe request sent ... /event/Telegram_Message_Event__e` → **no** gRPC `PERMISSION_DENIED`.

### 6.3 What was changed vs. the stock demo repo

Already present in `connector/src/` — listed so you understand the moving parts:

1. **Inbound webhook handler** — `src/server/ottAppLib/telegram-webhook.mjs`: parses the Telegram update, validates the `X-Telegram-Bot-Api-Secret-Token` header against `TELEGRAM_WEBHOOK_SECRET` (403 on mismatch), caches the chat id, and calls `sendSFInboundMessageInteraction()`. Route registered in `ottAppServer.mjs` as `POST /api/telegram/webhook` (always returns 200 so Telegram doesn't retry-loop). *In the final n8n architecture this route is idle — n8n owns the bot webhook.*
2. **Outbound sender** — `src/server/ottAppLib/telegram-outbound.mjs`: thin wrapper over the Bot API `sendMessage`.
3. **Agent-reply forwarding** — in `ottAppServer.mjs`, the Pub/Sub subscription handler's `STATIC_CONTENT_MESSAGE` case forwards the text to the cached Telegram chat id.
4. **`/api/escalate` endpoint** — `POST` with header `X-Connector-Secret: <N8N_CONNECTOR_SECRET>` and body `{"chatId": <number>, "text": "..."}`. Called by n8n for escalations and all escalated free-text messages; performs the multipart Interaction Service call and repopulates the chat-id cache.
5. **CDC session-end handler** — subscribes to `/data/MessagingSessionChangeEvent`; on `Status='Ended'` notifies the user via the Bot API and POSTs `{chatId}` to `N8N_RESET_WEBHOOK_URL` (same `X-Connector-Secret` auth).
6. **`logger.warn` added** to `src/server/util.mjs` — the stock logger lacked it and calls to it threw.

### 6.4 ngrok tunnel + webhook (dev only)

```bash
ngrok config add-authtoken <your-token>
ngrok http 3000
# note the https URL, then register the webhook DIRECTLY at the connector:
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=https://<ngrok-id>.ngrok-free.app/api/telegram/webhook" \
     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
# verify:
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

> Free-tier ngrok URLs change on every restart — re-run `setWebhook` each time. ngrok's inspector at `http://127.0.0.1:4040` shows every webhook delivery.

### 6.5 Validate the round trip before going further

1. Send a message to the bot → connector log: `TELEGRAM WEBHOOK RECEIVED` → `POST /interactions API ... completed successfully` with a `conversationIdentifier`.
2. In Salesforce:
   ```bash
   sf data query -o <org> -q "SELECT Id, Status, Origin, CreatedDate FROM MessagingSession ORDER BY CreatedDate DESC LIMIT 3"
   ```
   Expect a new session, `Status=Waiting`, `Origin=InboundInitiated`.
3. Service Console: go online in Omni-Channel → accept the work item → reply.
4. Reply arrives in Telegram; connector log: `[TELEGRAM-OUT] Message delivered, message_id: N`.

**Only proceed to Docker/VPS/n8n after this full round trip works.**

---

## 7. Docker, VPS & webhook (production hosting)

Replaces ngrok with a permanent HTTPS endpoint. Stack: **Docker Compose** (connector + **Caddy** reverse proxy with automatic Let's Encrypt TLS) on any VPS (verified: Ubuntu 24.04 "with Docker" template on Hostinger).

### 7.1 One-time VPS setup

1. Provision the VPS with Docker installed; confirm Docker starts on boot (`systemctl is-enabled docker` → `enabled`).
2. Create a **DNS A record** at your registrar: `connector.yourdomain.com` → VPS static IP.
3. Edit `connector/Caddyfile` — put your real domain in place of the placeholder. Caddy obtains and renews the certificate automatically; zero manual cert management.
4. SSH: add a dedicated keypair to the VPS's `authorized_keys`; optionally add a host alias in `~/.ssh/config`.
5. Create the app directory and its production `.env`:
   ```bash
   ssh <vps> "mkdir -p /opt/telegram-byoc-connector"
   scp connector/.env <vps>:/opt/telegram-byoc-connector/.env   # filled-in production values
   ```
   The `.env` on the VM is managed separately and is never part of a deploy tarball.

### 7.2 docker-compose stack

`connector/docker-compose.yml` runs two services, both `restart: unless-stopped` (self-heals through VM reboots):

- `connector` — built from `Dockerfile` (`node:22-slim`; the native build tools it installs are only needed by an unused `canvas` dependency — see tech debt #11). Exposes 3000 internally only.
- `caddy` — publishes 80/443, reverse-proxies to `connector:3000` per the `Caddyfile`.

### 7.3 Deploy / redeploy

From the `connector/` directory (tarball + scp; use rsync if you have it):

```bash
tar --exclude='node_modules' --exclude='.git' --exclude='.env' \
    --exclude='dist' --exclude='coverage' --exclude='uploads' \
    -czf /tmp/connector-deploy.tar.gz .

scp /tmp/connector-deploy.tar.gz <vps>:/opt/telegram-byoc-connector/deploy.tar.gz

ssh <vps> "cd /opt/telegram-byoc-connector && \
    tar -xzf deploy.tar.gz && rm deploy.tar.gz && \
    docker compose up -d --build"
```

Useful commands:
```bash
ssh <vps> "cd /opt/telegram-byoc-connector && docker compose ps"
ssh <vps> "cd /opt/telegram-byoc-connector && docker compose logs connector --tail=100 -f"
ssh <vps> "cd /opt/telegram-byoc-connector && docker compose restart connector"
```

### 7.4 Register the Telegram webhook (final architecture: points at n8n!)

In the final architecture **n8n owns the bot webhook** — the n8n Telegram Trigger node registers it automatically when the workflow is activated (verify with `getWebhookInfo`).

If you are running the intermediate phase (no n8n, connector handles the bot directly), register it at the connector instead:

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://connector.yourdomain.com/api/telegram/webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Registration is needed only once per URL/secret change — no more per-restart re-registration.

---

## 8. n8n setup (bot UX layer)

Self-hosted n8n (verified v2.16.1), publicly reachable over HTTPS (same Caddy/DNS pattern as the connector works fine).

### 8.1 Credentials (create manually in the n8n UI)

| Credential | Type | Content |
|---|---|---|
| e.g. `MyBot` | `telegramApi` | the bot token from @BotFather |
| e.g. `SF_JWT_Signing` | `jwtAuth` | algorithm **RS256**, private key = the **full PEM including BEGIN/END lines** (same `server.key` used by the connector) |

### 8.2 Data Table (chat state)

Create a Data Table named `byoc_telegram_chat_state` with columns:

- `chat_id` (string)
- `state` (string) — values: `new`, `awaiting_ticket`, `escalated`

### 8.3 Import the workflow

Source: [`n8n/byoc-telegram-workflow.js`](n8n/byoc-telegram-workflow.js) (n8n Workflow SDK format). Before deploying, replace the placeholder constants at the top of the file (consumer key, subject, escalate URL, connector secret — see comments in the file).

Deploy via the n8n MCP tools (`create_workflow_from_code` / `update_workflow`) or rebuild by hand in the UI following the node graph in the source.

> ⚠️ **`update_workflow` saves a DRAFT only.** Nothing changes in production until you also call **`publish_workflow`**. Symptom of forgetting: "same error after the fix". Always update → publish, every time.

What the workflow does:

- **Telegram Trigger** (updates: `message`, `callback_query`) — owns the bot webhook.
- **Reset commands**: `/done` or `/menu` reset the chat state to `new` in any state.
- **Menu**: inline keyboard "Check ticket status" / "Talk to an agent" shown to `new` chats.
- **Ticket lookup branch**: sets state `awaiting_ticket` → user types a case number → signs a JWT (native JWT node) → exchanges it for an access token → SOQL `SELECT Id, CaseNumber, Status, Subject FROM Case WHERE CaseNumber='<input>'` → replies found/not-found → resets state. Case numbers are stored zero-padded (`00001741`); `1741` will not match.
- **Escalation branch**: sets state `escalated` → POSTs `{chatId, text}` to the connector's `/api/escalate` with the `X-Connector-Secret` header. All subsequent free text from an `escalated` chat is forwarded the same way (no menu).
- **Reset webhook** (`POST /webhook/byoc-telegram-reset`, same secret header): called by the connector when CDC detects the agent ended the session; upserts the chat state back to `new`.

### 8.4 n8n platform gotchas (cost real debugging time — read them)

1. **HTTP Request node rewrites multipart bodies.** Never attempt custom-boundary multipart from n8n; delegate Interaction Service calls to the connector. (Proven by capturing the actual outbound request with webhook.site.)
2. **Data Table upsert `columns` is a resourceMapper object** — `{mappingMode:'defineBelow', value:{...}, matchingColumns:[], schema:[]}` — **not** an expression string. The expression form silently writes nothing (states never persist, menu keeps reappearing).
3. **`{{ }}` expressions are single JS expressions** — no `const`, no multi-statement bodies. Real logic goes in a Code node.
4. **Code nodes may not `require()` anything** (task-runner sandbox): no `crypto`, no `axios`. Use the native JWT node for signing and a plain HTTP Request for the token exchange.
5. **JWT node claim-name bug:** the structured `claims.*` fields produce literal `issuer/subject/audience` claim names. Always use `useJson: true` + `claimsJson` with proper `iss/sub/aud/exp`.
6. **Data Table `get` returns 0 items on no match → downstream nodes silently don't run.** Pattern: `alwaysOutputData: true` on the node + a Normalize Code node that guarantees exactly one item with a default state of `new`.
7. **Type mismatch trap:** Telegram `chat.id` is a number; the Data Table column may be string. Store/compare consistently (`String(chat.id)`).
8. **Debugging a black-box 400:** capture what n8n actually sends by pointing the node at webhook.site **first** — don't guess payload variations. Redact the Authorization header before sharing captures.

---

## 9. End-to-end testing

Run these in order after everything is deployed:

| # | Test | Expected |
|---|---|---|
| 1 | Send any message to the bot from a fresh chat | Inline menu appears ("Check ticket status" / "Talk to an agent") |
| 2 | Tap "Check ticket status" → type a real Case Number (zero-padded, e.g. `00001741`) | Status + subject returned; next message shows the menu again |
| 3 | Tap "Check ticket status" → type a nonsense number | Graceful "not found" reply; state reset |
| 4 | Tap "Talk to an agent" | Confirmation message; in n8n → Data Tables → `byoc_telegram_chat_state`, the row for your chat_id has `state = "escalated"` (this is the ground truth); in Salesforce a new MessagingSession exists (`Status=Waiting`, `Origin=InboundInitiated`) |
| 5 | Agent: Omni-Channel online → accept work item | Session opens in Service Console |
| 6 | User sends free text while escalated | Appears in the agent console — and the menu does NOT reappear |
| 7 | Agent replies | Message arrives in Telegram (connector log: `[TELEGRAM-OUT] Message delivered`) |
| 8 | Agent clicks **End Chat** | User gets "conversation has ended" in Telegram; state row resets; next message shows the menu |
| 9 | Re-escalate, then user types `/done` | State resets; menu on next message |

Verification helpers:

```bash
# Salesforce side
sf data query -o <org> -q "SELECT Id, Status, Origin, CreatedDate FROM MessagingSession ORDER BY CreatedDate DESC LIMIT 3"

# Connector side
ssh <vps> "cd /opt/telegram-byoc-connector && docker compose logs connector --tail=50"

# Direct smoke test of the escalation path (bypasses Telegram+n8n)
curl -s -X POST https://connector.yourdomain.com/api/escalate \
  -H "Content-Type: application/json" \
  -H "X-Connector-Secret: <N8N_CONNECTOR_SECRET>" \
  -d '{"chatId": <your telegram chat id>, "text": "smoke test"}'
# expect: 202 {"conversationIdentifier":"...","workItemIds":["..."],"success":true}
```

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `{"message":"Enter a valid header.","code":10016}` | `OrgId` header is 18-char | Use the **15-char** org ID in `SF_ORG_ID` |
| `No records found in the ConversationChannelDefinition` at connector startup | `SF_AUTHORIZATION_CONTEXT` ≠ CCD DeveloperName | Set it to the CCD `developerName` exactly |
| gRPC `PERMISSION_DENIED ... org core/prod/undefined` | `SF_ORG_ID` unset or misnamed (e.g. `ORG_ID`) | Rename/set the env var |
| Interaction Service bare `400 Bad Request` (Spring-style body, no detail) from n8n | n8n rewrote the multipart boundary | Route the call through the connector `/api/escalate` — no payload change can fix this |
| `RequestId header not present` on a curl test | shell variable was empty | Regenerate the UUID variables |
| Menu reappears after escalation | Data Table upsert wrote nothing (resourceMapper shape) or chat_id type mismatch | See gotchas 8.4 #2 and #7; check the Data Table row — "menu shown" always means "no matching escalated row found" |
| Session created but agent never sees it | Omni-Channel routing/queue/presence not set up, or agent offline | Section 4.5; agent must be queue member and online |
| Replies don't reach Telegram after a connector restart | chat-id cache is in-memory | Send one inbound (escalated) message to repopulate; see tech debt #1/#2 |
| Webhook returns 403 | `secret_token` mismatch | `TELEGRAM_WEBHOOK_SECRET` must equal the `secret_token` used in `setWebhook` |
| BYOC tile missing in Messaging Settings → New Channel | OAuth app config incomplete | Re-check scopes, cert upload, pre-authorization on the ECA/Connected App |
| CCD deploy: `Could not infer a metadata type` | lowercase file extension | Use `.ConversationChannelDefinition-meta.xml` (capital C) and the manifest |
| Container crashes on CDC events | `JSON.stringify` throws on BigInt (avro longs) inside the gRPC callback | Handlers must be wrapped in try/catch; use a BigInt-safe replacer when logging |

---

## 11. Gotchas — read before touching anything

The distilled, hard-won list. Full context in the sections above.

1. Interaction Service requires the **15-char** OrgId header (`code 10016` otherwise).
2. `SF_AUTHORIZATION_CONTEXT` / `AuthorizationContext` header = CCD **DeveloperName**, exactly.
3. **`CustomMsgChannel` is a regular SObject** created via `sf data create record` — not Metadata API, no Setup UI. (Beware: AI-generated guides circulating online claim the opposite.)
4. CCD metadata file extension needs **capital C**; deploy needs an explicit **manifest**.
5. n8n `update_workflow` saves a **draft** — must `publish_workflow` to go live.
6. n8n **cannot send custom-boundary multipart** — connector owns all Interaction Service calls.
7. n8n Data Table upsert `columns` is a **resourceMapper object**, not an expression string.
8. **CDC UPDATE events are deltas** — only changed fields are non-null (`ChannelKey` is null on the 'Ended' event, so channel filtering needs a follow-up record query).
9. `JSON.stringify` on parsed CDC payloads **throws on BigInt** — an unhandled throw inside a gRPC subscription callback **crashes the whole container**.
10. Platform events don't enforce field-level security — object-level Create suffices.
11. Sandbox usernames carry the sandbox suffix (`user@company.com.sandboxname`) — metadata referencing users must match.
12. Telegram bots can't initiate conversations; rate limits ~30 msg/sec global, ~1 msg/sec per chat.
13. Debug black-box HTTP failures by **capturing the actual outbound request first** (webhook.site), not by guessing payload variations.

---

## 12. Tech debt & production-readiness gaps

This is a working **MVP/demo**. Before real users, address these (ordered by risk):

### Critical

1. **Single-conversation MVP.** The connector caches ONE `telegramChatId` in memory. Two concurrent escalated users will cross wires on the agent-reply leg, and the CDC session-end handler notifies whoever escalated last. *Fix:* persistent map `conversationIdentifier → chatId` (Redis/SQLite/file volume), populated from the `/api/escalate` response, read by both the reply leg and the session-end handler.
2. **Chat-id cache lost on restart** (same cache) — a deploy/crash/reboot orphans the active conversation until the user sends another message. *Fix:* persist alongside #1.
3. **CDC filter accepts ANY MessagingSession ending in the org** (because `ChannelKey` is null on the delta event). Fine in a single-channel sandbox; in an org with WhatsApp/other channels, every ended session would ping the Telegram user. *Fix:* on 'Ended', query the record by `ChangeEventHeader.recordIds` and check `ChannelKey`/`ConversationId`.
4. **SOQL injection in case lookup** — the typed ticket number is interpolated raw into the query. *Fix:* validate `^\d{8}$` in an If/Code node before querying.
5. **Secrets hygiene** — connector logs access tokens at INFO; workflow constants hold the connector secret; rotate anything ever exposed; move secrets to a secret manager and the n8n secret into an `httpHeaderAuth` credential; redact logs.

### Important (hardening)

6. **No Pub/Sub replay-id persistence** — events published while the connector is down are silently lost (a session could end during a restart and the user is never released from `escalated`). *Fix:* store `latestReplayId`, resubscribe with CUSTOM replay, re-request quota as events are consumed.
7. **No auto-reconnect on gRPC stream end/error** — a dropped stream silently kills agent replies and session-end detection. *Fix:* reconnect with backoff.
8. **Access-token lifecycle** — verify token refresh on the Pub/Sub reconnect path when fixing #7.
9. **Root CA cert fetched from GitHub at startup** (`sfdc-pub-sub-api.mjs` pulls `cacert.pem` from raw.githubusercontent.com on boot) — outage or tampering = can't start / MITM exposure. *Fix:* vendor the cert into the image.
10. **No retry / dead-letter on either leg** — a transient 5xx silently drops the message. *Fix:* durable queue with backoff; ACK Telegram only after enqueue.
11. **Demo-connector baggage** — unused vendor SDK/phone/HVCC code and a `canvas` dependency that forces native build tools into the image. *Fix:* extract the ~5 modules actually used (auth, pub-sub, interaction API, telegram out, escalate endpoint) into a slim service.
12. **Deduplication not wired** — Telegram webhook retries create duplicate ConversationEntries. *Fix:* track processed `update_id`s with a short-TTL store.

### Nice to have

13. Monitoring/alerting (health endpoint covering Pub/Sub stream liveness; alert on n8n execution failures; log rotation).
14. HA: single VPS + single n8n instance today; no backups of the n8n Data Table or the VM `.env`.
15. UX: attachments and agent "choices" (inline keyboards) not mapped; typing indicators ignored; auto-pad case numbers (`1741` → `00001741`); localization.
16. Real Omni-Channel queue/capacity/business-hours config + an agent-unavailable path (an escalation outside agent hours currently sits in the queue with no user feedback).

---

## 13. Sandbox → production promotion checklist

Consumer Key, cert, org ID, SCRT URL, and `ChannelAddressIdentifier` all change in production. Nothing carries over.

- [ ] Rotate the Consumer Key + Consumer Secret used in the sandbox (they were widely circulated during development).
- [ ] Generate a **new** private key + cert pair for the prod OAuth app.
- [ ] Flip `SF_AUDIENCE` and `SF_AUTH_ENDPOINT` to `https://login.salesforce.com`.
- [ ] Update `SF_INSTANCE_URL`, `SF_SCRT_INSTANCE_URL`, `SF_ORG_ID` (15-char!), `CHANNEL_ADDRESS_IDENTIFIER`.
- [ ] Re-deploy the Salesforce metadata; re-create the MessagingChannel in prod Setup; re-create the `CustomMsgChannel` record via CLI.
- [ ] Re-verify OAuth app settings in the prod Setup UI (cert upload, pre-authorization, scopes).
- [ ] Re-run the section 9 test suite in prod before enabling the channel for customers.
- [ ] Script the whole setup (metadata deploy + `CustomMsgChannel` post-deploy step + config-driven values) — see tech debt list.

---

## License / attribution

The connector is derived from Salesforce's [`byo-demo-connector`](https://github.com/salesforce-misc/byo-demo-connector) sample (see `connector/LICENSE.txt`). Telegram integration, escalation endpoint, CDC session-end handling, Docker/Caddy packaging, and the n8n workflow are project additions.
