const express = require("express");
const router = express.Router();
const controller = require("../controllers/instanceController");
const { auth } = require("../middleware/auth");

// Routes that require authentication
router.post("/", auth, controller.createInstance);
router.get("/list/Instances", auth, controller.listInstances);
router.post("/:id/webhook", auth, controller.setWebhook);
router.delete("/:id", auth, controller.deleteInstance);
router.delete("/:id/logout", auth, controller.logoutInstance);

// Routes that are free (no auth required)
router.get("/:id/qr", controller.getQr);
router.get("/:id/qr.png", controller.getQrPng);
router.post("/:id/send", controller.sendMessage);
router.get("/:id/status", controller.getStatus);

module.exports = router;
