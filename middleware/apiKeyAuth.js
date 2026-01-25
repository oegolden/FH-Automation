/**
 * API Key Authentication Middleware
 * 
 * Validates incoming requests by checking for a valid API key
 * in the request headers (x-api-key header)
 * 
 * API key should be stored in environment variable API_KEY
 */

const apiKeyAuth = (req, res, next) => {
  // Get the API key from the request headers
  const apiKey = req.headers["x-api-key"];

  // Check if API key is provided
  if (!apiKey) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "API key is required. Please provide it in the 'x-api-key' header."
    });
  }

  // Get valid API key from environment variable
  const validApiKey = process.env.API_KEY;

  // Validate the provided API key
  if (apiKey !== validApiKey) {
    return res.status(403).json({
      error: "Forbidden",
      message: "Invalid API key."
    });
  }

  // API key is valid, proceed to next middleware/route
  next();
};

module.exports = apiKeyAuth;
