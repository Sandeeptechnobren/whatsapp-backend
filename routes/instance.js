const express = require("express");
const router = express.Router();
const controller = require("../controllers/instanceController");
const { auth } = require("../middleware/auth");

// Routes that require authentication
router.post("/create",  controller.createInstance);
router.post("/start",  controller.startInstance);
// router.post("/connect/:instance_name",  controller.connectInstance);
router.post("/connect/:instance_name", controller.connectInstance);
router.get("/details/:uuid",  controller.getInstanceDetails);
router.post("/list",  controller.listInstances);
router.post("/webhook/:id",  controller.setWebhook);
router.delete("/:id",  controller.deleteInstance);
router.delete("/logout/:id",  controller.logoutInstance);

// Routes that are free (no auth required)
router.get("/qr/:id", controller.getQr);
router.get("/qrpng/:id", controller.getQrPng);
router.post("/send/:id", controller.sendMessage);
router.get("/status/:id", controller.getStatus);

module.exports = router;