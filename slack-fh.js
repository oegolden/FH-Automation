const express = require("express");
const { WebClient, LogLevel } = require("@slack/web-api");
const fh_auth = require("./middleware/auth");
const { messagingLimiter } = require("./middleware/rateLimiter");
const ticketCache = require("./ticket-cache");
const { updateZendeskTicket } = require("./zendesk-fh");

const router = express.Router();

const auth = Buffer.from(`${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_KEY}`).toString('base64');

const client = new WebClient(process.env.Slack_BOT_TOKEN, {
    logLevel: LogLevel.DEBUG
});

async function fhRequest(endpoint, method = "GET", body = null) {
    const baseUrl = (process.env.FIREHYDRANT_API_BASE || "").replace(/\/+$/, "");
    const cleanEndpoint = `/${String(endpoint || "").replace(/^\/+/, "")}`;
    const requestUrl = `${baseUrl}${cleanEndpoint}`;

    if (!baseUrl) {
        throw new Error("FIREHYDRANT_API_BASE is not set in environment variables");
    }

    let res;
    try {
        res = await fetch(requestUrl, {
            method,
            headers: {
                "Authorization": `${process.env.FIREHYDRANT_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: body ? JSON.stringify(body) : undefined
        });
    } catch (err) {
        const causeCode = err && err.cause ? err.cause.code : undefined;
        const tlsHint = causeCode && String(causeCode).includes("ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE")
            ? " TLS handshake failed; verify FIREHYDRANT_API_BASE points to the correct HTTPS host and that outbound TLS inspection/proxy settings are valid."
            : "";
        throw new Error(`Failed to reach FireHydrant at ${requestUrl}.${tlsHint} Original error: ${err.message}`);
    }

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`FireHydrant API error ${res.status}: ${text}`);
    }

    return res.json();
}

async function getCleanedIncidentSummary(incident_id) {
    if (!process.env.FIREHYDRANT_AUDIENCE_ID) {
        throw new Error("FIREHYDRANT_AUDIENCE_ID is not set in environment variables");
    }

    const audienceId = process.env.FIREHYDRANT_AUDIENCE_ID.trim().replace(/^\/+|\/+$/g, "");
    const cleanIncidentId = String(incident_id || "").trim().replace(/^\/+|\/+$/g, "");

    if (!cleanIncidentId) {
        throw new Error("incident_id is required");
    }

    console.log(`Fetching summary for Audience ID: ${audienceId} and Incident ID: ${cleanIncidentId}`);

    try {
        const endpoint = `/audiences/${encodeURIComponent(audienceId)}/summaries/${encodeURIComponent(cleanIncidentId)}`;
        console.log(`Requesting FH Endpoint: ${endpoint}`);
        const response = await fhRequest(endpoint);

        let content = "";
        if (response && response.content) {
            content = response.content;
        } else {
            console.warn(`No content found in summary response for incident ${incident_id}`, response);
            return "No Incident Summary Available";
        }

        content = content.replace(/#/g, '').trim();
        return content;
    } catch (err) {
        console.error(`Error fetching summary for incident ${incident_id}:`, err);
        throw err;
    }
}

function parseTicketIds(responseBody) {
    const ticketIds = [];
    const data = responseBody.data;
    if (data && data.length > 0) {
        data.forEach(item => {
            if (item.type === 'Integrations::CustomerSupportIssue' && item.attributes && item.attributes.remote_id) {
                ticketIds.push(item.attributes.remote_id);
            }
        });
    }
    return ticketIds;
}

async function publishMessage(id, text) {
    try {
        const result = await client.chat.postMessage({
            token: process.env.Slack_BOT_TOKEN,
            channel: id,
            text: text
        });
        console.log(result);
    } catch (error) {
        console.error(error);
    }
}

router.post("/send-update-message", fh_auth, messagingLimiter, async (req, res) => {
    try {
        var { incident_id } = req.body;

        const updateBody = await getCleanedIncidentSummary(incident_id);

        const incident_links = await fhRequest(`/incidents/${incident_id}/attachments`);
        const ticket_ids = parseTicketIds(incident_links);
        console.log(ticket_ids);
        if (!ticket_ids) {
            return res.status(400).json({ error: "No valid ticket IDs provided." });
        }

        const userTickets = new Map(); // email -> { owner_id, tickets: [] }

        for (const ticket_id of ticket_ids) {
            const ticketResponse = await fetch(
                `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticket_id}.json?include=users`,
                {
                    method: "GET",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Basic ${auth}`
                    }
                }
            );

            if (!ticketResponse.ok) {
                throw new Error(`Failed to fetch ticket ${ticket_id}: ${ticketResponse.statusText}`);
            }

            const ticketData = await ticketResponse.json();
            const ticket = ticketData.ticket;
            const users = ticketData.users;

            const assigneeId = ticket.assignee_id;
            const assigneeUser = users.find(u => u.id === assigneeId);

            if (!assigneeUser || !assigneeUser.email) {
                console.warn(`No assignee or email found for ticket ${ticket_id}, skipping Slack notification.`);
                continue;
            }

            const owner_email = assigneeUser.email;

            try {
                const slack_response = await client.users.lookupByEmail({ email: owner_email });
                const owner_id = slack_response.user.id;

                if (!userTickets.has(owner_email)) {
                    userTickets.set(owner_email, { owner_id, tickets: [] });
                }
                userTickets.get(owner_email).tickets.push(ticket_id);

                // Add to cache
                ticketCache.addTicket(ticket_id, owner_email, updateBody);

            } catch (error) {
                console.error(`Slack lookup failed for ${owner_email}:`, error);
                continue;
            }
        }

        for (const [email, userObj] of userTickets.entries()) {
            const commandMessage =
                `New incident summaries are available for your assigned Zendesk tickets: [${userObj.tickets.join(", ")}].\n` +
                `Type 'view <ticket_id>' to view the message.`;
            await publishMessage(userObj.owner_id, commandMessage);
            console.log(`Message sent to channel '${email}'`);
        }

        return res.status(200).json({ message: "Update messages processed." });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: err.message });
    }
});

router.post("/update-confirmation", async (req, res) => {
    try {
        const { token, challenge, type } = req.body;

        // --- 1. Handle Slack URL Verification Challenge Context ---
        if (type === 'url_verification') {
            console.log("Received Slack URL Verification Challenge");
            return res.status(200).send(challenge);
        }

        // --- 2. Handle Message Event Callbacks ---
        if (type === 'event_callback' && req.body.event && req.body.event.type === 'message') {
            const text = req.body.event.text ? req.body.event.text.trim() : "";
            const channel = req.body.event.channel;

            const viewMatch = text.match(/^view\s+(\d+)/i);
            const publishMatch = text.match(/^publish\s+(\d+)\s+(public|internal)/i);

            // --- 2A. View Command: 'view <ticket_id>' ---
            if (viewMatch) {
                const ticketId = viewMatch[1];
                const cachedTicket = ticketCache.getTicket(ticketId);

                if (cachedTicket && cachedTicket.newSummaryAvailable) {
                    await publishMessage(channel, `*Summary for ticket ${ticketId}:*\n\n${cachedTicket.aiSummary}\n\n -------------- \n Type 'publish ${ticketId} [public/internal]' to post this to the ticket.`);
                } else if (!req.body.event.bot_id) { // ignore bot messages gracefully
                    await publishMessage(channel, `No new summary available for ticket ${ticketId}.`);
                }
            }
            // --- 2B. Publish Command: 'publish <ticket_id> <public/internal>' ---
            else if (publishMatch) {
                const ticketId = publishMatch[1];
                const isPublic = publishMatch[2].toLowerCase() === 'public';
                const cachedTicket = ticketCache.getTicket(ticketId);

                if (cachedTicket && cachedTicket.aiSummary) {
                    try {
                        await updateZendeskTicket(ticketId, cachedTicket.aiSummary, isPublic);
                        await publishMessage(channel, `✅ Successfully published the summary to Zendesk ticket ${ticketId} as a ${isPublic ? 'public' : 'internal'} comment.`);
                    } catch (publishErr) {
                        console.error(`Failed to publish ticket ${ticketId} from Slack:`, publishErr);
                        await publishMessage(channel, `❌ Failed to publish to Zendesk ticket ${ticketId}. Error: ${publishErr.message}`);
                    }
                } else if (!req.body.event.bot_id) {
                    await publishMessage(channel, `Could not find a cached summary for ticket ${ticketId}.`);
                }
            }
            // --- 2C. Fallback (Logging unrecognized text from users) ---
            else if (!req.body.event.bot_id) {
                console.log("Received non-command message event");
            }
            return res.status(200).json({ message: "Event received" });
        }

        console.log("Received other confirmation event:", JSON.stringify(req.body));
        res.status(200).json({ message: "Event received" });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: err.message });
    }
});

module.exports = router;
