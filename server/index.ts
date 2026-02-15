import express from 'express';
import { db } from './db';
import * as dotenv from 'dotenv';
import { setupRoutes } from './routes';

dotenv.config();

const app = express();
const PORT = 3000;

// Webhook route needs raw body - setup routes handles this
setupRoutes(app);

// Regular JSON parsing for other routes
app.use(express.json());

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
