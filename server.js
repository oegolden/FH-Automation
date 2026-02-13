const express = require("express");
const dotenv = require("dotenv");
const { WebClient, LogLevel } = require("@slack/web-api");
const fh_auth = require("./middleware/auth");
const { generalLimiter, messagingLimiter } = require("./middleware/rateLimiter");
dotenv.config();

const app = express();

// Trust proxy - required when behind reverse proxy/load balancer (e.g., Docker, nginx)
app.set('trust proxy', true);

// Middleware to capture raw body for signature verification
app.use(express.json({
  verify: (req, res, buf, encoding) => {
    req.rawBody = buf.toString('utf8');
  }
}));

// Apply API key authentication middleware to all endpoints
// REF: Removed global auth to allow for public/Slack endpoints
// app.use(fh_auth);

// Apply general rate limiting to all routes
app.use(generalLimiter);

const FIREHYDRANT_API_KEY = process.env.FIREHYDRANT_API_KEY;
const FIREHYDRANT_API_BASE = process.env.FIREHYDRANT_API_BASE;
const ZENDESK_API_KEY = process.env.ZENDESK_API_KEY;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const SLACK_BOT_TOKEN = process.env.Slack_BOT_TOKEN;
const FIREHYDRANT_AUDIENCE_ID = process.env.FIREHYDRANT_AUDIENCE_ID;
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
      "Authorization": `${FIREHYDRANT_API_KEY}`,
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

// Helper to find and clean incident summary
async function getCleanedIncidentSummary(incident_id) {
  if (!FIREHYDRANT_AUDIENCE_ID) {
    throw new Error("FIREHYDRANT_AUDIENCE_ID is not set in environment variables");
  }

  console.log(`Fetching summary for Audience ID: ${FIREHYDRANT_AUDIENCE_ID} and Incident ID: ${incident_id}`);

  try {
    const endpoint = `/audiences/${FIREHYDRANT_AUDIENCE_ID}/summaries/${incident_id}`;
    console.log(`Requesting FH Endpoint: ${endpoint}`);
    const response = await fhRequest(endpoint);

    // The instructions say "find the content in the 'content' key"
    let content = "";
    if (response && response.content) {
      content = response.content;
    } else {
      console.warn(`No content found in summary response for incident ${incident_id}`, response);
      return "No Incident Summary Available";
    }

    // Cleanup logic: removing common markdown symbols like #
    // User specifically asked to remove "#"s
    content = content.replace(/#/g, '').trim();

    return content;
  } catch (err) {
    console.error(`Error fetching summary for incident ${incident_id}:`, err);
    throw err;
  }
}

// Function to parse multiple ticket IDs from response body
function parseTicketIds(responseBody) {
  const ticketIds = [];
  const data = responseBody.data;
  if (data && data.length > 0) {
    data.forEach(item => {
      // Check for the CustomerSupportIssue type and extract the remote_id
      if (item.type === 'Integrations::CustomerSupportIssue' && item.attributes && item.attributes.remote_id) {
        ticketIds.push(item.attributes.remote_id);
      }
    });
  }
  return ticketIds;
}

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

// --- Push Update to Zendesk Ticket ---
// Added fh_auth middleware specifically to this route
app.post("/update-zendesk-ticket", fh_auth, async (req, res) => {
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
    // Fetch and clean the summary from FH Audience API
    const comment_body = await getCleanedIncidentSummary(incident_id);

    // Prepare the authentication credentials

    // Prepare the ticket update body
    const updateBody = {
      ticket: {
        comment: {
          body: comment_body,
          public: view,
          // ...(author_id && { author_id })
        }
      }
    };
    console.log('Update body:', JSON.stringify(updateBody, null, 2));

    try {
      console.log(`Attempting to update ticket ${ticket_id}...`);
      const response = await fetch(
        `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticket_id}.json`,
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
        console.error(`Failed to update ticket ${ticket_id}: ${response.status} ${text}`);
      } else {
        console.log(`Successfully updated ticket ${ticket_id}`);
      }

    }
    catch (err) {
      console.error(`Ticket ${ticket_id} exception:`, err);
    }
    res.status(200).json({ message: "Ticket update processed" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


//send ai summary message to ticket owner through slack
// Added fh_auth middleware specifically to this route
app.post("/send-update-message", fh_auth, messagingLimiter, async (req, res) => {
  try {
    var { incident_id } = req.body;

    // Fetch the updated body from Audience API
    const updateBody = await getCleanedIncidentSummary(incident_id);

    const incident_links = await fhRequest(`/incidents/${incident_id}/attachments`);
    const ticket_ids = parseTicketIds(incident_links);
    console.log(ticket_ids);
    if (!ticket_ids) {
      return res.status(400).json({ error: "No valid ticket IDs provided." });
    }
    for (const ticket_id of ticket_ids) {
      // Use side-loading to get users (including assignee) along with the ticket
      const ticketResponse = await fetch(
        `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticket_id}.json?include=users`,
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
      // Find the user object matching the assignee_id
      const assigneeUser = users.find(u => u.id === assigneeId);

      if (!assigneeUser || !assigneeUser.email) {
        console.warn(`No assignee or email found for ticket ${ticket_id}, skipping Slack notification.`);
        continue;
      }

      const owner_email = assigneeUser.email;

      try {
        const slack_response = await client.users.lookupByEmail(
          {
            email: owner_email
          }
        );
        const owner_id = slack_response.user.id;
        const commandMessage =
          `${updateBody}\n\n` +
          `----------------------------------------------------------------\n` +
          `*Action Required:*\n` +
          `Please run the following command in the incident channel to update ticket ${ticket_id} with the above AI generated incident summary:\n` +
          `/fh update-zendesk-ticket [public/internal] ${ticket_id}\n` +
          `ignore this message if you do not wish to send the ai generated summary to the ticket`;
        await publishMessage(owner_id, commandMessage);
      } catch (error) {
        console.error(`Slack lookup failed for ${owner_email}:`, error);
        // Continue to next ticket instead of hard failing the request
        continue;
      }
      //send the FH update message including ai incident summary to the ticket owner via slack
      console.log(`Message sent to channel '${owner_email}'`);
    }
    return res.status(200).json({ message: "Update messages processed." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// Added fh_auth middleware specifically to this route
app.post("/attach-status-page", fh_auth, async (req, res) => {
  try {
    console.log(req.body);
    const { incident_id, incident_title } = req.body.data.payload;
    if (!incident_id) {
      return res.status(400).json({ error: "incident_id is required." });
    }

    // Get the statuspage name from environment variables
    const statusPageName = process.env.STATUS_PAGE_NAME;
    if (!statusPageName) {
      return res.status(500).json({ error: "STATUS_PAGE_NAME environment variable is not set." });
    }
    // Find the integration id for the status page by name
    let data = await fhRequest("/nunc_connections");
    const pages = data.data;
    console.log("Fetched status pages:", pages);
    const targetPage = pages.find(
      p => p.company_name
    );
    if (!targetPage) {
      return res.status(404).json({ error: `No status page found with name '${cleaned_name}'.` });
    }

    //making payload to attatch incident to statuspage
    const attachBody = {
      integration_slug: "nunc",
      integration_id: targetPage.id,
      title: `${incident_title}`,
    };
    console.log("Attaching status page with body:", attachBody);
    const result = await fhRequest(`/incidents/${incident_id}/status_pages`, "POST", attachBody);

    return res.status(201).json({
      message: `Status page '${targetPage.company_name}' linked to incident ${incident_id}`,
      result
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

app.post("/update-confirmation", async (req, res) => {
  try {
    const { token, challenge, type } = req.body;

    // Handle Slack URL Verification Challenge
    if (type === 'url_verification') {
      console.log("Received Slack URL Verification Challenge");
      return res.status(200).send(challenge);
    }

    // Fallback for other potential events (logic can be added here later)
    console.log("Received update confirmation event:", JSON.stringify(req.body));
    res.status(200).json({ message: "Event received" });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});
// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));