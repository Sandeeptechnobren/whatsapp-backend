const express = require("express");
const router  = express.Router();
const ctrl    = require("../controllers/paymentController");
const { auth } = require("../middleware/auth");

router.post("/request",            auth, ctrl.requestPayment);
router.get( "/my",                 auth, ctrl.myPayments);
router.get( "/instance/:instanceId", auth, ctrl.instancePayments);

module.exports = router;
