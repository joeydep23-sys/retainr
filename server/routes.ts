import express, { type Request, Response } from 'express';
import Stripe from 'stripe';
import { db } from './db';
import { users, failedPayments, emailTemplates, dunningLogs } from '../shared/schema';
import { eq, and } from 'drizzle-orm';
import { sendDunningEmail as sendEmail } from './email';
import { readFileSync } from 'fs';
import { join } from 'path';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-11-20.acacia',
});

export function setupRoutes(app: express.Application) {
  
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // Payment update page
  app.get('/payment/:id', (req, res) => {
    const html = readFileSync(join(process.cwd(), 'client/src/pages/payment-page.html'), 'utf-8');
    res.send(html);
  });

  // Update payment method
  app.post('/api/public/payment/:id/update', express.json(), async (req, res) => {
    const { paymentMethodId } = req.body;
    const paymentId = parseInt(req.params.id);

    const payment = await db.query.failedPayments.findFirst({
      where: eq(failedPayments.id, paymentId),
    });

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    try {
      await stripe.customers.update(payment.stripeCustomerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });

      await stripe.paymentIntents.confirm(payment.stripePaymentIntentId);

      await db.update(failedPayments)
        .set({ status: 'recovered', recoveredAt: new Date() })
        .where(eq(failedPayments.id, paymentId));

      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Stripe webhook
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

    if (!sig || !webhookSecret) {
      return res.status(400).send('Missing signature');
    }

    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err: any) {
      console.error('❌ Webhook verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log('✅ Received webhook:', event.type);

    try {
      switch (event.type) {
        case 'payment_intent.payment_failed':
          await handlePaymentFailed(event.data.object as Stripe.PaymentIntent);
          break;
        case 'payment_intent.succeeded':
          await handlePaymentSucceeded(event.data.object as Stripe.PaymentIntent);
          break;
        default:
          console.log('ℹ️  Unhandled:', event.type);
      }
      res.json({ received: true });
    } catch (error: any) {
      console.error('❌ Error processing webhook:', error);
      res.status(500).send(`Error: ${error.message}`);
    }
  });
}

async function handlePaymentFailed(paymentIntent: Stripe.PaymentIntent) {
  console.log('💳 Processing failed payment:', paymentIntent.id);

  const connectedAccountId = paymentIntent.on_behalf_of as string | null;
  
  if (!connectedAccountId) {
    console.error('❌ No connected account');
    return;
  }

  const user = await db.query.users.findFirst({
    where: eq(users.stripeAccountId, connectedAccountId),
  });

  if (!user) {
    console.error('❌ User not found');
    return;
  }

  let customerEmail = paymentIntent.receipt_email;
  if (!customerEmail && paymentIntent.customer) {
    const customer = await stripe.customers.retrieve(paymentIntent.customer as string);
    if (customer && !customer.deleted) {
      customerEmail = customer.email || null;
    }
  }

  if (!customerEmail) {
    console.error('❌ No email');
    return;
  }

  const existing = await db.query.failedPayments.findFirst({
    where: eq(failedPayments.stripePaymentIntentId, paymentIntent.id),
  });

  if (existing) {
    await db.update(failedPayments)
      .set({ attemptCount: existing.attemptCount + 1 })
      .where(eq(failedPayments.id, existing.id));
    return;
  }

  const [failedPayment] = await db.insert(failedPayments).values({
    userId: user.id,
    stripePaymentIntentId: paymentIntent.id,
    stripeCustomerId: paymentIntent.customer as string,
    customerEmail: customerEmail,
    amount: paymentIntent.amount,
    currency: paymentIntent.currency,
    status: 'failed',
    failureReason: paymentIntent.last_payment_error?.message || null,
    attemptCount: 1,
    nextRetryAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }).returning();

  console.log('✅ Created failed payment:', failedPayment.id);

  await sendDunningEmail(failedPayment.id, user.id);
}

async function handlePaymentSucceeded(paymentIntent: Stripe.PaymentIntent) {
  const failedPayment = await db.query.failedPayments.findFirst({
    where: eq(failedPayments.stripePaymentIntentId, paymentIntent.id),
  });

  if (failedPayment && failedPayment.status === 'failed') {
    await db.update(failedPayments)
      .set({ status: 'recovered', recoveredAt: new Date() })
      .where(eq(failedPayments.id, failedPayment.id));
    console.log('🎉 Payment recovered:', failedPayment.id);
  }
}

async function sendDunningEmail(failedPaymentId: number, userId: number) {
  const payment = await db.query.failedPayments.findFirst({
    where: eq(failedPayments.id, failedPaymentId),
  });

  if (!payment) return;

  const template = await db.query.emailTemplates.findFirst({
    where: and(
      eq(emailTemplates.userId, userId),
      eq(emailTemplates.type, 'first_failure'),
      eq(emailTemplates.isEnabled, true)
    ),
  });

  if (!template) {
    console.log('⚠️  No template, skipping email');
    return;
  }

  const updateLink = `${process.env.BASE_URL}/payment/${failedPaymentId}`;
  
  const emailBody = template.body
    .replace(/\{\{updateLink\}\}/g, updateLink)
    .replace(/\{\{amount\}\}/g, `$${(payment.amount / 100).toFixed(2)}`)
    .replace(/\{\{customerEmail\}\}/g, payment.customerEmail);

  await sendEmail(payment.customerEmail, template.subject, emailBody);

  await db.insert(dunningLogs).values({
    failedPaymentId: payment.id,
    emailTemplate: template.type,
    status: 'sent',
  });
}
