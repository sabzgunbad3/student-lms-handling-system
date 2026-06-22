"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const puppeteer_1 = __importDefault(require("puppeteer"));
const axios_1 = __importDefault(require("axios"));
const form_data_1 = __importDefault(require("form-data"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const app = (0, express_1.default)();
app.use(express_1.default.json());
// API Configuration
const PORT = process.env.VPS_PORT || 8080;
const X_API_SECRET_KEY = process.env.X_API_SECRET_KEY || 'default-vps-secret-key-9988';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const VERCEL_URL = process.env.VERCEL_URL || 'http://localhost:3000';
// Global Puppeteer instance
let globalBrowser = null;
// In-Memory state tracking (No DB)
const activeSessions = new Map();
const taskQueue = [];
let concurrentWorkers = 0;
const MAX_CONCURRENT_WORKERS = 3;
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
/**
 * Initialize single global browser on server startup
 */
async function initBrowser() {
    try {
        globalBrowser = await puppeteer_1.default.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--no-first-run',
                '--no-zygote',
                '--single-process'
            ]
        });
        console.log('[Puppeteer] Launched global browser instance.');
    }
    catch (error) {
        console.error('[Puppeteer Error] Failed to launch global browser:', error);
        process.exit(1);
    }
}
// Start browser initialization
initBrowser();
/**
 * Sends a WhatsApp text message to the student
 */
async function sendWhatsAppMessage(to, text) {
    if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
        console.error('[WhatsApp] Missing credentials. Cannot send:', text);
        return;
    }
    const url = `https://graph.facebook.com/v17.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
    try {
        await axios_1.default.post(url, {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'text',
            text: { body: text }
        }, {
            headers: {
                Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
    }
    catch (error) {
        console.error(`[WhatsApp Error] Failed to send message to ${to}:`, error?.response?.data || error.message);
    }
}
/**
 * Pings the Vercel callback endpoint to remove premium access for the student
 */
async function deauthorizeOnVercel(studentPhone) {
    try {
        const url = `${VERCEL_URL}/callback/deauth`;
        console.log(`[Callback Vercel] De-authorizing student ${studentPhone} on Vercel at ${url}`);
        await axios_1.default.post(url, { studentPhone }, {
            headers: {
                'X-API-SECRET-KEY': X_API_SECRET_KEY,
                'Content-Type': 'application/json'
            },
            timeout: 5000
        });
    }
    catch (error) {
        console.error(`[Vercel Callback Error] Failed to de-authorize ${studentPhone}:`, error.message);
    }
}
/**
 * Closes the browser context and deletes the session in memory.
 */
async function closeSession(studentPhone) {
    const session = activeSessions.get(studentPhone);
    if (session) {
        if (session.inactivityTimer) {
            clearTimeout(session.inactivityTimer);
        }
        try {
            await session.context.close();
            console.log(`[Session Closed] Closed context for student ${studentPhone}`);
        }
        catch (e) {
            console.error(`[Session Close Error] Error closing context for ${studentPhone}:`, e.message);
        }
        activeSessions.delete(studentPhone);
    }
    // Remove premium authorization on Vercel
    await deauthorizeOnVercel(studentPhone);
}
/**
 * Configures the 5-minute inactivity timeout.
 */
function resetInactivityTimer(session) {
    if (session.inactivityTimer) {
        clearTimeout(session.inactivityTimer);
    }
    session.inactivityTimer = setTimeout(async () => {
        console.log(`[Inactivity Timeout] Session for ${session.studentPhone} timed out (5 mins).`);
        try {
            await sendWhatsAppMessage(session.studentPhone, 'Your automation session has timed out due to 5 minutes of inactivity. For security, your session has been closed.');
        }
        catch (e) {
            console.error('Failed to send timeout notification:', e);
        }
        await closeSession(session.studentPhone);
    }, INACTIVITY_TIMEOUT_MS);
}
/**
 * Calls Cloudflare Llama 3.2 Vision API with screen visual data to retrieve the next browser actions.
 */
async function getNextActionFromVision(screenshotBuffer, goal, history) {
    if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
        throw new Error('Cloudflare Workers AI credentials missing on VPS.');
    }
    const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/meta/llama-3.2-11b-vision-instruct`;
    const systemInstructions = `You are a visual web automation assistant. You are looking at a screenshot of a browser viewport sized exactly 1280x800.\n` +
        `Your goal is: "${goal}".\n` +
        `We have already executed these steps: ${JSON.stringify(history)}.\n` +
        `Analyze the screenshot and output the next step. You must respond ONLY with a raw JSON object containing:\n` +
        `{\n` +
        `  "action": "click" | "fill" | "scroll" | "wait_for_otp" | "done" | "error",\n` +
        `  "selector": "CSS selector to use if reliable, or null",\n` +
        `  "coordinates": { "x": number, "y": number } (Absolute pixel coordinates for the action. Only provide this if selector is null, or as fallback. Viewport size is 1280x800),\n` +
        `  "text": "text to type if action is fill, or null",\n` +
        `  "reason": "short explanation of this action"\n` +
        `}\n` +
        `Do not include markdown tags, code blocks, or triple backticks. Respond only with valid JSON.`;
    // Cloudflare Workers AI expects the image as an array of bytes
    const response = await axios_1.default.post(url, {
        image: Array.from(screenshotBuffer),
        prompt: systemInstructions,
        max_tokens: 512
    }, {
        headers: {
            Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
            'Content-Type': 'application/json'
        }
    });
    if (response.data?.success && response.data?.result?.response) {
        const rawResponse = response.data.result.response.trim();
        // Strip markdown JSON backticks if they are returned by mistake
        const cleanJson = rawResponse.replace(/^```json/, '').replace(/```$/, '').trim();
        try {
            return JSON.parse(cleanJson);
        }
        catch (e) {
            console.error('[Vision API Parsing Error] Raw response was:', rawResponse);
            throw new Error(`Failed to parse AI action response: ${e}`);
        }
    }
    throw new Error('Cloudflare Workers AI returned invalid structure or error.');
}
/**
 * Runs the visual AI execution loop on the browser context page.
 */
async function runVisualAutomationLoop(session, goal) {
    let step = 0;
    const maxSteps = 12;
    while (step < maxSteps) {
        step++;
        console.log(`[Visual Loop] Session ${session.studentPhone}: Step ${step}/${maxSteps}`);
        // Wait a brief moment for dynamic elements to settle
        await new Promise(r => setTimeout(r, 2000));
        // Capture screenshot of viewport
        const screenshot = await session.page.screenshot({ type: 'png' });
        let aiResult;
        try {
            aiResult = await getNextActionFromVision(screenshot, goal, session.stepsHistory);
            console.log(`[Visual AI Decision] Action: ${aiResult.action}, Reason: ${aiResult.reason}`);
        }
        catch (error) {
            console.error('[Visual AI Loop Error] Cloudflare API failed:', error.message);
            await sendWhatsAppMessage(session.studentPhone, `I hit an error communicating with the Visual AI: ${error.message}`);
            await closeSession(session.studentPhone);
            return;
        }
        session.stepsHistory.push(`${aiResult.action}: ${aiResult.reason}`);
        if (aiResult.action === 'done') {
            await sendWhatsAppMessage(session.studentPhone, `Task completed successfully! Steps history:\n${session.stepsHistory.join('\n')}`);
            await closeSession(session.studentPhone);
            return;
        }
        if (aiResult.action === 'error') {
            await sendWhatsAppMessage(session.studentPhone, `Automation failed during step: ${aiResult.reason}`);
            await closeSession(session.studentPhone);
            return;
        }
        if (aiResult.action === 'wait_for_otp') {
            session.status = 'WAITING_FOR_OTP';
            session.otpSelector = aiResult.selector || undefined;
            session.otpCoordinates = aiResult.coordinates || undefined;
            resetInactivityTimer(session); // Start 5 mins timeout waiting for student input
            await sendWhatsAppMessage(session.studentPhone, `Secure Verification Needed: ${aiResult.reason || 'Please provide your OTP code.'} Reply with the OTP code within 5 minutes.`);
            return; // Suspend loop until student replies with OTP
        }
        // Execute actions
        try {
            if (aiResult.action === 'click') {
                if (aiResult.selector) {
                    await session.page.click(aiResult.selector);
                }
                else if (aiResult.coordinates) {
                    const { x, y } = aiResult.coordinates;
                    await session.page.mouse.click(x, y);
                }
                else {
                    throw new Error('No selector or coordinates provided for click action');
                }
            }
            else if (aiResult.action === 'fill') {
                const textToFill = aiResult.text || '';
                if (aiResult.selector) {
                    await session.page.click(aiResult.selector, { clickCount: 3 }); // Clear input field
                    await session.page.keyboard.press('Backspace');
                    await session.page.type(aiResult.selector, textToFill);
                }
                else if (aiResult.coordinates) {
                    const { x, y } = aiResult.coordinates;
                    await session.page.mouse.click(x, y, { clickCount: 3 });
                    await session.page.keyboard.press('Backspace');
                    await session.page.keyboard.type(textToFill); // Type into active focus
                }
                else {
                    throw new Error('No selector or coordinates provided for fill action');
                }
            }
            else if (aiResult.action === 'scroll') {
                await session.page.evaluate(() => {
                    window.scrollBy(0, 400);
                });
            }
        }
        catch (actionErr) {
            console.warn(`[Execution Warning] Action failed: ${actionErr.message}. Trying coordinate fallback...`);
            if (aiResult.coordinates) {
                try {
                    const { x, y } = aiResult.coordinates;
                    await session.page.mouse.click(x, y);
                }
                catch (fbErr) {
                    console.error(`[Execution Error] Fallback coordinate click failed: ${fbErr.message}`);
                }
            }
        }
    }
    // Loop finished without reaching 'done' or 'error'
    await sendWhatsAppMessage(session.studentPhone, 'Visual AI loop ended: maximum steps reached without resolving the goal.');
    await closeSession(session.studentPhone);
}
/**
 * Handle incoming student OTP inputs during visual loops
 */
async function resumeWithOTP(session, otpCode) {
    console.log(`[Resume with OTP] Injecting OTP "${otpCode}" for student ${session.studentPhone}`);
    session.status = 'PROCESSING';
    if (session.inactivityTimer) {
        clearTimeout(session.inactivityTimer);
    }
    try {
        if (session.otpSelector) {
            await session.page.click(session.otpSelector, { clickCount: 3 });
            await session.page.keyboard.press('Backspace');
            await session.page.type(session.otpSelector, otpCode);
        }
        else if (session.otpCoordinates) {
            const { x, y } = session.otpCoordinates;
            await session.page.mouse.click(x, y, { clickCount: 3 });
            await session.page.keyboard.press('Backspace');
            await session.page.keyboard.type(otpCode);
        }
        else {
            // Type generally
            await session.page.keyboard.type(otpCode);
        }
        // Press enter key to submit after typing OTP
        await session.page.keyboard.press('Enter');
        session.stepsHistory.push(`student_otp: Provided OTP: ${otpCode}`);
        // Resume visual execution loop
        runVisualAutomationLoop(session, 'Submit OTP and complete LMS request');
    }
    catch (err) {
        console.error('[OTP Error] Failed to inject OTP:', err.message);
        await sendWhatsAppMessage(session.studentPhone, `Failed to input OTP code: ${err.message}`);
        await closeSession(session.studentPhone);
    }
}
/**
 * Streams files from Google Drive / YouTube to local disk chunks and uploads them.
 * Crucial details:
 * 1. Stream downloader writes chunks to local temporary disk path.
 * 2. Form-data uploads stream directly from disk to prevent full-buffer RAM expansion.
 */
async function handleMemorySafeDownloadAndUpload(studentPhone, sourceUrl) {
    const tempDir = path_1.default.join(__dirname, 'temp_downloads');
    if (!fs_1.default.existsSync(tempDir)) {
        fs_1.default.mkdirSync(tempDir, { recursive: true });
    }
    const fileId = `dl_${Date.now()}`;
    const tempFilePath = path_1.default.join(tempDir, `${fileId}.bin`);
    await sendWhatsAppMessage(studentPhone, 'Starting file/media download... (Streaming to VPS storage)');
    try {
        console.log(`[Stream Downloader] Fetching stream from URL: ${sourceUrl}`);
        const response = await (0, axios_1.default)({
            method: 'GET',
            url: sourceUrl,
            responseType: 'stream',
            timeout: 60000 // 1 minute max for download start
        });
        const writer = fs_1.default.createWriteStream(tempFilePath);
        // Pipe response stream to file chunks
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
            writer.on('finish', () => resolve());
            writer.on('error', err => reject(err));
        });
        console.log(`[Stream Downloader] Download complete. File saved to ${tempFilePath}`);
        await sendWhatsAppMessage(studentPhone, 'Download complete. Syncing file to WhatsApp Cloud...');
        // Upload to WhatsApp Media Endpoint
        if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
            throw new Error('WhatsApp variables missing.');
        }
        const uploadUrl = `https://graph.facebook.com/v17.0/${WHATSAPP_PHONE_NUMBER_ID}/media`;
        const form = new form_data_1.default();
        form.append('messaging_product', 'whatsapp');
        form.append('type', 'document');
        // Read stream directly from disk chunks to avoid RAM expansion
        form.append('file', fs_1.default.createReadStream(tempFilePath), {
            filename: `student_file_${Date.now()}.pdf`,
            contentType: 'application/pdf'
        });
        console.log(`[WhatsApp Media] Uploading stream form-data to WhatsApp...`);
        const uploadRes = await axios_1.default.post(uploadUrl, form, {
            headers: {
                Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                ...form.getHeaders()
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        const mediaId = uploadRes.data?.id;
        if (!mediaId) {
            throw new Error('WhatsApp Media API failed to return media ID');
        }
        console.log(`[WhatsApp Media] Uploaded. Media ID: ${mediaId}. Sending to user.`);
        // Send the media document to student
        const msgUrl = `https://graph.facebook.com/v17.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
        await axios_1.default.post(msgUrl, {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: studentPhone,
            type: 'document',
            document: {
                id: mediaId,
                filename: 'requested_file.pdf'
            }
        }, {
            headers: {
                Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        console.log(`[Stream Downloader] Successfully sent media file to ${studentPhone}`);
        await sendWhatsAppMessage(studentPhone, 'Your requested file has been successfully fetched and delivered!');
    }
    catch (error) {
        console.error('[Downloader Error]:', error?.response?.data || error.message);
        await sendWhatsAppMessage(studentPhone, `Failed to stream download your request: ${error.message}`);
    }
    finally {
        // Delete local temporary file
        if (fs_1.default.existsSync(tempFilePath)) {
            try {
                fs_1.default.unlinkSync(tempFilePath);
                console.log(`[Temp File Cleaned] Removed ${tempFilePath}`);
            }
            catch (err) {
                console.error('Failed to clean temp file:', err.message);
            }
        }
        // De-authorize on completion
        await deauthorizeOnVercel(studentPhone);
    }
}
/**
 * Main worker callback to process tasks from the FIFO queue
 */
async function processTask(item) {
    const { studentPhone, studentName, messageText } = item;
    console.log(`[Queue Task Run] Processing task for ${studentPhone}: "${messageText}"`);
    // Check if session already exists (e.g. OTP reply or concurrent request)
    let session = activeSessions.get(studentPhone);
    if (session) {
        if (session.status === 'WAITING_FOR_OTP') {
            await resumeWithOTP(session, messageText);
        }
        else {
            await sendWhatsAppMessage(studentPhone, 'Please wait, I am already processing your current request.');
        }
        return;
    }
    // Direct media download checks
    if (messageText.includes('/download') || messageText.includes('drive.google.com') || messageText.includes('youtube.com') || messageText.includes('youtu.be')) {
        // Execute streaming download task directly
        await handleMemorySafeDownloadAndUpload(studentPhone, messageText);
        return;
    }
    // Otherwise, run full browser Puppeteer automation flow
    if (!globalBrowser) {
        await sendWhatsAppMessage(studentPhone, 'System configuration error: Headless browser is offline.');
        await deauthorizeOnVercel(studentPhone);
        return;
    }
    try {
        console.log(`[Session Launch] Creating isolated BrowserContext for ${studentPhone}`);
        const context = await globalBrowser.createBrowserContext();
        const page = await context.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        // Set custom timeout to prevent RAM locking
        page.setDefaultNavigationTimeout(30000);
        page.setDefaultTimeout(15000);
        const newSession = {
            context,
            page,
            studentPhone,
            studentName,
            status: 'PROCESSING',
            stepsHistory: [],
            inactivityTimer: null
        };
        activeSessions.set(studentPhone, newSession);
        resetInactivityTimer(newSession);
        // Initial page navigate
        console.log(`[Navigation] Navigating to initial blank slate.`);
        await page.goto('about:blank');
        // Run the visual AI loop with the student's request
        await runVisualAutomationLoop(newSession, messageText);
    }
    catch (err) {
        console.error(`[Puppeteer Context Error]:`, err.message);
        await sendWhatsAppMessage(studentPhone, `Failed to initialize automation task context: ${err.message}`);
        await closeSession(studentPhone);
    }
}
/**
 * Queue processing monitor
 */
function checkQueue() {
    if (taskQueue.length === 0)
        return;
    if (concurrentWorkers >= MAX_CONCURRENT_WORKERS) {
        console.log(`[Queue Monitor] Concurrency limit of ${MAX_CONCURRENT_WORKERS} reached. Waiting...`);
        return;
    }
    const nextTask = taskQueue.shift();
    if (nextTask) {
        concurrentWorkers++;
        console.log(`[Queue Monitor] Starting task. Active Workers: ${concurrentWorkers}/${MAX_CONCURRENT_WORKERS}`);
        processTask(nextTask)
            .catch(err => {
            console.error(`[Queue Worker Error]:`, err);
        })
            .finally(() => {
            concurrentWorkers--;
            console.log(`[Queue Monitor] Completed task. Active Workers: ${concurrentWorkers}/${MAX_CONCURRENT_WORKERS}`);
            checkQueue();
        });
    }
}
// 4. Endpoint to receive forwarded automation tasks from Vercel
app.post('/automation', (req, res) => {
    const secretHeader = req.headers['x-api-secret-key'];
    if (secretHeader !== X_API_SECRET_KEY) {
        console.warn('[Authentication Fail] Invalid X-API-SECRET-KEY header on VPS request.');
        return res.status(401).json({ error: 'Unauthorized VPS request' });
    }
    const { studentPhone, studentName, messageText, messageId } = req.body;
    if (!studentPhone || !messageText) {
        return res.status(400).json({ error: 'Missing studentPhone or messageText in payload' });
    }
    console.log(`[VPS Task Enqueued] Queue length: ${taskQueue.length + 1}. Request from ${studentPhone}`);
    // Push into FIFO queue
    taskQueue.push({ studentPhone, studentName, messageText, messageId });
    // Respond immediately so Vercel does not timeout
    res.status(200).json({ status: 'queued', message: 'Task added to processing queue' });
    // Trigger processing
    checkQueue();
});
// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        browserOnline: !!globalBrowser,
        activeSessions: activeSessions.size,
        queueSize: taskQueue.length,
        activeWorkers: concurrentWorkers
    });
});
app.listen(PORT, () => {
    console.log(`[VPS Automation Core] Persistent server running on port ${PORT}`);
});
