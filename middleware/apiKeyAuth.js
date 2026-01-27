/**
 * FH HMAC Signature Authentication Middleware
 * 
 * Validates incoming requests by verifying HMAC signature
 * in the request headers (Fh-Signature header)
 * 
 * Secret key should be stored in environment variable FH_SECRET_KEY
 */

const crypto = require('crypto');

const apiKeyAuth = (req, res, next) => {
  // Get the signature from the request headers
  const signature = req.headers["fh-signature"];

  // Check if signature is provided
  if (!signature) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "Signature is required. Please provide it in the 'Fh-Signature' header."
    });
  }

  // Get secret key from environment variable
  const secretKey = process.env.FH_SECRET_KEY;

  if (!secretKey) {
    return res.status(500).json({
      error: "Internal Server Error",
      message: "FH_SECRET_KEY is not configured."
    });
  }

  // Get the raw request body
  const data = JSON.stringify(req.body);

  // Calculate expected signature using HMAC SHA256
  const expectedSignature = crypto
    .createHmac('sha256', secretKey)
    .update(data)
    .digest('hex');

  // Validate the provided signature
  if (signature !== expectedSignature) {
    return res.status(403).json({
      error: "Forbidden",
      message: "Invalid signature."
    });
  }

  // Signature is valid, proceed to next middleware/route
  next();
};

module.exports = apiKeyAuth;
