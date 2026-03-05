const express = require("express");
const router  = express.Router();
const ctrl    = require("../controllers/instanceController");
const { trialCheck } = require("../middleware/trialCheck");

/* ── Instance Management ── */
router.post("/create",                   ctrl.createInstance);
router.post("/list",                     ctrl.listInstances);
router.post("/connect/:instance_name",   ctrl.connectInstance);
router.get( "/details/:uuid",            ctrl.getInstanceDetails);
router.post("/start",                    ctrl.startInstance);
router.post("/webhook/:id",              ctrl.setWebhook);
router.delete("/logout/:id",             ctrl.logoutInstance);
router.delete("/:id",                    ctrl.deleteInstance);

/* ── Status / QR (free from trial check, needed to connect) ── */
router.post("/status/:id",               ctrl.getStatus);
router.get( "/qr/:id",                   ctrl.getQr);
router.get( "/qrpng/:id",               ctrl.getQrPng);

/* ── Messaging (trial-checked) ── */
router.post("/send/:id",                 trialCheck, ctrl.sendMessage);
router.post("/send-media/:id",           trialCheck, ctrl.sendMedia);
router.post("/send-media-url/:id",       trialCheck, ctrl.sendMediaFromUrl);
router.post("/send-location/:id",        trialCheck, ctrl.sendLocation);

/* ── Chat APIs (trial-checked) ── */
router.post("/chats/:id",                trialCheck, ctrl.getChats);
router.post("/messages/:id/:chatId",     trialCheck, ctrl.getChatMessages);
router.post("/mark-read/:id",            trialCheck, ctrl.markChatRead);
router.post("/delete-message/:id",       trialCheck, ctrl.deleteMessage);
router.post("/react/:id",                trialCheck, ctrl.reactToMessage);

/* ── Contact APIs (trial-checked) ── */
router.post("/contacts/:id",             trialCheck, ctrl.getContacts);
router.post("/check-number/:id",         trialCheck, ctrl.checkNumber);
router.post("/profile-pic/:id",          trialCheck, ctrl.getProfilePic);
router.post("/account-info/:id",         trialCheck, ctrl.getAccountInfo);

/* ── Group APIs (trial-checked) ── */
router.post("/groups/:id",               trialCheck, ctrl.getGroups);
router.post("/create-group/:id",         trialCheck, ctrl.createGroup);
router.post("/group-add/:id",            trialCheck, ctrl.addGroupParticipants);
router.post("/group-remove/:id",         trialCheck, ctrl.removeGroupParticipants);
router.post("/group-leave/:id",          trialCheck, ctrl.leaveGroup);

module.exports = router;
