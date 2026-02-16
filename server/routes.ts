import express, { type Request, Response } from 'express';
import Stripe from 'stripe';
import { db } from './db';
import { users, failedPayments, emailTemplates, dunningLogs, insertUserSchema } from '../shared/schema';
import { eq, and, desc } from 'drizzle-orm';
import { sendDunningEmail as sendEmail } from './email';
import { createUser, authenticateUser } from './auth';
import { requireAuth, requireActiveSubscription } from './middleware';
import { logger } from './logger';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-11-20.acacia',
});

function serveHTML(filename: string, res: Response, fallback: string = '') {
  const paths = [
    join(process.cwd(), 'client/src/pages', filename),
    join('/opt/render/project/src/client/src/pages', filename),
    join(__dirname, '../client/src/pages', filename),
  ];
  
  for (const path of paths) {
    if (existsSync(path)) {
      const html = readFileSync(path, 'utf-8');
      return res.send(html);
    }
  }
  
  if (fallback) {
    return res.send(fallback);
  }
  
  res.status(404).send('Page not found');
}

export function setupRoutes(app: express.Application) {
  
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // Landing page
  app.get('/', (req, res) => {
    const fallback = `
      <!DOCTYPE html>
      <html>
      <head><title>Retainr</title>
      <style>
        body { font-family: system-ui; margin: 0; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; min-height: 100vh; display: flex; align-items: center; justify-content: center; text-align: center; }
        h1 { font-size: 48px; margin-bottom: 20px; }
        a { background: white; color: #667eea; padding: 16px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 0 10px; }
      </style></head>
      <body>
        <div>
          <h1>💳 Retainr</h1>
          <p style="font-size: 24px; margin-bottom: 40px;">Recover failed Stripe payments automatically</p>
          <a href="/register">Start Free Trial</a>
          <a href="/login">Login</a>
        </div>
      </body>
      </html>
    `;
    serveHTML('landing.html', res, fallback);
  });

  // Register page
  app.get('/register', (req, res) => {
    if (req.session.userId) return res.redirect('/dashboard');
    const fallback = `
      <!DOCTYPE html>
      <html><head><title>Sign Up</title>
      <style>
        body { font-family: system-ui; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .form { background: white; padding: 40px; border-radius: 12px; max-width: 400px; width: 100%; }
        input { width: 100%; padding: 12px; margin-bottom: 16px; border: 1px solid #ddd; border-radius: 6px; font-size: 16px; box-sizing: border-box; }
        button { width: 100%; padding: 14px; background: #667eea; color: white; border: none; border-radius: 6px; font-size: 16px; font-weight: bold; cursor: pointer; }
      </style></head>
      <body>
        <div class="form">
          <h1>Create Account</h1>
          <form id="form">
            <input type="email" id="email" placeholder="Email" required>
            <input type="password" id="password" placeholder="Password (min 8 chars)" required>
            <button type="submit">Sign Up</button>
          </form>
          <div id="error" style="color: red; margin-top: 10px;"></div>
        </div>
        <script>
          document.getElementById('form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const res = await fetch('/api/register', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                email: document.getElementById('email').value,
                password: document.getElementById('password').value
              })
            });
            if (res.ok) window.location.href = '/dashboard';
            else document.getElementById('error').textContent = (await res.json()).error;
          });
        </script>
      </body></html>
    `;
    serveHTML('register.html', res, fallback);
  });

  // Login page
  app.get('/login', (req, res) => {
    if (req.session.userId) return res.redirect('/dashboard');
    const fallback = `
      <!DOCTYPE html>
      <html><head><title>Login</title>
      <style>
        body { font-family: system-ui; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .form { background: white; padding: 40px; border-radius: 12px; max-width: 400px; width: 100%; }
        input { width: 100%; padding: 12px; margin-bottom: 16px; border: 1px solid #ddd; border-radius: 6px; font-size: 16px; box-sizing: border-box; }
        button { width: 100%; padding: 14px; background: #667eea; color: white; border: none; border-radius: 6px; font-size: 16px; font-weight: bold; cursor: pointer; }
      </style></head>
      <body>
        <div class="form">
          <h1>Welcome Back</h1>
          <form id="form">
            <input type="email" id="email" placeholder="Email" required>
            <input type="password" id="password" placeholder="Password" required>
            <button type="submit">Login</button>
          </form>
          <div id="error" style="color: red; margin-top: 10px;"></div>
        </div>
        <script>
          document.getElementById('form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const res = await fetch('/api/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                email: document.getElementById('email').value,
                password: document.getElementById('password').value
              })
            });
            if (res.ok) window.location.href = '/dashboard';
            else document.getElementById('error').textContent = (await res.json()).error;
          });
        </script>
      </body></html>
    `;
    serveHTML('login.html', res, fallback);
  });

  // Dashboard page (simplified inline version)
  app.get('/dashboard', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.send(`
      <!DOCTYPE html>
      <html><head><title>Dashboard</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: system-ui; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
        .header { background: white; padding: 20px; margin-bottom: 20px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; }
        button { background: #667eea; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; }
        .logout { background: #dc2626; }
        .upgrade { background: #3b82f6; font-size: 16px; padding: 12px 24px; }
        .banner { background: #dbeafe; border: 2px solid #3b82f6; padding: 20px; border-radius: 8px; margin-bottom: 20px; text-align: center; }
      </style></head>
      <body>
        <div class="container">
          <div class="header">
            <h1>💳 Retainr Dashboard</h1>
            <button class="logout" onclick="logout()">Logout</button>
          </div>
          <div class="banner">
            <h3>🎉 Welcome to Retainr!</h3>
            <p>Your 14-day free trial is active</p>
            <button class="upgrade" onclick="upgrade()">Upgrade to Pro - $49/mo</button>
          </div>
          <div style="background: white; padding: 20px; border-radius: 8px;">
            <h2>Dashboard Stats</h2>
            <p>Connect your Stripe account to start recovering failed payments</p>
          </div>
        </div>
        <script>
          async function upgrade() {
            const res = await fetch('/api/stripe/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
            const data = await res.json();
            if (data.url) window.location.href = data.url;
          }
          async function logout() {
            await fetch('/api/logout', { method: 'POST' });
            window.location.href = '/';
          }
        </script>
      </body></html>
    `);
  });

  // AUTH ROUTES
  app.post('/api/register', express.json(), async (req, res) => {
    try {
      const parsed = insertUserSchema.parse(req.body);
      const existing = await db.query.users.findFirst({ where: eq(users.email, parsed.email) });
      if (existing) return res.status(400).json({ error: 'Email already registered' });
      
      const user = await createUser(parsed.email, parsed.password);
      req.session.userId = user.id;
      logger.info({ userId: user.id }, 'User registered');
      res.status(201).json(user);
    } catch (error: any) {
      logger.error({ error }, 'Registration error');
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  app.post('/api/login', express.json(), async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
      
      const user = await authenticateUser(email, password);
      if (!user) return res.status(401).json({ error: 'Invalid credentials' });
      
      req.session.userId = user.id;
      logger.info({ userId: user.id }, 'User logged in');
      res.json(user);
    } catch (error) {
      logger.error({ error }, 'Login error');
      res.status(500).json({ error: 'Login failed' });
    }
  });

  app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
      if (err) return res.status(500).json({ error: 'Logout failed' });
      res.json({ success: true });
    });
  });

  app.get('/api/user', requireAuth, async (req, res) => {
    try {
      const user = await db.query.users.findFirst({
        where: eq(users.id, req.session.userId!),
        columns: { id: true, email: true, subscriptionStatus: true, stripeAccountId: true, trialEndsAt: true },
      });
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.json(user);
    } catch (error) {
      logger.error({ error }, 'Get user error');
      res.status(500).json({ error: 'Failed to fetch user' });
    }
  });

  // SUBSCRIPTION
  app.post('/api/stripe/checkout', requireAuth, express.json(), async (req, res) => {
    try {
      const user = await db.query.users.findFirst({ where: eq(users.id, req.session.userId!) });
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (!process.env.STRIPE_PRICE_ID) return res.status(500).json({ error: 'Stripe price not configured' });

      const session = await stripe.checkout.sessions.create({
        customer_email: user.email,
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
        subscription_data: {
          trial_period_days: 14,
          metadata: { userId: user.id.toString() },
        },
        success_url: `${process.env.BASE_URL}/dashboard?checkout=success`,
        cancel_url: `${process.env.BASE_URL}/dashboard`,
        metadata: { userId: user.id.toString() },
      });

      logger.info({ userId: user.id }, 'Checkout session created');
      res.json({ url: session.url });
    } catch (error) {
      logger.error({ error }, 'Checkout error');
      res.status(500).json({ error: 'Failed to create checkout' });
    }
  });

  // Webhook
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
    const sig = req.headers['stripe-signature'];
    if (!sig) return res.status(400).send('Missing signature');

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
    } catch (err: any) {
      logger.error({ error: err.message }, 'Webhook verification failed');
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    logger.info({ type: event.type }, 'Webhook received');
    
    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = parseInt(session.metadata?.userId || '0');
        if (userId) {
          await db.update(users).set({ subscriptionStatus: 'active', subscriptionId: session.subscription as string }).where(eq(users.id, userId));
          logger.info({ userId }, 'Subscription activated');
        }
      }
      res.json({ received: true });
    } catch (error: any) {
      logger.error({ error }, 'Webhook processing error');
      res.status(500).send(`Error: ${error.message}`);
    }
  });
}
