/**
 * Rate Limiting Middleware
 * 
 * Applies rate limiting to prevent abuse of the API endpoints
 * Uses express-rate-limit to limit requests per IP address
 */

const rateLimit = require("express-rate-limit");

// General rate limiter: 30 requests per 15 minutes per IP
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // limit each IP to 30 requests per windowMs
  message: "Too many requests from this IP, please try again later.",
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

// Stricter rate limiter for messaging endpoints: 10 requests per minute per IP
const messagingLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10, // limit each IP to 10 requests per windowMs
  message: "Too many messaging requests from this IP, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  generalLimiter,
  messagingLimiter
};
