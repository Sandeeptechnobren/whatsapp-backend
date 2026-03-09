const express = require("express");
const router  = express.Router();
const ctrl    = require("../controllers/settingsController");

router.post("/ai",       ctrl.getAISettings);
router.put( "/ai",       ctrl.updateAISettings);
router.post("/ai/test",  ctrl.testAIConnection);

module.exports = router;
