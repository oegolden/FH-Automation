const express = require("express");
const dotenv = require("dotenv");
const fh_auth = require("./middleware/auth");
const { generalLimiter } = require("./middleware/rateLimiter");
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

app.use(require('./slack-fh'));
app.use(require('./zendesk-fh').router);

const FIREHYDRANT_API_KEY = process.env.FIREHYDRANT_API_KEY;
const FIREHYDRANT_API_BASE = process.env.FIREHYDRANT_API_BASE;


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


// --- Start server ---
const PORT = process.env.PORT || 8002;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));