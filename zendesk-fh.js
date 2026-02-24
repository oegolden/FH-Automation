const express = require("express");
const fh_auth = require("./middleware/auth");
const ticketCache = require("./ticket-cache");

const router = express.Router();

const auth = Buffer.from(`${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_KEY}`).toString('base64');

async function fhRequest(endpoint, method = "GET", body = null) {
    const res = await fetch(`${process.env.FIREHYDRANT_API_BASE}${endpoint}`, {
        method,
        headers: {
            "Authorization": `${process.env.FIREHYDRANT_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: body ? JSON.stringify(body) : undefined
    });

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

    console.log(`Fetching summary for Audience ID: ${process.env.FIREHYDRANT_AUDIENCE_ID} and Incident ID: ${incident_id}`);

    try {
        const endpoint = `/audiences/${process.env.FIREHYDRANT_AUDIENCE_ID}/summaries/${incident_id}`;
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

async function updateZendeskTicket(ticket_id, comment_body, isPublic) {
    const updateBody = {
        ticket: {
            comment: {
                body: comment_body,
                public: isPublic,
            }
        }
    };

    console.log(`Attempting to update ticket ${ticket_id} with body:`, JSON.stringify(updateBody, null, 2));

    const response = await fetch(
        `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticket_id}.json`,
        {
            method: "PUT",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Basic ${auth}`
            },
            body: JSON.stringify(updateBody)
        }
    );

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to update ticket ${ticket_id}: ${response.status} ${text}`);
    }

    console.log(`Successfully updated ticket ${ticket_id}`);
    ticketCache.markUpdateSent(ticket_id);
    return response;
}


router.post("/update-zendesk-ticket", fh_auth, async (req, res) => {
    console.log(req.body);
    let payload = req.body.data ? req.body.data.payload : null;

    if (typeof payload === 'string') {
        try {
            payload = JSON.parse(payload);
        } catch (e) {
            console.error("Failed to parse payload string:", payload);
            return res.status(400).json({ error: "Invalid JSON in payload", details: e.message });
        }
    }

    if (!payload) {
        return res.status(400).json({ error: "Missing payload in request body" });
    }

    console.log('Parsed Payload:', JSON.stringify(payload, null, 2));

    const { ticket_id, incident_id } = payload;
    let view = false;
    if (payload.view == "public") {
        view = true;
    }
    if (!incident_id) {
        return res.status(400).json({ error: "incident_id is required in payload" });
    }

    try {
        const comment_body = await getCleanedIncidentSummary(incident_id);
        await updateZendeskTicket(ticket_id, comment_body, view);
        res.status(200).json({ message: "Ticket update processed" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = { router, updateZendeskTicket };
