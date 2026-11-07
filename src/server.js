'use strict';
require('dotenv').config();
const app = require('./app');
if (!process.env.JWT_SECRET || !process.env.DATABASE_URL) { console.error('DATABASE_URL and JWT_SECRET must be set'); process.exit(1); }
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`LedgerLine listening on ${port}`));
