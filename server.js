const express = require("express");
const dotenv = require("dotenv");
const { WebClient, LogLevel } = require("@slack/web-api");
const apiKeyAuth = require("./middleware/apiKeyAuth");
const { generalLimiter, messagingLimiter } = require("./middleware/rateLimiter");
dotenv.config();

const app = express();
app.use(express.json());

// Apply API key authentication middleware to all endpoints
app.use(apiKeyAuth);

// Apply general rate limiting to all routes
app.use(generalLimiter);

const FIREHYDRANT_API_KEY = process.env.FIREHYDRANT_API_KEY;
const FIREHYDRANT_API_BASE = process.env.FIREHYDRANT_API_BASE;
const ZENDESK_API_KEY = process.env.ZENDESK_API_KEY;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const SLACK_BOT_TOKEN = process.env.Slack_BOT_TOKEN;
//zendesk auth specifically
const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_KEY}`).toString('base64');

//declaring webclient for slackk bot
const client = new WebClient(SLACK_BOT_TOKEN, {
  // LogLevel can be imported and used to make debugging simpler
  logLevel: LogLevel.DEBUG
});

//helper for fh requests since we do a lot
async function fhRequest(endpoint, method = "GET", body = null) {
  const res = await fetch(`${FIREHYDRANT_API_BASE}${endpoint}`, {
    method,
    headers: {
      "Authorization": `Bearer ${FIREHYDRANT_API_KEY}`,
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


// --- Push Update to Zendesk Ticket ---
app.post("/update-zendesk-ticket", async (req, res) => {
  try {
    console.log(req.body);
    const { incident_id, comment_body,view} = JSON.parse(req.body.data.payload);
    const incident = await fhRequest(`/incidents/${incident_id}`);
    const ticket_ids = incident.custom_fields.find(field => field.display_name === "Zendesk Ticket IDs")?.value;
    if (!ticket_ids || !comment_body) {
      return res.status(400).json({ error: "ticket_ids and comment_body are required." });
    }

    // Parse ticket IDs from comma-separated string "49,48,47"
    const ticketIdArray = ticket_ids.split(',').map(id => id.trim()).filter(id => id);

    if (ticketIdArray.length === 0) {
      return res.status(400).json({ error: "No valid ticket IDs provided." });
    }

    console.log(`Updating ${ticketIdArray.length} Zendesk ticket(s): ${ticketIdArray.join(', ')}`);

    // Prepare the authentication credentials

    // Prepare the ticket update body
    const updateBody = {
      ticket: {
        comment: {
          body: comment_body,
          public: view,
          ...(author_id && { author_id })
        }
      }
    };

    // Update all tickets
    const results = [];
    const errors = [];

    console.log('Update body:', JSON.stringify(updateBody, null, 2));

    for (const ticketId of ticketIdArray) {
      try {
        console.log(`Attempting to update ticket ${ticketId}...`);
        const response = await fetch(
          `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}.json`,
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
          const errorText = await response.text();
          console.error(`Ticket ${ticketId} failed:`, response.status, errorText);
          errors.push({ ticket_id: ticketId, error: `${response.status}: ${errorText}` });
        } else {
          const result = await response.json();
          console.log(`Ticket ${ticketId} updated successfully`);
          results.push({ ticket_id: ticketId, success: true, data: result });
        }
      } catch (err) {
        console.error(`Ticket ${ticketId} exception:`, err);
        errors.push({ ticket_id: ticketId, error: err.message });
      }
    }

    // Return summary of results
    const responseData = {
      total: ticketIdArray.length,
      successful: results.length,
      failed: errors.length,
      results,
      ...(errors.length > 0 && { errors })
    };

    const statusCode = errors.length === ticketIdArray.length ? 500 : 200;

    return res.status(statusCode).json({
      message: `Updated ${results.length} of ${ticketIdArray.length} ticket(s)`,
      ...responseData
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});


// Post a message to a channel your app is in using ID and message text
async function publishMessage(id, text) {
  try {
    // Call the chat.postMessage method using the built-in WebClient
    const result = await client.chat.postMessage({
      // The token you used to initialize your app
      token: process.env.Slack_BOT_TOKEN,
      channel: id,
      text: text
      // You could also use a blocks[] array to send richer content
    });

    // Print result, which includes information about the message (like TS)
    console.log(result);
  }
  catch (error) {
    console.error(error);
  }
}

//send ai summary message to ticket owner through slack
app.post("/send-update-message", messagingLimiter, async (req, res) => {
  try {
    //iterate over ticket ids and get owner id for each ticket
    var { ticket_ids, updateBody } = req.body;
    console.log(ticket_ids)
    ticket_ids = ticket_ids.toString();
    const ticketIdArray = ticket_ids.split(',').map(id => id.trim()).filter(id => id);
      for (const ticket_id of ticketIdArray) {
        const ticket = await fetch(
          `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticket_id}`,
           {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Basic ${auth}`
            }
          }
        );
        const owner_email = ticket.assignee_email;
        try{
          const slack_response = await client.users.lookupByEmail(
            {
              email: owner_email
            }
          );
            const owner_id = slack_response.user.id;
            //send messange to each owner of the ticket
            await publishMessage(owner_id, updateBody);
        } catch (error) {
          await publishMessage("U09DZTJGRBJ", updateBody); //fallback to otis user id for presentation on 12/5/2025
        }
      //send the FH update message including ai incident summary to the ticket owner via slack
      return res.status(200).json({ message: `Message sent to channel '${owner_email}'` });
      }
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: err.message });
    }
  });
// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));