const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhookController');
const {
  validateWebhook,
  handleValidationErrors,
} = require('../validators/paymentValidator');

router.post('/', validateWebhook, handleValidationErrors, webhookController.handleWebhook);

module.exports = router;
