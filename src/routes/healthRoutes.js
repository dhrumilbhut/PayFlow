const express = require('express');
const router = express.Router();
const healthController = require('../controllers/healthController');

router.get('/', healthController.liveness);
router.get('/dependencies', healthController.dependencies);

module.exports = router;
