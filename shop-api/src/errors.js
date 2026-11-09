class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message, details) => new ApiError(400, 'BAD_REQUEST', message, details);
const notFound = (message = 'Not found') => new ApiError(404, 'NOT_FOUND', message);

module.exports = { ApiError, badRequest, notFound };
