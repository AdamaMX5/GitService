import axios from 'axios';
import { config } from '../config.js';

export async function sendEmail({ to, subject, body, replyTo }) {
  if (!config.email.serviceUrl || !config.email.apiKey) {
    throw new Error('EmailService not configured');
  }
  const res = await axios.post(
    `${config.email.serviceUrl}/emails`,
    {
      to,
      subject,
      body,
      from: config.email.from,
      replyTo: replyTo || config.email.replyTo,
      isHtml: false,
      type: 'git-service-notification',
    },
    { headers: { 'X-API-Key': config.email.apiKey } }
  );
  return res.data;
}
