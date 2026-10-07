function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body must be valid JSON.', code: 'INVALID_JSON' });
  }
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large.', code: 'PAYLOAD_TOO_LARGE' });
  }

  const candidateStatus = error.statusCode || error.status;
  const status = Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus < 500
    ? candidateStatus
    : 500;
  const message = status >= 500
    ? 'Internal Server Error'
    : error.publicMessage || 'Request could not be completed.';

  console.error('[http] request failed', {
    method: req.method,
    path: req.path,
    status,
    errorName: error.name,
  });

  return res.status(status).json({
    error: message,
    code: status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED',
  });
}

module.exports = errorHandler;
