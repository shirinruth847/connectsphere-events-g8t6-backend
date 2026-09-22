const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { USER_ROLES } = require('../config/eventConstants');
const eventController = require('../controller/eventController');

const router = express.Router();

// Applied per route (not router-wide) so teammates can add coordinator routes here later.
const organiserOnly = [requireAuth, requireRole(USER_ROLES.ORGANISER)];

router.post('/', organiserOnly, eventController.createAndSubmit);
router.post('/drafts', organiserOnly, eventController.createDraft);
router.get('/mine', organiserOnly, eventController.getMyEvents); // must stay above '/:id'
router.get('/:id', organiserOnly, eventController.getEventById);
router.put('/:id/draft', organiserOnly, eventController.updateDraft);
router.put('/:id/submit', organiserOnly, eventController.submitDraft);

module.exports = router;