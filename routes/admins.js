const express = require('express');
const router = express.Router();
const controller = require('../controllers/adminsController');

router.get('/', controller.listAdmins);
router.get('/:id', controller.getAdmin);
router.post('/create', controller.createAdmin);
router.put('/:id', controller.updateAdmin);
router.delete('/:id', controller.deleteAdmin);
router.post('/login', controller.loginAdmin);
module.exports = router; 
