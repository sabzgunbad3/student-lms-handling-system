"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const axios_1 = __importDefault(require("axios"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const app = (0, express_1.default)();
app.use(express_1.default.json());
// In-Memory state for authenticated students
let authenticatedStudents = [];
// Hardcoded Master Admin Token
const ADMIN_TOKEN = 'hasnat2425';
// Hardcoded WhatsApp Webhook verification token
const WHATSAPP_VERIFY_TOKEN = 'hasnat';
// API Configuration loaded from environment variables
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const X_API_SECRET_KEY = process.env.X_API_SECRET_KEY || 'default-vps-secret-key-9988';
const VPS_URL = process.env.VPS_URL || 'http://localhost:3000';
console.log('Vercel Webhook Backend starting with configuration:');
console.log(`- WhatsApp ID: ${WHATSAPP_PHONE_NUMBER_ID ? 'Loaded' : 'Missing'}`);
console.log(`- CF Account ID: ${CLOUDFLARE_ACCOUNT_ID ? 'Loaded' : 'Missing'}`);
console.log(`- VPS URL: ${VPS_URL}`);
/**
 * Send a text message back to the student via the WhatsApp Cloud API
 */
async function sendWhatsAppMessage(to, text) {
    if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
        console.error('WhatsApp API credentials are not configured. Cannot send message to:', to);
        return;
    }
    const url = `https://graph.facebook.com/v17.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
    try {
        await axios_1.default.post(url, {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: to,
            type: 'text',
            text: { body: text }
        }, {
            headers: {
                Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        console.log(`[WhatsApp] Message successfully sent to ${to}`);
    }
    catch (error) {
        console.error(`[WhatsApp Error] Failed to send message to ${to}:`, error?.response?.data || error.message);
    }
}
/**
 * Classifies whether the incoming query is an automation task or a text query.
 * Keywords relate to browser login, file downloads, youtube, lms, drive, or session recovery like OTP.
 */
function isAutomationTask(messageText) {
    const lowercase = messageText.toLowerCase();
    const automationKeywords = [
        'lms',
        'login',
        'browser',
        'download',
        'youtube',
        'drive',
        'click',
        'otp',
        'verification',
        'password',
        'username',
        'scroll',
        'screenshot',
        'http://',
        'https://'
    ];
    return automationKeywords.some(keyword => lowercase.includes(keyword)) || lowercase.startsWith('/');
}
/**
 * Calls Cloudflare Workers AI Llama 3 Text Model to get study explanations or quiz answers
 */
async function queryLlama3Text(prompt) {
    if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
        return 'Cloudflare Workers AI credentials are not configured on the Vercel backend. Please check system configurations.';
    }
    const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/meta/llama-3-8b-instruct`;
    try {
        const response = await axios_1.default.post(url, {
            messages: [
                { role: 'system', content: 'You are a helpful AI Student Assistant. Provide concise, clear, and direct explanations for academic queries and Cisco quizzes.' },
                { role: 'user', content: prompt }
            ]
        }, {
            headers: {
                Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        if (response.data?.success && response.data?.result?.response) {
            return response.data.result.response;
        }
        throw new Error('Invalid response structure from Cloudflare Workers AI');
    }
    catch (error) {
        console.error('[Cloudflare AI Error]:', error?.response?.data || error.message);
        return 'Sorry, I encountered an error while processing your query using Cloudflare Workers AI. Please try again later.';
    }
}
// 1. WhatsApp Webhook Verification Endpoint (GET)
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode && token) {
        if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
            console.log('[Webhook Verified] Handshake successful!');
            return res.status(200).send(challenge);
        }
        console.warn('[Webhook verification failed] Token mismatch.');
        return res.sendStatus(403);
    }
    return res.sendStatus(400);
});
// 2. Incoming Webhook Message Processing (POST)
app.post('/webhook', async (req, res) => {
    const body = req.body;
    // Let Meta know we received the event immediately to prevent retries
    res.status(200).json({ status: 'ok' });
    // Parse official WhatsApp Cloud API schema
    if (body.object === 'whatsapp_business_account') {
        const entry = body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        const message = value?.messages?.[0];
        if (!message) {
            // Could be status updates (sent, delivered, read) - ignore
            return;
        }
        const studentPhone = message.from;
        const messageId = message.id;
        const studentName = value?.contacts?.[0]?.profile?.name || 'Student';
        // We support text messages or button replies
        let messageText = '';
        if (message.type === 'text') {
            messageText = message.text.body || '';
        }
        else if (message.type === 'interactive' && message.interactive?.button_reply) {
            messageText = message.interactive.button_reply.title || '';
        }
        else {
            console.log(`[Webhook] Unhandled message type "${message.type}" from ${studentPhone}`);
            return;
        }
        messageText = messageText.trim();
        console.log(`[Incoming Message] From ${studentPhone} (${studentName}): "${messageText}"`);
        // Handle Unlock Premium command
        if (messageText.startsWith('/unlock')) {
            const parts = messageText.split(/\s+/);
            const token = parts[1];
            if (token === ADMIN_TOKEN) {
                if (!authenticatedStudents.includes(studentPhone)) {
                    authenticatedStudents.push(studentPhone);
                }
                console.log(`[Auth Success] Student ${studentPhone} unlocked heavy automation.`);
                await sendWhatsAppMessage(studentPhone, 'Heavy Automation Access Granted! Please send your LMS configuration or download request within the next 5 minutes.');
            }
            else {
                console.log(`[Auth Fail] Invalid unlock token sent by ${studentPhone}: "${token}"`);
                await sendWhatsAppMessage(studentPhone, 'Invalid Access Token. Please provide the correct Admin Secret Key to unlock heavy automation.');
            }
            return;
        }
        // Guard Rails: Check if request is a heavy automation task
        if (isAutomationTask(messageText)) {
            const isAuth = authenticatedStudents.includes(studentPhone);
            if (!isAuth) {
                console.log(`[Gated Block] Blocked heavy task from unauthenticated student ${studentPhone}`);
                await sendWhatsAppMessage(studentPhone, 'Access Denied. This heavy automation feature requires an Admin Secret Key. Please contact the Admin to get your access token.');
                return;
            }
            // If authorized, forward to Oracle VPS Component
            console.log(`[Task Forward] Forwarding heavy task from ${studentPhone} to VPS...`);
            try {
                const response = await axios_1.default.post(`${VPS_URL}/automation`, {
                    studentPhone,
                    studentName,
                    messageText,
                    messageId
                }, {
                    headers: {
                        'X-API-SECRET-KEY': X_API_SECRET_KEY,
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000 // VPS pushes to queue, responds immediately
                });
                console.log(`[Task Forward Success] VPS responded:`, response.data);
            }
            catch (error) {
                console.error(`[VPS Forward Error] Failed to delegate task:`, error.message);
                await sendWhatsAppMessage(studentPhone, 'Error forwarding your task to the automation core. Please try again shortly.');
            }
        }
        else {
            // Bypasses VPS, handles instantly via Cloudflare Worker AI Llama 3
            console.log(`[Fast Text Route] Processing study query via Cloudflare AI...`);
            const aiReply = await queryLlama3Text(messageText);
            await sendWhatsAppMessage(studentPhone, aiReply);
        }
    }
});
// 3. VPS Callback Endpoint to De-authorize Student (POST)
app.post('/callback/deauth', (req, res) => {
    const secretHeader = req.headers['x-api-secret-key'];
    if (secretHeader !== X_API_SECRET_KEY) {
        console.warn('[Deauth Callback Rejected] Invalid secret header from caller.');
        return res.status(401).json({ error: 'Unauthorized callback' });
    }
    const { studentPhone } = req.body;
    if (!studentPhone) {
        return res.status(400).json({ error: 'Missing studentPhone in payload' });
    }
    const index = authenticatedStudents.indexOf(studentPhone);
    if (index !== -1) {
        authenticatedStudents.splice(index, 1);
        console.log(`[Deauth Success] Removed ${studentPhone} from authenticated list.`);
        return res.status(200).json({ success: true, message: `Student ${studentPhone} de-authenticated successfully.` });
    }
    console.log(`[Deauth Warning] Student ${studentPhone} was not in authenticated list.`);
    return res.status(200).json({ success: true, message: 'Student was not active.' });
});
// Port configuration (Vercel uses process.env.PORT)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[Vercel Webhook Backend] Listening on port ${PORT}`);
});
