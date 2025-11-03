const express = require("express");
const router = express.Router();
const controller = require("../controllers/instanceController");
const { auth } = require("../middleware/auth");

// Routes that require authentication
router.post("/create", auth, controller.createInstance);
router.post("/start", auth, controller.startInstance);
router.get("/list", auth, controller.listInstances);
router.post("/webhook/:id", auth, controller.setWebhook);
router.delete("/:id", auth, controller.deleteInstance);
router.delete("/logout/:id", auth, controller.logoutInstance);

// Routes that are free (no auth required)
router.get("/qr/:id", controller.getQr);
router.get("/:id/qr.png", controller.getQrPng);
router.post("/send/:id", controller.sendMessage);
router.get("/status/:id", controller.getStatus);

module.exports = router;
