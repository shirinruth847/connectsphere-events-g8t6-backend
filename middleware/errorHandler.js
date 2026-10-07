function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  const candidateStatus = error.statusCode || error.status;
  const status = Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus < 500
    ? candidateStatus
    : 500;

  console.error('[http] request failed', {
    method: req.method,
    path: req.path,
    status,
    errorName: error.name,
  });

  return res.status(status).json({
    message:
      status >= 500
        ? 'Internal server error.'
        : error.publicMessage || 'Request could not be completed.',
  });
}

module.exports = errorHandler;