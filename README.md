# Express + MySQL (XAMPP) CRUD Example

## Overview
Simple REST API with CRUD endpoints for a `users` table using Express and MySQL (works with XAMPP's MySQL).

## Setup
1. Install Node.js (v16+ recommended).
2. Start XAMPP and make sure MySQL is running.
3. Copy `.env.example` to `.env` and set your DB credentials.
4. Create the database and table:
   - Run the SQL in `sql/init.sql` (via phpMyAdmin or `mysql` CLI).
5. Install dependencies:
   ```bash
   npm install
   ```
6. Start the server:
   ```bash
   npm start
   ```
7. API endpoints (base `http://localhost:3000/api/users`):
   - `GET /` - list users
   - `GET /:id` - get user by id
   - `POST /` - create user (json: {name, email})
   - `PUT /:id` - update user
   - `DELETE /:id` - delete user

## Notes
- Uses `mysql2` package with promise API.
- Designed for clarity and easy extension.
