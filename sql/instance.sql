use express_crud_db;

CREATE TABLE instances (
    id INT(11) AUTO_INCREMENT PRIMARY KEY,
    admin_id INT(11) NOT NULL,                  -- Matches admins.id
    name VARCHAR(100) NOT NULL,
    token CHAR(36) NOT NULL UNIQUE DEFAULT (UUID()),
    session_data TEXT,
    qr_code TEXT,
    status ENUM('pending','ready','disconnected','error') DEFAULT 'pending',
    last_seen DATETIME DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL,
    CONSTRAINT fk_admin FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
) ENGINE=InnoDB;
