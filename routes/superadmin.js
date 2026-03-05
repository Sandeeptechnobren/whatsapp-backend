const express = require("express");
const router  = express.Router();
const ctrl    = require("../controllers/superadminController");
const { superAdmin } = require("../middleware/auth");

/* Stats */
router.get("/stats",                     superAdmin, ctrl.getStats);

/* Admins */
router.get("/admins",                    superAdmin, ctrl.getAllAdmins);
router.delete("/admins/:id",             superAdmin, ctrl.deleteAdmin);

/* Instances */
router.get("/instances",                 superAdmin, ctrl.getAllInstances);
router.post("/instances/:id/lock",       superAdmin, ctrl.lockInstance);
router.post("/instances/:id/unlock",     superAdmin, ctrl.unlockInstance);

/* Payments */
router.get("/payments",                  superAdmin, ctrl.getAllPayments);
router.post("/payments/:id/approve",     superAdmin, ctrl.approvePayment);
router.post("/payments/:id/reject",      superAdmin, ctrl.rejectPayment);

/* Seeding - create first superadmin (should be disabled in production) */
router.post("/seed",                     ctrl.createSuperAdmin);

module.exports = router;
