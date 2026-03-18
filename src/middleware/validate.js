const { validationResult } = require('express-validator');
const ApiError = require('../utils/ApiError');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const details = errors.array().map((e) => ({
      field: e.path,
      message: e.msg,
    }));
    const message = details.map((e) => e.message).join(', ');
    return next(ApiError.badRequest(message, details));
  }
  next();
};

module.exports = validate;
