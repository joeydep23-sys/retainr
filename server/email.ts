import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY!);

export async function sendDunningEmail(
  to: string,
  subject: string,
  body: string
) {
  try {
    await resend.emails.send({
      from: 'Retainr <noreply@yourdomain.com>',
      to,
      subject,
      html: body,
    });
    console.log('📧 Email sent to:', to);
    return true;
  } catch (error) {
    console.error('❌ Email failed:', error);
    return false;
  }
}
