// An error whose message is safe to show to the user and store in uploads.error.
// Anything that is not a UserError is replaced by a generic message, because
// library errors (e.g. JSON.parse) can quote fragments of the uploaded text.
// Usage: `throw new UserError("This file is empty.")` for expected, explainable problems.
class UserError extends Error {}

module.exports = { UserError };
