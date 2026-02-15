import { pgTable, text, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { relations } from "drizzle-orm";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  stripeAccountId: text("stripe_account_id"),
  isConnected: boolean("is_connected").default(false),
  subscriptionStatus: text("subscription_status").default("trial"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const failedPayments = pgTable("failed_payments", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  stripePaymentIntentId: text("stripe_payment_intent_id").notNull(),
  stripeCustomerId: text("stripe_customer_id").notNull(),
  customerEmail: text("customer_email").notNull(),
  amount: integer("amount").notNull(),
  currency: text("currency").notNull(),
  status: text("status").default("failed"),
  failureReason: text("failure_reason"),
  attemptCount: integer("attempt_count").default(0),
  nextRetryAt: timestamp("next_retry_at"),
  createdAt: timestamp("created_at").defaultNow(),
  recoveredAt: timestamp("recovered_at"),
});

export const dunningLogs = pgTable("dunning_logs", {
  id: serial("id").primaryKey(),
  failedPaymentId: integer("failed_payment_id").notNull(),
  sentAt: timestamp("sent_at").defaultNow(),
  emailTemplate: text("email_template").notNull(),
  status: text("status").default("sent"),
});

export const emailTemplates = pgTable("email_templates", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  type: text("type").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  isEnabled: boolean("is_enabled").default(true),
});

export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true });

export type User = typeof users.$inferSelect;
export type FailedPayment = typeof failedPayments.$inferSelect;
export type DunningLog = typeof dunningLogs.$inferSelect;
export type EmailTemplate = typeof emailTemplates.$inferSelect;
