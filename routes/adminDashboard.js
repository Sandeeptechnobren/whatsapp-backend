const express = require('express');
const router = express.Router();
const DasboardController = require('../controllers/adminDashboardController');
const { auth } = require("../middleware/auth");

router.post('/instanceList',auth,DasboardController.listInstances);
router.post('/instanceStatistics',auth,DasboardController.instanceStatistics);
module.exports=router;